// A model of the archive on disk and of the store's write protocol, in its commit order, for generated crash
// tests. Every write is a primitive step that a crash can stop before, or tear part way. The model also keeps its own
// record of what was committed, which the tests compare against after recovery; the planner never sees it.

import type { SettledExchange } from "../src/exchange.ts";
import type {
  ByteCount,
  EpochMs,
  ExchangeId,
  LogSegmentId,
  PackId,
  RunId,
  Site,
} from "../src/ids.ts";
import {
  bodyFilePath,
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  packId,
  packPath,
  parseArchiveName,
  partPath,
  siteDirName,
} from "../src/layout.ts";
import {
  decodeLine,
  decodeSummary,
  encodeLine,
  encodeSummary,
  splitLines,
  summarize,
  type LogLine,
} from "../src/log.ts";
import type { DirSnapshot, ReconcileStep, SnapshotEntry } from "../src/reconcile.ts";
import { DEFAULT_USER_SETTINGS, parseStoredSettings } from "../src/settings.ts";
import { request, response, stop } from "./fixtures.ts";
import type { random } from "./random.ts";

type Random = ReturnType<typeof random>;
const join = (path: readonly string[]) => path.join("/");
const EXPORT_FOLDER = "/home/u/Downloads";

export interface Disk {
  readonly files: Map<string, string>;
  /** `sites/<dir>`: a site directory can outlive its files when an exclusion stops part way. */
  readonly siteDirs: Set<string>;
  /** Export files, outside the archive. */
  readonly exports: Set<string>;
  /** The export journal's started and unfinished jobs, by their .har.part path. */
  readonly journal: Set<string>;
  /** Someone else's files at a path the journal named: a part replaced while its export ran. */
  readonly theirs: Set<string>;
}

/** What the model knows was committed. The recovery under test never reads it. */
export interface Committed {
  /** Every line whose append finished, by segment path, in order. */
  readonly lines: Map<string, string[]>;
  /** Body files a committed line names, with the segment that names them. */
  readonly namedBodies: Map<string, string>;
  /** Files retention deleted on purpose: their lines and bodies are no longer expected. */
  readonly retained: Set<string>;
  /** Export parts whose journal line landed. A part created and killed before its line is not provably the export's. */
  readonly journaled: Set<string>;
  /** Every file someone else put at a journaled path. None may ever be deleted. */
  readonly theirs: Set<string>;
}

export class Crash extends Error {}

/** A crash stops the run before step `at`; with `tear`, that step's write lands part way first. */
export class Steps {
  taken = 0;
  private readonly at: number;
  private readonly tear: number | null;
  constructor(at: number, tear: number | null) {
    this.at = at;
    this.tear = tear;
  }
  run(apply: () => void, torn?: (fraction: number) => void): void {
    if (this.taken === this.at) {
      if (this.tear !== null && torn !== undefined) torn(this.tear);
      throw new Crash("crash");
    }
    this.taken += 1;
    apply();
  }
}

export const emptyDisk = (): Disk => ({
  files: new Map(),
  siteDirs: new Set(),
  exports: new Set(),
  journal: new Set(),
  theirs: new Set(),
});
export const emptyCommitted = (): Committed => ({
  lines: new Map(),
  namedBodies: new Map(),
  retained: new Set(),
  journaled: new Set(),
  theirs: new Set(),
});
export const cloneDisk = (disk: Disk): Disk => ({
  files: new Map(disk.files),
  siteDirs: new Set(disk.siteDirs),
  exports: new Set(disk.exports),
  journal: new Set(disk.journal),
  theirs: new Set(disk.theirs),
});
export const cloneCommitted = (committed: Committed): Committed => ({
  lines: new Map([...committed.lines].map(([path, lines]) => [path, [...lines]])),
  namedBodies: new Map(committed.namedBodies),
  retained: new Set(committed.retained),
  journaled: new Set(committed.journaled),
  theirs: new Set(committed.theirs),
});

/** A directory's files, in an order the file system chooses: an exclusion may delete a log before or after its summary. */
const filesUnder = (disk: Disk, dir: string, r: Random): readonly string[] =>
  r.shuffle([...disk.files.keys()].filter((p) => p.startsWith(`${dir}/`)));

const settingsText = (excluded: readonly Site[]) =>
  JSON.stringify({
    user: { ...DEFAULT_USER_SETTINGS, excludedSites: excluded },
    exportFolder: { kind: "downloads" },
  });
export const excludedOn = (disk: Disk): readonly Site[] => {
  const raw = disk.files.get(LAYOUT.settings);
  return raw === undefined ? [] : (parseStoredSettings(JSON.parse(raw))?.user.excludedSites ?? []);
};

interface Tee {
  readonly id: ExchangeId;
  readonly site: Site;
  readonly bytes: number;
}

/** One run of the store: its open segment and pack per site, its live tees, and its exclusion set. */
export class Run {
  private channel = 0;
  private readonly segmentSeq = new Map<Site, number>();
  private readonly packOffset = new Map<Site, number>();
  readonly tees: Tee[] = [];
  readonly excluded: Set<Site>;
  readonly run: RunId;
  private readonly disk: Disk;
  private readonly committed: Committed;
  private readonly steps: Steps;

  constructor(run: RunId, disk: Disk, committed: Committed, steps: Steps) {
    this.run = run;
    this.disk = disk;
    this.committed = committed;
    this.steps = steps;
    this.excluded = new Set(excludedOn(disk));
  }

  private segment(site: Site): LogSegmentId {
    return logSegmentId(site, this.run, this.segmentSeq.get(site) ?? 0);
  }
  private pack(site: Site): PackId {
    return packId(site, this.run, this.segmentSeq.get(site) ?? 0);
  }
  private ensureSiteDir(site: Site): void {
    this.disk.siteDirs.add(join([LAYOUT.sitesDir, siteDirName(site)]));
  }

  private appendLine(site: Site, exchange: SettledExchange, names: string | null): void {
    const path = join(logSegmentPath(this.segment(site)));
    const line = encodeLine({ v: 2, exchange });
    const append = (text: string) =>
      this.disk.files.set(path, `${this.disk.files.get(path) ?? ""}${text}`);
    this.steps.run(
      () => {
        this.ensureSiteDir(site);
        append(line);
        this.committed.lines.set(path, [...(this.committed.lines.get(path) ?? []), line]);
        if (names !== null) this.committed.namedBodies.set(names, path);
      },
      (fraction) => {
        this.ensureSiteDir(site);
        append(line.slice(0, Math.floor(fraction * (line.length - 1))));
      },
    );
  }

  private exchange(
    id: ExchangeId,
    site: Site,
    body:
      | SettledExchange["kind"]
      | { readonly at: "pack"; readonly offset: number; readonly length: number }
      | { readonly at: "file"; readonly length: number },
  ): SettledExchange {
    const req = {
      ...request,
      id,
      topSite: site,
      startedAt: (request.startedAt + this.channel * 1000) as EpochMs,
    };
    if (body === "unanswered")
      return { kind: "unanswered", request: req, stop, upload: { kind: "none" } };
    if (body === "abandoned")
      return {
        kind: "abandoned",
        request: req,
        response,
        reason: "browser-closed",
        body: { kind: "incomplete" },
        upload: { kind: "none" },
      };
    if (body === "answered")
      return {
        kind: "answered",
        request: req,
        response,
        stop,
        route: "no-body",
        body: { kind: "empty" },
        upload: { kind: "none" },
      };
    const at =
      body.at === "pack"
        ? {
            kind: "pack" as const,
            pack: this.pack(site),
            offset: body.offset,
            length: body.length as ByteCount,
          }
        : { kind: "file" as const, site, id, length: body.length as ByteCount };
    return {
      kind: "answered",
      request: req,
      response,
      stop,
      route: "small",
      body: { kind: "stored", at, encoding: null, check: "length-matched" },
      upload: { kind: "none" },
    };
  }

  private nextId(): ExchangeId {
    this.channel += 1;
    return `${this.run}.${this.channel}` as ExchangeId;
  }

  /** A file tee starts: its part in incoming/, outside every site directory. */
  startTee(site: Site, bytes: number): void {
    const id = this.nextId();
    const path = join(partPath(id));
    this.steps.run(() => this.disk.files.set(path, "x".repeat(bytes)));
    this.tees.push({ id, site, bytes });
  }

  /** The tee closed: rename the part into bodies/, then the line. An excluded site's part is deleted instead. */
  finishTee(r: Random): void {
    const tee = this.tees.splice(r.int(this.tees.length), 1)[0];
    if (tee === undefined) return;
    const part = join(partPath(tee.id));
    if (this.excluded.has(tee.site)) {
      this.steps.run(() => this.disk.files.delete(part));
      return;
    }
    const body = join(bodyFilePath(tee.site, tee.id));
    this.steps.run(() => {
      this.ensureSiteDir(tee.site);
      this.disk.files.set(body, this.disk.files.get(part) ?? "");
      this.disk.files.delete(part);
    });
    this.appendLine(
      tee.site,
      this.exchange(tee.id, tee.site, { at: "file", length: tee.bytes }),
      body,
    );
  }

  /** A memory body: the pack append resolves, then the line that addresses it. */
  memoryBody(site: Site, bytes: number): void {
    const id = this.nextId();
    const path = join(packPath(this.pack(site)));
    const offset = this.packOffset.get(site) ?? 0;
    this.steps.run(
      () => {
        this.ensureSiteDir(site);
        this.disk.files.set(path, `${this.disk.files.get(path) ?? ""}${"b".repeat(bytes)}`);
      },
      (fraction) => {
        this.ensureSiteDir(site);
        this.disk.files.set(
          path,
          `${this.disk.files.get(path) ?? ""}${"b".repeat(Math.floor(fraction * bytes))}`,
        );
      },
    );
    this.packOffset.set(site, offset + bytes);
    this.appendLine(site, this.exchange(id, site, { at: "pack", offset, length: bytes }), null);
  }

  plainLine(site: Site, kind: "answered" | "unanswered"): void {
    this.appendLine(site, this.exchange(this.nextId(), site, kind), null);
  }

  /** Seal: the summary through a .tmp and a rename; later lines go to the next segment and pack. */
  seal(site: Site): void {
    const segment = this.segment(site);
    const path = join(logSegmentPath(segment));
    const text = this.disk.files.get(path);
    if (text === undefined) return;
    const summary = encodeSummary(
      summarize(segment, wholeLines(text).decoded, text.length as ByteCount),
    );
    const target = join(logSummaryPath(segment));
    const tmp = `${target}${LAYOUT.tmpSuffix}`;
    this.steps.run(
      () => this.disk.files.set(tmp, summary),
      (fraction) =>
        this.disk.files.set(tmp, summary.slice(0, Math.floor(fraction * summary.length))),
    );
    this.steps.run(() => {
      this.disk.files.set(target, summary);
      this.disk.files.delete(tmp);
    });
    this.segmentSeq.set(site, (this.segmentSeq.get(site) ?? 0) + 1);
    this.packOffset.set(site, 0);
  }

  private writeSettings(excluded: readonly Site[]): void {
    const text = settingsText(excluded);
    const tmp = `${LAYOUT.settings}${LAYOUT.tmpSuffix}`;
    this.steps.run(
      () => this.disk.files.set(tmp, text),
      (fraction) => this.disk.files.set(tmp, text.slice(0, Math.floor(fraction * text.length))),
    );
    this.steps.run(() => {
      this.disk.files.set(LAYOUT.settings, text);
      this.disk.files.delete(tmp);
    });
  }

  touchSettings(): void {
    this.writeSettings([...this.excluded]);
  }

  /** Settings first, so the gate stops new captures; then the site's directory, file by file. */
  exclude(site: Site, r: Random): void {
    this.writeSettings([...this.excluded, site]);
    this.excluded.add(site);
    const dir = join([LAYOUT.sitesDir, siteDirName(site)]);
    for (const path of filesUnder(this.disk, dir, r))
      this.steps.run(() => this.disk.files.delete(path));
    this.steps.run(() => this.disk.siteDirs.delete(dir));
  }

  /**
   * The export journal says started once the part exists with its first bytes, and finished after the rename. With
   * `replaced`, someone puts their own file at the part's path mid-export: the export leaves it and ends the line.
   */
  exportFile(replaced: boolean): void {
    const name = `${EXPORT_FOLDER}/export-${this.run}-${this.nextId()}.har`;
    const part = `${name}.part`;
    this.steps.run(() => this.disk.exports.add(part));
    this.steps.run(() => {
      this.disk.journal.add(part);
      this.committed.journaled.add(part);
    });
    if (replaced) {
      this.steps.run(() => {
        this.disk.exports.delete(part);
        this.disk.theirs.add(part);
        this.committed.theirs.add(part);
      });
      this.steps.run(() => this.disk.journal.delete(part));
      return;
    }
    this.steps.run(() => {
      this.disk.exports.delete(part);
      this.disk.exports.add(name);
    });
    this.steps.run(() => this.disk.journal.delete(part));
  }

  /** Retention deletes one whole sealed file: a sealed segment with its summary, an old pack, or a body file. */
  retain(r: Random): void {
    const open = new Set(
      [...this.segmentSeq.keys(), ...this.packOffset.keys()].flatMap((s) => [
        join(logSegmentPath(this.segment(s))),
        join(packPath(this.pack(s))),
      ]),
    );
    const candidates = [...this.disk.files.keys()].filter((p) => {
      const name = parseArchiveName(p.split("/"));
      if (name === null || open.has(p)) return false;
      if (name.kind === "log") return this.disk.files.has(join(logSummaryPath(name.segment)));
      return name.kind === "pack" || name.kind === "body";
    });
    if (candidates.length === 0) return;
    const path = r.pick(candidates);
    const name = parseArchiveName(path.split("/"));
    this.steps.run(() => {
      this.disk.files.delete(path);
      this.committed.retained.add(path);
    });
    if (name?.kind === "log")
      this.steps.run(() => this.disk.files.delete(join(logSummaryPath(name.segment))));
  }

  /** A clean quit: every live tee gets its abandoned line and leaves its part; every open segment is sealed. */
  quit(sites: readonly Site[]): void {
    for (const tee of this.tees.splice(0)) {
      if (!this.excluded.has(tee.site))
        this.appendLine(tee.site, this.exchange(tee.id, tee.site, "abandoned"), null);
    }
    for (const site of sites) if (!this.excluded.has(site)) this.seal(site);
  }
}

export function wholeLines(text: string): {
  readonly decoded: readonly LogLine[];
  readonly validBytes: number;
} {
  const { lines, carry } = splitLines("", text);
  return {
    decoded: lines.map(decodeLine).filter((l) => l !== null),
    validBytes: text.length - carry.length,
  };
}

/** What the store's startup scan builds: every parseable name, each log's whole lines, each summary's validity. */
export function snapshotOf(disk: Disk, current: RunId): DirSnapshot {
  const entries: SnapshotEntry[] = [];
  for (const dir of disk.siteDirs) {
    const name = parseArchiveName(dir.split("/"));
    if (name?.kind === "site-dir") entries.push({ path: dir, name });
  }
  for (const [path, text] of disk.files) {
    const name = parseArchiveName(path.split("/"));
    if (name === null) continue;
    if (name.kind === "log") {
      const { decoded, validBytes } = wholeLines(text);
      const namesBodies = decoded.flatMap((l) =>
        l.exchange.kind === "answered" &&
        l.exchange.body.kind === "stored" &&
        l.exchange.body.at.kind === "file"
          ? [l.exchange.body.at.id]
          : [],
      );
      entries.push({ path, name, bytes: text.length, validBytes, namesBodies });
    } else if (name.kind === "summary") {
      const log = disk.files.get(join(logSegmentPath(name.segment)));
      const valid = log !== undefined && decodeSummary(text, log.length as ByteCount) !== null;
      entries.push({ path, name, valid });
    } else entries.push({ path, name });
  }
  const unfinishedExports = [...disk.journal].map((path) => ({
    path,
    at: disk.exports.has(path)
      ? ("ours" as const)
      : disk.theirs.has(path)
        ? ("other" as const)
        : ("gone" as const),
  }));
  return { current, excluded: excludedOn(disk), entries, unfinishedExports };
}

/** The store's executor for each step, as primitive writes a crash can interrupt too. Unknown kinds do nothing. */
export function execute(disk: Disk, plan: readonly ReconcileStep[], steps: Steps, r: Random): void {
  for (const step of plan) {
    switch (step.kind) {
      case "delete-excluded-site": {
        const dir = join([LAYOUT.sitesDir, siteDirName(step.site)]);
        for (const path of filesUnder(disk, dir, r)) steps.run(() => disk.files.delete(path));
        steps.run(() => disk.siteDirs.delete(dir));
        break;
      }
      case "delete-part":
      case "delete-tmp":
      case "delete-orphan-body":
        steps.run(() => disk.files.delete(step.path));
        break;
      case "delete-invalid-summary":
        steps.run(() => disk.files.delete(join(logSummaryPath(step.segment))));
        break;
      case "truncate-log": {
        const path = join(logSegmentPath(step.segment));
        steps.run(() => disk.files.set(path, (disk.files.get(path) ?? "").slice(0, step.toBytes)));
        break;
      }
      case "delete-export-part":
        steps.run(() => {
          disk.exports.delete(step.path);
          disk.theirs.delete(step.path);
        });
        steps.run(() => disk.journal.delete(step.path));
        break;
      case "leave-export-part":
        steps.run(() => disk.journal.delete(step.path));
        break;
      case "summarize-log": {
        const text = disk.files.get(join(logSegmentPath(step.segment)));
        if (text === undefined) break;
        const summary = encodeSummary(
          summarize(step.segment, wholeLines(text).decoded, text.length as ByteCount),
        );
        const target = join(logSummaryPath(step.segment));
        steps.run(
          () => disk.files.set(`${target}${LAYOUT.tmpSuffix}`, summary),
          (fraction) =>
            disk.files.set(
              `${target}${LAYOUT.tmpSuffix}`,
              summary.slice(0, Math.floor(fraction * summary.length)),
            ),
        );
        steps.run(() => {
          disk.files.set(target, summary);
          disk.files.delete(`${target}${LAYOUT.tmpSuffix}`);
        });
        break;
      }
    }
  }
}
