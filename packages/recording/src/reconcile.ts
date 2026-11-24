// Startup recovery as a pure plan over a directory snapshot. Every step is derived from what is on disk, never from
// what the previous run meant to do, and every step removes the condition that triggers it, so a second plan over
// the result is empty. test/reconcile.test.ts checks that over the crash table and over generated crashes.

import type { ExchangeId, LogSegmentId, RunId, Site, SiteDir } from "./ids.ts";
import { logSummaryPath, siteDirName, type ArchiveName } from "./layout.ts";

type Named<K extends ArchiveName["kind"]> = Extract<ArchiveName, { readonly kind: K }>;

/** A parseable name on disk other than a log or a summary, as parseArchiveName read it. */
export interface FileEntry {
  readonly path: string;
  readonly name: Exclude<ArchiveName, Named<"log" | "summary">>;
}
/** A log carries what its whole lines say, so a segment cannot be listed apart from its file. */
export interface LogEntry {
  readonly path: string;
  readonly name: Named<"log">;
  readonly bytes: number;
  /** Bytes up to and including the last newline. Less than `bytes` when the last append was torn. */
  readonly validBytes: number;
  /** Body files named by the segment's whole lines. */
  readonly namesBodies: readonly ExchangeId[];
}
export interface SummaryEntry {
  readonly path: string;
  readonly name: Named<"summary">;
  /** decodeSummary succeeded and its `bytes` equals its log's current size; false when the log is gone. */
  readonly valid: boolean;
}
/**
 * Every site-scoped name carries its directory, and a file belongs to a site by that directory. Recovery never needs
 * the Site itself, which a cut directory name cannot give back.
 */
export type SnapshotEntry = FileEntry | LogEntry | SummaryEntry;

const isLog = (e: SnapshotEntry): e is LogEntry => e.name.kind === "log";
const isSummary = (e: SnapshotEntry): e is SummaryEntry => e.name.kind === "summary";

export interface DirSnapshot {
  readonly current: RunId;
  /** settings.excludedSites. The planner finds each one's directory with siteDirName. */
  readonly excluded: readonly Site[];
  /** Every parseable name. Unparseable names are absent and never touched. */
  readonly entries: readonly SnapshotEntry[];
  /** Unfinished export jobs from exports.jsonl. The path is the parent's; it never came from an extension page. */
  readonly unfinishedExports: readonly UnfinishedExport[];
}

/** A part the export journal says started and never ended, and what is at its path now. */
export interface UnfinishedExport {
  readonly path: string;
  /**
   * `ours`: a regular file, not a link, that still starts with the first bytes the export journaled, which carry its
   * random id. `other`: anything else. `gone`: nothing.
   */
  readonly at: "ours" | "other" | "gone";
}

export type ReconcileStep =
  | { readonly kind: "delete-excluded-site"; readonly site: Site }
  | { readonly kind: "delete-part"; readonly path: string }
  | { readonly kind: "delete-tmp"; readonly path: string }
  | { readonly kind: "delete-orphan-body"; readonly path: string }
  | { readonly kind: "delete-invalid-summary"; readonly segment: LogSegmentId }
  | { readonly kind: "truncate-log"; readonly segment: LogSegmentId; readonly toBytes: number }
  | { readonly kind: "delete-export-part"; readonly path: string }
  | { readonly kind: "leave-export-part"; readonly path: string }
  | { readonly kind: "summarize-log"; readonly segment: LogSegmentId };

const isOld = (snapshot: DirSnapshot, run: RunId | null): boolean =>
  run === null || run !== snapshot.current;
const dirOf = (name: ArchiveName): SiteDir | null => ("dir" in name ? name.dir : null);

/**
 * Each step kind and what triggers it, in the order a plan lists them. summarize-log is last, so a crash during
 * recovery reruns it; it is written through a .tmp and a rename.
 */
export const RECONCILE_STEPS: { readonly [K in ReconcileStep["kind"]]: string } = {
  "delete-excluded-site":
    "a site directory for a site in settings.excludedSites (an interrupted exclusion)",
  "delete-part": "an old run's .part: a tee that never closed, or closed before its rename",
  "delete-tmp": "an interrupted atomic write (settings, or a summary of an old run)",
  "delete-orphan-body": "an old run's body file that no whole line of its segments names",
  "delete-invalid-summary":
    "a summary that does not decode or no longer matches its segment's size",
  "truncate-log": "an old run's segment, without a valid summary, that ends mid-line",
  "delete-export-part":
    "a .har.part the export journal says was started and never finished, still holding that export's first bytes",
  "leave-export-part":
    "a path the export journal names where something else now is: not this add-on's file, so left and reported",
  "summarize-log": "an old run's segment without a valid summary",
};

/**
 * Files of `current` are never in the plan. Recovery runs first on the store's write chain, before this run writes.
 * Every other step skips an excluded site's directory: delete-excluded-site removes it whole.
 */
export function planReconcile(snapshot: DirSnapshot): readonly ReconcileStep[] {
  const gone = new Set(snapshot.excluded.map(siteDirName));
  const steps: ReconcileStep[] = [];
  const live = snapshot.entries.filter((e) => {
    const dir = dirOf(e.name);
    return dir === null || !gone.has(dir);
  });

  for (const site of snapshot.excluded) {
    const dir = siteDirName(site);
    if (snapshot.entries.some((e) => dirOf(e.name) === dir))
      steps.push({ kind: "delete-excluded-site", site });
  }
  for (const e of live) {
    if (e.name.kind === "part" && isOld(snapshot, e.name.run))
      steps.push({ kind: "delete-part", path: e.path });
  }
  for (const e of live) {
    if (e.name.kind === "tmp" && isOld(snapshot, e.name.of === "summary" ? e.name.run : null))
      steps.push({ kind: "delete-tmp", path: e.path });
  }
  const logs = live.filter(isLog);
  const summaries = live.filter(isSummary);
  const named = new Set(logs.flatMap((e) => e.namesBodies));
  for (const e of live) {
    if (e.name.kind === "body" && isOld(snapshot, e.name.run) && !named.has(e.name.id))
      steps.push({ kind: "delete-orphan-body", path: e.path });
  }
  for (const e of summaries) {
    if (!e.valid) steps.push({ kind: "delete-invalid-summary", segment: e.name.segment });
  }
  const summarized = new Set(summaries.filter((e) => e.valid).map((e) => e.name.segment));
  const oldUnsummarized = logs.filter(
    (e) => isOld(snapshot, e.name.run) && !summarized.has(e.name.segment),
  );
  for (const e of oldUnsummarized) {
    if (e.validBytes < e.bytes)
      steps.push({ kind: "truncate-log", segment: e.name.segment, toBytes: e.validBytes });
  }
  for (const { path, at } of snapshot.unfinishedExports) {
    if (at === "ours") steps.push({ kind: "delete-export-part", path });
    if (at === "other") steps.push({ kind: "leave-export-part", path });
  }
  for (const e of oldUnsummarized) steps.push({ kind: "summarize-log", segment: e.name.segment });
  return steps;
}

/** The plan's effect on a snapshot, as the store's executor performs it on disk: planReconcile(applyPlan(s, plan)) is []. */
export function applyPlan(snapshot: DirSnapshot, steps: readonly ReconcileStep[]): DirSnapshot {
  let entries = snapshot.entries;
  let unfinishedExports = snapshot.unfinishedExports;
  for (const step of steps) {
    switch (step.kind) {
      case "delete-excluded-site": {
        const dir = siteDirName(step.site);
        entries = entries.filter((e) => dirOf(e.name) !== dir);
        break;
      }
      case "delete-part":
      case "delete-tmp":
      case "delete-orphan-body":
        entries = entries.filter((e) => e.path !== step.path);
        break;
      case "delete-invalid-summary":
        entries = entries.filter((e) => !(isSummary(e) && e.name.segment === step.segment));
        break;
      case "truncate-log":
        entries = entries.map((e) =>
          isLog(e) && e.name.segment === step.segment
            ? { ...e, bytes: step.toBytes, validBytes: step.toBytes }
            : e,
        );
        break;
      case "delete-export-part":
      case "leave-export-part":
        unfinishedExports = unfinishedExports.filter((e) => e.path !== step.path);
        break;
      case "summarize-log": {
        const log = entries.filter(isLog).find((e) => e.name.segment === step.segment);
        if (log === undefined) break;
        const { dir, run, segment } = log.name;
        entries = [
          ...entries.filter((e) => !(isSummary(e) && e.name.segment === segment)),
          {
            path: logSummaryPath(segment).join("/"),
            name: { kind: "summary", dir, segment, run },
            valid: true,
          },
        ];
        break;
      }
    }
  }
  return { ...snapshot, entries, unfinishedExports };
}

/** What an exchange reads as after recovery, for the crash table's last column. Bytes are those the segment keeps. */
export type ReadsAs =
  | "absent"
  | "available"
  | "interrupted-by-crash"
  | "lines-before-the-tear"
  | "site-gone"
  | "not-applicable";
