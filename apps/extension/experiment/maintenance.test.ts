import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { emptyActivity } from "@hark/recording/activity";
import {
  exchangeId,
  parseChannelKey,
  parseSite,
  runIdAt,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
  type LogSegmentId,
  type PackId,
  type Site,
  type SiteDir,
} from "@hark/recording/ids";
import {
  bodyFilePath,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  packId,
  packPath,
  siteDirName,
} from "@hark/recording/layout";
import {
  planRetention,
  type RetentionFile,
  type RetentionRef,
  type RetentionStep,
} from "@hark/recording/retention";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "@hark/recording/settings";
import { createMaintenance } from "./maintenance.ts";

const DAY_MS = 86_400_000;
const TEST_ROOT = "/mock-archive";

interface MockFileEntry {
  bytes: number;
  mtime: number;
  content: string;
}

class MockFileSystem {
  readonly files = new Map<string, MockFileEntry>();
  callbackCount = 0;
  callbackBudget = 10_000;

  tick(): void {
    this.callbackCount += 1;
    if (this.callbackCount > this.callbackBudget) {
      throw new Error(`Callback loop budget exceeded (${String(this.callbackCount)})`);
    }
  }

  write(path: string, bytes: number, mtime: number, content = ""): void {
    this.files.set(path, { bytes, mtime, content });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  children(dir: string): string[] {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? filePath : `${prefix}${rest.slice(0, slash)}`);
    }
    return [...names].sort();
  }

  hasChildren(dir: string): boolean {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    for (const filePath of this.files.keys()) {
      if (filePath === dir || filePath.startsWith(prefix)) return true;
    }
    return false;
  }
}

const installMockGeckoGlobals = (fs: MockFileSystem): (() => void) => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    IOUtils: g["IOUtils"],
    PathUtils: g["PathUtils"],
    Cc: g["Cc"],
    Ci: g["Ci"],
  };

  g["PathUtils"] = {
    join: (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/"),
  };

  g["IOUtils"] = {
    exists: async (path: string) => fs.files.has(path) || fs.hasChildren(path),
    remove: async (path: string) => {
      fs.tick();
      fs.remove(path);
    },
    getChildren: async (path: string) => fs.children(path),
    stat: async (path: string) => {
      const entry = fs.files.get(path);
      if (entry !== undefined) {
        return { type: "regular", size: entry.bytes, lastModified: entry.mtime };
      }
      if (fs.hasChildren(path)) {
        return { type: "directory", size: 0, lastModified: 0 };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    readUTF8: async (path: string) => {
      const entry = fs.files.get(path);
      if (entry === undefined) throw new Error(`ENOENT: ${path}`);
      return entry.content;
    },
  };

  g["Ci"] = {
    nsIFile: Symbol("nsIFile"),
  };

  g["Cc"] = {
    "@mozilla.org/file/local;1": {
      createInstance: () => {
        let targetPath = "";
        return {
          initWithPath: (path: string) => {
            targetPath = path;
          },
          exists: () => {
            fs.tick();
            return fs.files.has(targetPath);
          },
          remove: () => {
            fs.tick();
            fs.remove(targetPath);
          },
        };
      },
    },
  };

  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };
};

const asByteCount = (n: number): ByteCount => n as ByteCount;
const asEpochMs = (n: number): EpochMs => n as EpochMs;
const asSite = (raw: string): Site => parseSite(raw)!;
const testRun = runIdAt(1_700_000_000_000 as EpochMs);
const mkExId = (seq: number): ExchangeId => exchangeId(testRun, parseChannelKey(String(seq))!);

const makeSettings = (
  maxBodyBytes: number,
  maxDetailBytes: number,
  maxAgeDays: number,
): UserSettings => ({
  ...DEFAULT_USER_SETTINGS,
  retention: {
    maxBodyBytes: asByteCount(maxBodyBytes),
    maxDetailBytes: asByteCount(maxDetailBytes),
    maxAgeDays,
  },
});

const refKey = (ref: RetentionRef): string =>
  ref.kind === "pack"
    ? `p:${ref.pack}`
    : ref.kind === "body-file"
      ? `b:${ref.id}`
      : `s:${ref.segment}`;

const refSortName = (ref: RetentionRef): string =>
  ref.kind === "pack"
    ? `p:${String(ref.pack)}`
    : ref.kind === "body-file"
      ? `b:${String(ref.site)}/${String(ref.id)}`
      : `s:${String(ref.segment)}`;

const compareRefOrder = (
  a: { readonly newestAt: number; readonly sortName: string },
  b: { readonly newestAt: number; readonly sortName: string },
): number =>
  a.newestAt - b.newestAt || (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0);

interface ModelBody {
  readonly key: string;
  readonly sortName: string;
  readonly ref: Extract<RetentionRef, { readonly kind: "pack" | "body-file" }>;
  readonly path: string;
  readonly siteDir: SiteDir;
  bytes: number;
  newestAt: EpochMs;
  open: boolean;
}

interface ModelDetail {
  readonly key: string;
  readonly sortName: string;
  readonly ref: Extract<RetentionRef, { readonly kind: "segment" }>;
  readonly logPath: string;
  readonly summaryPath: string;
  readonly siteDir: SiteDir;
  logBytes: number;
  summaryBytes: number;
  newestAt: EpochMs;
  open: boolean;
}

class RetentionModel {
  readonly bodies = new Map<string, ModelBody>();
  readonly details = new Map<string, ModelDetail>();
  readonly parts = new Map<
    ExchangeId,
    { readonly id: ExchangeId; readonly path: string; bytes: number }
  >();
  readonly activePins = new Map<
    string,
    { packs: Set<PackId>; bodyFiles: Set<ExchangeId>; segments: Set<LogSegmentId> }
  >();
  readonly pinnedPacks = new Map<PackId, number>();
  readonly pinnedBodies = new Map<ExchangeId, number>();
  readonly pinnedSegments = new Map<LogSegmentId, number>();
  readonly removedSegments: LogSegmentId[] = [];
  blockedByPin: ByteCount | null = null;
  private readonly fs: MockFileSystem;
  private pinSeq = 0;
  private sortedCache: ModelBody[] | null = null;

  constructor(fs: MockFileSystem) {
    this.fs = fs;
  }

  private invalidateBodies(): void {
    this.sortedCache = null;
  }

  private sortedBodies(): readonly ModelBody[] {
    if (this.sortedCache === null) {
      this.sortedCache = [...this.bodies.values()].sort(compareRefOrder);
    }
    return this.sortedCache;
  }

  isPinned(ref: RetentionRef): boolean {
    return ref.kind === "pack"
      ? (this.pinnedPacks.get(ref.pack) ?? 0) > 0
      : ref.kind === "body-file"
        ? (this.pinnedBodies.get(ref.id) ?? 0) > 0
        : (this.pinnedSegments.get(ref.segment) ?? 0) > 0;
  }

  usage(): { bodyBytes: number; detailBytes: number } {
    let bodyBytes = 0;
    for (const b of this.bodies.values()) bodyBytes += b.bytes;
    for (const p of this.parts.values()) bodyBytes += p.bytes;
    let detailBytes = 0;
    for (const d of this.details.values()) detailBytes += d.logBytes + d.summaryBytes;
    return { bodyBytes, detailBytes };
  }

  recordPackWrite(
    pack: PackId,
    path: string,
    siteDir: SiteDir,
    addedBytes: number,
    now: EpochMs,
    open: boolean,
  ): void {
    const ref = { kind: "pack", pack } as const;
    const key = refKey(ref);
    const existing = this.bodies.get(key);
    if (existing === undefined) {
      this.bodies.set(key, {
        key,
        sortName: refSortName(ref),
        ref,
        path,
        siteDir,
        bytes: addedBytes,
        newestAt: now,
        open,
      });
    } else {
      existing.bytes += addedBytes;
      existing.newestAt = now;
      existing.open = open;
    }
    this.invalidateBodies();
  }

  markPackClosed(pack: PackId): boolean {
    const existing = this.bodies.get(refKey({ kind: "pack", pack }));
    if (existing === undefined || !existing.open) return false;
    existing.open = false;
    this.invalidateBodies();
    return true;
  }

  recordBodyFile(site: Site, id: ExchangeId, path: string, bytes: number, now: EpochMs): void {
    this.parts.delete(id);
    const ref = { kind: "body-file", site, id } as const;
    const key = refKey(ref);
    this.bodies.set(key, {
      key,
      sortName: refSortName(ref),
      ref,
      path,
      siteDir: siteDirName(site),
      bytes,
      newestAt: now,
      open: false,
    });
    this.invalidateBodies();
  }

  recordSegmentWrite(
    segment: LogSegmentId,
    logPath: string,
    summaryPath: string,
    siteDir: SiteDir,
    addedBytes: number,
    now: EpochMs,
    open: boolean,
  ): void {
    const ref = { kind: "segment", segment } as const;
    const key = refKey(ref);
    const existing = this.details.get(key);
    if (existing === undefined) {
      this.details.set(key, {
        key,
        sortName: refSortName(ref),
        ref,
        logPath,
        summaryPath,
        siteDir,
        logBytes: addedBytes,
        summaryBytes: 0,
        newestAt: now,
        open,
      });
    } else {
      existing.logBytes += addedBytes;
      existing.newestAt = now;
      existing.open = open;
    }
  }

  recordSegmentSealed(
    segment: LogSegmentId,
    summaryBytes: number,
    lastStartedAt: EpochMs | null,
    now: EpochMs,
  ): void {
    const existing = this.details.get(refKey({ kind: "segment", segment }));
    if (existing === undefined) return;
    existing.summaryBytes = summaryBytes;
    existing.newestAt = lastStartedAt ?? now;
    existing.open = false;
  }

  trackPart(id: ExchangeId, path: string): void {
    if (!this.parts.has(id)) this.parts.set(id, { id, path, bytes: 0 });
  }

  updatePart(id: ExchangeId, bytes: number, settings: UserSettings): boolean {
    const part = this.parts.get(id);
    if (part === undefined) return false;
    part.bytes = bytes;
    const usage = this.usage();
    return (
      usage.bodyBytes > settings.retention.maxBodyBytes ||
      usage.detailBytes > settings.retention.maxDetailBytes
    );
  }

  untrackPart(id: ExchangeId): void {
    this.parts.delete(id);
  }

  lockedBodyBytes(settings: UserSettings, now: number): number {
    const sorted = this.sortedBodies();
    const pinIdx = sorted.findIndex((item) => this.isPinned(item.ref));
    let locked = 0;
    if (pinIdx !== -1) {
      const anchor = sorted[pinIdx]!;
      const anchorExpired = now - anchor.newestAt > settings.retention.maxAgeDays * DAY_MS;
      for (let i = pinIdx; i < sorted.length; i += 1) {
        const item = sorted[i]!;
        if (
          anchorExpired &&
          !item.open &&
          !this.isPinned(item.ref) &&
          now - item.newestAt > settings.retention.maxAgeDays * DAY_MS
        ) {
          continue;
        }
        locked += item.bytes;
      }
    }
    return locked;
  }

  pin(targets: { packs?: PackId[]; bodyFiles?: ExchangeId[]; segments?: LogSegmentId[] }): string {
    const id = `pin-${String(++this.pinSeq)}`;
    const packs = new Set(targets.packs ?? []);
    const bodyFiles = new Set(targets.bodyFiles ?? []);
    const segments = new Set(targets.segments ?? []);
    for (const p of packs) this.pinnedPacks.set(p, (this.pinnedPacks.get(p) ?? 0) + 1);
    for (const b of bodyFiles) this.pinnedBodies.set(b, (this.pinnedBodies.get(b) ?? 0) + 1);
    for (const s of segments) this.pinnedSegments.set(s, (this.pinnedSegments.get(s) ?? 0) + 1);
    this.activePins.set(id, { packs, bodyFiles, segments });
    return id;
  }

  unpin(id: string): boolean {
    const entry = this.activePins.get(id);
    if (entry === undefined) return false;
    this.activePins.delete(id);
    const dec = <K>(map: Map<K, number>, key: K) => {
      const next = (map.get(key) ?? 0) - 1;
      if (next <= 0) map.delete(key);
      else map.set(key, next);
    };
    for (const p of entry.packs) dec(this.pinnedPacks, p);
    for (const b of entry.bodyFiles) dec(this.pinnedBodies, b);
    for (const s of entry.segments) dec(this.pinnedSegments, s);
    return true;
  }

  forgetSite(site: Site): void {
    const dir = siteDirName(site);
    let removedBody = false;
    for (const [k, v] of this.bodies) {
      if (v.siteDir === dir) {
        this.bodies.delete(k);
        removedBody = true;
      }
    }
    if (removedBody) this.invalidateBodies();
    for (const [k, v] of this.details) {
      if (v.siteDir === dir) this.details.delete(k);
    }
  }

  replaceBodies(entries: Iterable<readonly [string, ModelBody]>): void {
    this.bodies.clear();
    for (const [k, v] of entries) this.bodies.set(k, v);
    this.invalidateBodies();
  }

  retain(
    settings: UserSettings,
    now: EpochMs,
    rotate: (ref: RetentionRef) => boolean,
  ): RetentionStep[] {
    const executed: RetentionStep[] = [];
    let partBytes = 0;
    for (const p of this.parts.values()) partBytes += p.bytes;
    const limit = this.bodies.size + this.details.size + 2;
    for (let pass = 0; pass < limit; pass += 1) {
      const bodyFiles: RetentionFile[] = [...this.bodies.values()].map((item) => ({
        ref: item.ref,
        bytes: item.bytes as ByteCount,
        newestAt: item.newestAt,
        open: item.open,
        pinned: this.isPinned(item.ref),
      }));
      const detailFiles: RetentionFile[] = [...this.details.values()].map((item) => ({
        ref: item.ref,
        bytes: (item.logBytes + item.summaryBytes) as ByteCount,
        newestAt: item.newestAt,
        open: item.open,
        pinned: this.isPinned(item.ref),
      }));
      const effectiveSettings =
        partBytes === 0
          ? settings
          : {
              ...settings,
              retention: {
                ...settings.retention,
                maxBodyBytes: Math.max(0, settings.retention.maxBodyBytes - partBytes) as ByteCount,
              },
            };
      const steps = planRetention(
        { now, bodies: bodyFiles, details: detailFiles },
        effectiveSettings,
      );
      let overBy: ByteCount | null = null;
      for (const s of steps) {
        if (s.kind === "blocked-by-pin") {
          overBy = overBy === null || s.overBy > overBy ? s.overBy : overBy;
        }
      }
      this.blockedByPin = overBy;
      const deletes = steps.filter((s) => s.kind === "delete");
      const rotates = steps.filter((s) => s.kind === "rotate");
      for (const step of deletes) {
        const key = refKey(step.ref);
        if (step.ref.kind === "segment") {
          const d = this.details.get(key);
          if (d !== undefined) {
            this.fs.remove(d.logPath);
            this.fs.remove(d.summaryPath);
            this.details.delete(key);
            this.removedSegments.push(step.ref.segment);
          }
        } else {
          const b = this.bodies.get(key);
          if (b !== undefined) {
            this.fs.remove(b.path);
            this.bodies.delete(key);
          }
        }
      }
      executed.push(...deletes);
      if (rotates.length === 0) {
        for (const s of steps) {
          if (s.kind === "blocked-by-pin") executed.push(s);
        }
        break;
      }
      let rotatedAny = false;
      for (const step of rotates) {
        executed.push(step);
        if (rotate(step.ref)) rotatedAny = true;
      }
      if (!rotatedAny) break;
    }
    return executed;
  }
}

const createRng = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

describe("createMaintenance heap and retention model", () => {
  let fs: MockFileSystem;
  let restoreGlobals: () => void;
  let fakeNow = 1_700_000_000_000;

  beforeEach(() => {
    fs = new MockFileSystem();
    restoreGlobals = installMockGeckoGlobals(fs);
    fakeNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreGlobals();
  });

  it("matches planRetention and a naive sorted-list model over random operation sequences", async () => {
    const sites = ["alpha.example", "beta.example", "gamma.example"].map(asSite);

    for (let seed = 1; seed <= 250; seed += 1) {
      const rand = createRng(seed);
      const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
      const randInt = (min: number, max: number): number =>
        min + Math.floor(rand() * (max - min + 1));

      fs.files.clear();
      const removedFromSut: LogSegmentId[] = [];
      const sut = createMaintenance({
        root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
        onSegmentRemoved: (seg) => removedFromSut.push(seg),
      });
      const model = new RetentionModel(fs);

      let seq = 0;
      const packIds: PackId[] = [];
      const bodyIds: { site: Site; id: ExchangeId }[] = [];
      const segmentIds: LogSegmentId[] = [];
      const partIds: ExchangeId[] = [];
      const pinIds: string[] = [];

      let settings = makeSettings(randInt(1_500, 6_000), randInt(1_000, 4_000), randInt(2, 14));

      const assertSync = (): void => {
        const sutUsage = sut.usage();
        const modelUsage = model.usage();
        if (
          sutUsage.bodyBytes !== modelUsage.bodyBytes ||
          sutUsage.detailBytes !== modelUsage.detailBytes
        ) {
          expect(sutUsage).toEqual(modelUsage);
        }
        if (sut.blockedOverBy() !== model.blockedByPin) {
          expect(sut.blockedOverBy()).toBe(model.blockedByPin);
        }
        const modelOver =
          modelUsage.bodyBytes > settings.retention.maxBodyBytes ||
          modelUsage.detailBytes > settings.retention.maxDetailBytes;
        if (sut.isOverCap(settings) !== modelOver) {
          expect(sut.isOverCap(settings)).toBe(modelOver);
        }
        const locked = model.lockedBodyBytes(settings, fakeNow);
        let totalParts = 0;
        for (const p of model.parts.values()) totalParts += p.bytes;
        for (const pId of partIds) {
          const cap = 4_000;
          const partSelf = model.parts.get(pId)?.bytes ?? 0;
          const expected = Math.min(
            cap,
            Math.max(0, settings.retention.maxBodyBytes - locked - (totalParts - partSelf)),
          );
          const actual = sut.partBudget(pId, cap, settings);
          if (actual !== expected) expect(actual).toBe(expected);
        }
      };

      for (let step = 0; step < 300; step += 1) {
        fs.callbackCount = 0;
        fs.callbackBudget = (model.bodies.size + model.details.size + 10) * 12;

        const op = randInt(0, 11);
        if (op <= 1) {
          // recordPackWrite (new or existing pack, sometimes shifting newestAt earlier or later)
          const site = pick(sites);
          const createNew = packIds.length === 0 || rand() < 0.55;
          const pack = createNew ? packId(site, testRun, ++seq) : pick(packIds);
          if (createNew) packIds.push(pack);
          const dir = siteDirName(site);
          const path = [TEST_ROOT, ...packPath(pack)].join("/");
          const added = randInt(100, 900);
          const ts = asEpochMs(fakeNow - randInt(0, 20) * DAY_MS + randInt(-500, 500));
          const open = rand() < 0.35;
          const prevSize = fs.files.get(path)?.bytes ?? 0;
          fs.write(path, prevSize + added, ts);
          sut.recordPackWrite(pack, path, dir, added, ts, open);
          model.recordPackWrite(pack, path, dir, added, ts, open);
        } else if (op === 2 && packIds.length > 0) {
          const pack = pick(packIds);
          expect(sut.markPackClosed(pack)).toBe(model.markPackClosed(pack));
        } else if (op === 3) {
          const site = pick(sites);
          const id = partIds.length > 0 && rand() < 0.35 ? pick(partIds) : mkExId(++seq);
          bodyIds.push({ site, id });
          const path = [TEST_ROOT, ...bodyFilePath(site, id)].join("/");
          const bytes = randInt(150, 1_200);
          const ts = asEpochMs(fakeNow - randInt(0, 20) * DAY_MS);
          fs.write(path, bytes, ts);
          sut.recordBodyFile(site, id, path, bytes, ts);
          model.recordBodyFile(site, id, path, bytes, ts);
        } else if (op === 4 || op === 5) {
          const site = pick(sites);
          const createNew = segmentIds.length === 0 || rand() < 0.5;
          const segment = createNew ? logSegmentId(site, testRun, ++seq) : pick(segmentIds);
          if (createNew) segmentIds.push(segment);
          const dir = siteDirName(site);
          const logPath = [TEST_ROOT, ...logSegmentPath(segment)].join("/");
          const summaryPath = [TEST_ROOT, ...logSummaryPath(segment)].join("/");
          if (op === 4) {
            const added = randInt(100, 700);
            const ts = asEpochMs(fakeNow - randInt(0, 20) * DAY_MS);
            const open = rand() < 0.45;
            const prevSize = fs.files.get(logPath)?.bytes ?? 0;
            fs.write(logPath, prevSize + added, ts);
            sut.recordSegmentWrite(segment, logPath, summaryPath, dir, added, ts, open);
            model.recordSegmentWrite(segment, logPath, summaryPath, dir, added, ts, open);
          } else {
            const sumBytes = randInt(40, 200);
            const lastStartedAt =
              rand() < 0.7 ? asEpochMs(fakeNow - randInt(0, 25) * DAY_MS) : null;
            const now = asEpochMs(fakeNow);
            fs.write(summaryPath, sumBytes, now);
            sut.recordSegmentSealed(segment, sumBytes, lastStartedAt, now);
            model.recordSegmentSealed(segment, sumBytes, lastStartedAt, now);
          }
        } else if (op === 6) {
          if (partIds.length === 0 || rand() < 0.4) {
            const id = mkExId(++seq);
            partIds.push(id);
            const path = `${TEST_ROOT}/parts/${id}.part`;
            sut.trackPart(id, path);
            model.trackPart(id, path);
          } else {
            const id = pick(partIds);
            const bytes = randInt(50, 2_500);
            const sutRes = sut.updatePart(id, bytes, settings);
            const modelRes = model.updatePart(id, bytes, settings);
            expect(sutRes).toBe(modelRes);
            if (rand() < 0.3) {
              sut.untrackPart(id);
              model.untrackPart(id);
              const idx = partIds.indexOf(id);
              if (idx !== -1) partIds.splice(idx, 1);
            }
          }
        } else if (op === 7) {
          const packs = packIds.length > 0 && rand() < 0.7 ? [pick(packIds)] : [];
          const bf = bodyIds.length > 0 && rand() < 0.4 ? [pick(bodyIds).id] : [];
          const segs = segmentIds.length > 0 && rand() < 0.4 ? [pick(segmentIds)] : [];
          const h = sut.pin({ packs, bodyFiles: bf, segments: segs });
          const mid = model.pin({ packs, bodyFiles: bf, segments: segs });
          pinIds.push(`${h.id}::${mid}`);
        } else if (op === 8 && pinIds.length > 0) {
          const idx = Math.floor(rand() * pinIds.length);
          const [pair] = pinIds.splice(idx, 1);
          const [sid, mid] = pair!.split("::");
          expect(sut.unpin(sid!)).toBe(model.unpin(mid!));
        } else if (op === 9) {
          // retain pass (compare exact steps, deletions, rotations, blockedOverBy)
          const allowRotate = rand() < 0.65;
          const sutFsBefore = new Map(fs.files);
          const modelFs = new MockFileSystem();
          for (const [k, v] of sutFsBefore) modelFs.files.set(k, { ...v });

          const modelWithCopyFs = new RetentionModel(modelFs);
          for (const [k, v] of model.bodies) modelWithCopyFs.bodies.set(k, { ...v });
          for (const [k, v] of model.details) modelWithCopyFs.details.set(k, { ...v });
          for (const [k, v] of model.parts) modelWithCopyFs.parts.set(k, { ...v });
          for (const [k, v] of model.pinnedPacks) modelWithCopyFs.pinnedPacks.set(k, v);
          for (const [k, v] of model.pinnedBodies) modelWithCopyFs.pinnedBodies.set(k, v);
          for (const [k, v] of model.pinnedSegments) modelWithCopyFs.pinnedSegments.set(k, v);

          const sutSteps = await sut.retain(settings, async (ref) => {
            fs.tick();
            if (!allowRotate) return false;
            if (ref.kind === "pack") return sut.markPackClosed(ref.pack);
            if (ref.kind === "segment") {
              sut.recordSegmentSealed(ref.segment, 0, null, asEpochMs(fakeNow));
              return true;
            }
            return false;
          });

          const modelSteps = modelWithCopyFs.retain(settings, asEpochMs(fakeNow), (ref) => {
            if (!allowRotate) return false;
            if (ref.kind === "pack") return modelWithCopyFs.markPackClosed(ref.pack);
            if (ref.kind === "segment") {
              modelWithCopyFs.recordSegmentSealed(ref.segment, 0, null, asEpochMs(fakeNow));
              return true;
            }
            return false;
          });

          // Sync model state to modelWithCopyFs after asserting equality
          expect(sutSteps).toEqual(modelSteps);
          expect([...fs.files.keys()].sort()).toEqual([...modelFs.files.keys()].sort());
          model.replaceBodies(modelWithCopyFs.bodies);
          model.details.clear();
          for (const [k, v] of modelWithCopyFs.details) model.details.set(k, v);
          model.blockedByPin = modelWithCopyFs.blockedByPin;
          model.removedSegments.push(...modelWithCopyFs.removedSegments);
        } else if (op === 10) {
          const site = pick(sites);
          sut.forgetSite(site);
          model.forgetSite(site);
        } else {
          fakeNow += randInt(1, 5) * DAY_MS;
          if (rand() < 0.3) {
            settings = makeSettings(randInt(1_000, 5_500), randInt(800, 3_500), randInt(2, 14));
          }
        }

        assertSync();
      }

      expect(removedFromSut).toEqual(model.removedSegments);
    }
  });

  it("evicts expired unpinned closed files around pinned/open expired entries without looping", async () => {
    const site = asSite("loop.example");
    const dir = siteDirName(site);
    const settings = makeSettings(200, 10_000, 14);
    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
    });

    const expiredAt = asEpochMs(fakeNow - 20 * DAY_MS);
    const pOpen = packId(site, testRun, 1);
    const pPinned = packId(site, testRun, 2);
    const pClosed = packId(site, testRun, 3);
    const pathOpen = [TEST_ROOT, ...packPath(pOpen)].join("/");
    const pathPinned = [TEST_ROOT, ...packPath(pPinned)].join("/");
    const pathClosed = [TEST_ROOT, ...packPath(pClosed)].join("/");
    fs.write(pathOpen, 100, expiredAt);
    fs.write(pathPinned, 100, expiredAt);
    fs.write(pathClosed, 100, expiredAt);

    sut.recordPackWrite(pOpen, pathOpen, dir, 100, expiredAt, true);
    sut.recordPackWrite(pPinned, pathPinned, dir, 100, expiredAt, false);
    sut.recordPackWrite(pClosed, pathClosed, dir, 100, expiredAt, false);
    const pinHandle = sut.pin({ packs: [pPinned] });

    const part = mkExId(99);
    sut.trackPart(part, `${TEST_ROOT}/parts/ex-part.part`);
    fs.callbackBudget = 30;
    const needsRetain = sut.updatePart(part, 150, settings);

    expect(needsRetain).toBe(true);
    expect(fs.files.has(pathClosed)).toBe(true);
    const pinnedSteps = await sut.retain(settings, async () => false);
    expect(pinnedSteps).toEqual([
      { kind: "delete", ref: { kind: "pack", pack: pClosed }, why: "age" },
      { kind: "rotate", ref: { kind: "pack", pack: pOpen } },
    ]);
    expect(fs.files.has(pathClosed)).toBe(false);
    expect(fs.files.has(pathOpen)).toBe(true);
    expect(fs.files.has(pathPinned)).toBe(true);
    expect(sut.usage().bodyBytes).toBe(350);

    pinHandle.release();
    const steps = await sut.retain(settings, async () => {
      sut.markPackClosed(pOpen);
      return true;
    });
    expect(steps).toEqual([
      { kind: "delete", ref: { kind: "pack", pack: pPinned }, why: "age" },
      { kind: "rotate", ref: { kind: "pack", pack: pOpen } },
      { kind: "delete", ref: { kind: "pack", pack: pOpen }, why: "age" },
    ]);
    expect(sut.usage().bodyBytes).toBe(150);
  });

  it("loadFromDisk rehydrates detailHeap and retains expired/over-cap segments", async () => {
    const site = asSite("disk.example");
    const dir = siteDirName(site);
    const settings = makeSettings(10_000, 250, 14);
    const removed: LogSegmentId[] = [];
    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: (s) => removed.push(s),
    });

    const segOld = logSegmentId(site, testRun, 1);
    const segNew = logSegmentId(site, testRun, 2);
    fs.write([TEST_ROOT, ...logSegmentPath(segOld)].join("/"), 200, fakeNow - 2_000);
    fs.write([TEST_ROOT, ...logSegmentPath(segNew)].join("/"), 200, fakeNow - 1_000);

    const steps = await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
    expect(steps).toEqual([
      { kind: "delete", ref: { kind: "segment", segment: segOld }, why: "size" },
    ]);
    expect(removed).toEqual([segOld]);
    expect(sut.usage().detailBytes).toBe(200);
    expect(siteDirName(site)).toBe(dir);
  });

  it("waitUntilLoaded keeps needsStartupBuffer conservative, never zeroes partBudget, and opens after retain", async () => {
    const site = asSite("startup.example");
    const packOld = packId(site, testRun, 1);
    const packNew = packId(site, testRun, 2);
    fs.write([TEST_ROOT, ...packPath(packOld)].join("/"), 400, fakeNow - 2_000);
    fs.write([TEST_ROOT, ...packPath(packNew)].join("/"), 400, fakeNow - 1_000);
    const settings = makeSettings(500, 1_000, 14);
    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      initialMaxBodyBytes: 500,
    });

    const liveId = exchangeId(testRun, parseChannelKey("99")!);
    expect(sut.isReady()).toBe(false);
    expect(sut.needsStartupBuffer(settings)).toBe(true);
    sut.trackPart(liveId, `${TEST_ROOT}/parts/live-99.part`);
    expect(sut.partBudget(liveId, 450, settings)).toBe(450);
    expect(sut.updatePart(liveId, 100, settings)).toBe(true);
    sut.untrackPart(liveId);

    const io = (globalThis as Record<string, unknown>)["IOUtils"] as {
      remove(path: string): Promise<void>;
    };
    const origRemove = io.remove;
    let readyDuringRetain: boolean | null = null;
    io.remove = async (path: string) => {
      readyDuringRetain = sut.isReady();
      return origRemove(path);
    };
    try {
      await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
    } finally {
      io.remove = origRemove;
    }
    expect(readyDuringRetain).toBe(false);
    expect(sut.isReady()).toBe(true);
    expect(sut.needsStartupBuffer(settings)).toBe(false);
    expect(sut.usage().bodyBytes).toBe(400);
    expect(sut.partBudget(liveId, 450, settings)).toBe(450);

    const withPersisted = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      persistedUsage: { bodyBytes: 100, detailBytes: 0 },
      initialMaxBodyBytes: 500,
    });
    expect(withPersisted.isReady()).toBe(false);
    expect(withPersisted.needsStartupBuffer(settings)).toBe(true);
    expect(withPersisted.needsStartupBuffer(settings, 100)).toBe(false);
    expect(withPersisted.needsStartupBuffer(settings, 200)).toBe(true);
    const b1 = exchangeId(testRun, parseChannelKey("190")!);
    withPersisted.trackPart(b1, `${TEST_ROOT}/parts/b1.part`, 100);
    // Remaining unproven batch budget is 125 - 100 = 25, so 50 must buffer.
    expect(withPersisted.needsStartupBuffer(settings, 50)).toBe(true);
    expect(withPersisted.needsStartupBuffer(settings, 25)).toBe(false);
    withPersisted.untrackPart(b1);

    const overstated = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      persistedUsage: { bodyBytes: 1_000, detailBytes: 0 },
      initialMaxBodyBytes: 500,
    });
    expect(overstated.needsStartupBuffer(settings, 10)).toBe(true);
  });

  it("loadFromDisk opens the gate on unreadable entries, scan errors, and scan timeout", async () => {
    const site = asSite("resilient.example");
    const goodPack = packId(site, testRun, 1);
    const badPack = packId(site, testRun, 2);
    const goodPath = [TEST_ROOT, ...packPath(goodPack)].join("/");
    const badPath = [TEST_ROOT, ...packPath(badPack)].join("/");
    fs.write(goodPath, 300, fakeNow - 1_000);
    fs.write(badPath, 300, fakeNow - 500);
    const blockedSiteDir = `${TEST_ROOT}/sites/denied.example`;
    fs.write(`${blockedSiteDir}/packs/stub.pack`, 100, fakeNow - 200);

    const io = (globalThis as Record<string, unknown>)["IOUtils"] as {
      stat(path: string): Promise<unknown>;
      getChildren(path: string): Promise<string[]>;
    };
    const origStat = io.stat;
    const origGetChildren = io.getChildren;

    // 1. Unreadable directory + unstatable pack are skipped and counted, never blocking startup.
    io.stat = async (path: string) => {
      if (path === badPath) throw new Error(`NotFoundError: Could not stat ${path}`);
      return origStat(path);
    };
    io.getChildren = async (path: string) => {
      if (path === blockedSiteDir) throw new Error(`NotAllowedError: ${path}`);
      return origGetChildren(path);
    };
    const settings = makeSettings(10_000, 1_000, 14);
    try {
      const sut = createMaintenance({
        root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
        onSegmentRemoved: () => undefined,
        waitUntilLoaded: true,
        initialMaxBodyBytes: 10_000,
      });
      let readyFired = false;
      sut.onReady(() => {
        readyFired = true;
      });
      await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
      expect(sut.isReady()).toBe(true);
      expect(readyFired).toBe(true);
      expect(sut.unreadableEntries()).toBe(2);
      expect(sut.usage().bodyBytes).toBe(300);
    } finally {
      io.stat = origStat;
      io.getChildren = origGetChildren;
    }

    // 2. Scan error (even unexpected) still opens the gate via finally.
    const errPack = packId(site, testRun, 3);
    const errPath = [TEST_ROOT, ...packPath(errPack)].join("/");
    fs.write(errPath, 300, fakeNow - 1_000);
    const sutThrow = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      initialMaxBodyBytes: 100,
    });
    let errReadyFired = false;
    sutThrow.onReady(() => {
      errReadyFired = true;
    });
    const prevRemove = (
      (globalThis as Record<string, unknown>)["IOUtils"] as {
        remove(p: string): Promise<void>;
      }
    ).remove;
    (
      (globalThis as Record<string, unknown>)["IOUtils"] as { remove(p: string): Promise<void> }
    ).remove = async () => {
      throw new Error("boom remove");
    };
    try {
      await expect(
        sutThrow.loadFromDisk(
          emptyActivity(testRun),
          makeSettings(100, 100, 14),
          async () => false,
        ),
      ).rejects.toThrow("boom remove");
      expect(sutThrow.isReady()).toBe(true);
      expect(errReadyFired).toBe(true);
    } finally {
      (
        (globalThis as Record<string, unknown>)["IOUtils"] as { remove(p: string): Promise<void> }
      ).remove = prevRemove;
    }

    // 3. Timeout opens the gate before a stalled scan completes and merges post-timeout writes safely.
    let resolveScan!: (value: string[]) => void;
    const scanPaused = new Promise<string[]>((resolve) => {
      resolveScan = resolve;
    });
    io.getChildren = async (path: string) => {
      if (path === `${TEST_ROOT}/sites`) return scanPaused;
      return origGetChildren(path);
    };
    try {
      let fireScanTimeout: (() => void) | null = null;
      const sutTimeout = createMaintenance({
        root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
        onSegmentRemoved: () => undefined,
        waitUntilLoaded: true,
        initialMaxBodyBytes: 10_000,
        scanTimeoutMs: 15,
        timers: {
          once: (_ms, fire) => {
            fireScanTimeout = fire;
            return { cancel: () => undefined };
          },
        },
      });
      let timeoutReadyFired = false;
      sutTimeout.onReady(() => {
        timeoutReadyFired = true;
      });
      const pendingLoad = sutTimeout.loadFromDisk(
        emptyActivity(testRun),
        settings,
        async () => false,
      );
      expect(fireScanTimeout).not.toBeNull();
      fireScanTimeout!();
      expect(sutTimeout.isReady()).toBe(true);
      expect(sutTimeout.scanTimedOut()).toBe(true);
      expect(timeoutReadyFired).toBe(true);

      const postTimeoutPack = packId(site, testRun, 99);
      const postPath = [TEST_ROOT, ...packPath(postTimeoutPack)].join("/");
      fs.write(postPath, 250, fakeNow + 10);
      sutTimeout.recordPackWrite(
        postTimeoutPack,
        postPath,
        siteDirName(site),
        250,
        asEpochMs(fakeNow + 10),
        false,
      );

      io.getChildren = origGetChildren;
      resolveScan([`${TEST_ROOT}/sites/${siteDirName(site)}`]);
      await pendingLoad;
      expect(sutTimeout.usage().bodyBytes).toBe(1150);
    } finally {
      io.getChildren = origGetChildren;
    }
  });

  it("countWork bounds per-flush and per-chunk operations at 5,000 packs", async () => {
    const site = asSite("scale.example");
    const dir = siteDirName(site);
    for (let i = 1; i <= 5_000; i += 1) {
      const p = packId(site, testRun, i);
      fs.write([TEST_ROOT, ...packPath(p)].join("/"), 100, fakeNow - (5_001 - i));
    }
    const settings = makeSettings(500_000, 1_000_000, 14);
    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      countWork: true,
    });
    await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
    sut.resetWorkMetrics();

    for (let i = 5_001; i <= 5_020; i += 1) {
      const p = packId(site, testRun, i);
      const path = [TEST_ROOT, ...packPath(p)].join("/");
      fs.write(path, 100, (fakeNow + i) as EpochMs);
      sut.recordPackWrite(p, path, dir, 100, (fakeNow + i) as EpochMs, false);
    }
    await sut.retain(settings, async () => false);

    const liveId = exchangeId(testRun, parseChannelKey("77")!);
    sut.trackPart(liveId, `${TEST_ROOT}/parts/live-77.part`);
    expect(sut.partBudget(liveId, 10_000, settings)).toBe(10_000);
    expect(sut.updatePart(liveId, 1_500, settings)).toBe(true);
    await sut.retain(settings, async () => false);

    const metrics = sut.workMetrics();
    const logFactor = Math.max(8, Math.ceil(Math.log2(metrics.inventorySize + 2)));
    const flushPerEviction = 6 * logFactor;
    expect(metrics.flushDeletes).toBe(35);
    expect(metrics.chunkDeletes).toBe(0);
    expect(metrics.flushTouched).toBeGreaterThanOrEqual(metrics.flushDeletes);
    expect(metrics.chunkTouched).toBeLessThanOrEqual(4 * metrics.chunkCalls);
    expect(metrics.flushTouched).toBeLessThanOrEqual(
      flushPerEviction * (metrics.flushDeletes + metrics.flushRotates) + 4 * metrics.flushPasses,
    );
  });

  it("sifts index 0 down on rebuild so reverse-mtime scan evicts oldest first", async () => {
    const site = asSite("heap-rebuild.example");
    // Assign newest mtime to lowest seq so sorted directory listing puts the newest entry at heap index 0.
    const packPaths: string[] = [];
    const logPaths: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const p = [TEST_ROOT, ...packPath(packId(site, testRun, i))].join("/");
      fs.write(p, 100, fakeNow - i * 1_000);
      packPaths.push(p);
      const l = [TEST_ROOT, ...logSegmentPath(logSegmentId(site, testRun, i))].join("/");
      fs.write(l, 100, fakeNow - i * 1_000);
      logPaths.push(l);
    }

    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
      waitUntilLoaded: true,
      initialMaxBodyBytes: 300,
    });
    const settings = makeSettings(300, 300, 14);
    await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);

    // Oldest (i=4, last in sorted listing) must be evicted while newest (i=1, index 0 before siftDown) survives.
    expect(fs.files.has(packPaths[3]!)).toBe(false);
    expect(fs.files.has(packPaths[0]!)).toBe(true);
    expect(fs.files.has(logPaths[3]!)).toBe(false);
    expect(fs.files.has(logPaths[0]!)).toBe(true);

    const liveId = exchangeId(testRun, parseChannelKey("88")!);
    sut.trackPart(liveId, `${TEST_ROOT}/parts/live-88.part`);
    expect(sut.updatePart(liveId, 100, settings)).toBe(true);
    expect(fs.files.has(packPaths[2]!)).toBe(true);
    await sut.retain(settings, async () => false);
    expect(fs.files.has(packPaths[2]!)).toBe(false);
    expect(fs.files.has(packPaths[0]!)).toBe(true);
  });

  it("holds unknown-size partBudget at zero on early timeout and downgrades understated ledgers mid-scan", async () => {
    const site = asSite("scan-cap.example");
    const packA = [TEST_ROOT, ...packPath(packId(site, testRun, 1))].join("/");
    const packB = [TEST_ROOT, ...packPath(packId(site, testRun, 2))].join("/");
    fs.write(packA, 300, fakeNow - 2_000);
    fs.write(packB, 300, fakeNow - 1_000);

    const io = (globalThis as Record<string, unknown>)["IOUtils"] as {
      getChildren(path: string): Promise<string[]>;
    };
    const origGetChildren = io.getChildren;
    let release!: (children: string[]) => void;
    const paused = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    io.getChildren = async (path: string) =>
      path === `${TEST_ROOT}/sites` ? paused : origGetChildren(path);

    try {
      let fireTimeout: (() => void) | null = null;
      let scheduledDelay = -1;
      const sutUnknown = createMaintenance({
        root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
        onSegmentRemoved: () => undefined,
        waitUntilLoaded: true,
        persistedUsage: null,
        initialMaxBodyBytes: 500,
        timers: {
          once: (ms, fire) => {
            scheduledDelay = ms;
            fireTimeout = fire;
            return { cancel: () => undefined };
          },
        },
      });
      const settings = makeSettings(500, 1_000, 14);
      const loading = sutUnknown.loadFromDisk(emptyActivity(testRun), settings, async () => false);
      expect(scheduledDelay).toBe(30_000);
      fireTimeout!();
      expect(sutUnknown.isReady()).toBe(true);
      const id = exchangeId(testRun, parseChannelKey("55")!);
      sutUnknown.trackPart(id, `${TEST_ROOT}/parts/55.part`);
      // Scan has not proved any bytes free yet, so budget must be 0 even after timeout opens gate.
      expect(sutUnknown.partBudget(id, 400, settings)).toBe(0);

      io.getChildren = origGetChildren;
      release(await origGetChildren(`${TEST_ROOT}/sites`));
      await loading;
      expect(sutUnknown.partBudget(id, 400, settings)).toBe(400);

      // Understated persisted ledger must downgrade to initialMaxBodyBytes even when scannedBodyBytes < maxBodyBytes.
      fs.files.clear();
      const siteUnder = asSite("midscan-under.example");
      for (let i = 1; i <= 100; i += 1) {
        fs.write(
          [TEST_ROOT, ...packPath(packId(siteUnder, testRun, i))].join("/"),
          6,
          fakeNow - (200 - i),
        );
      }
      const sutUnder = createMaintenance({
        root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
        onSegmentRemoved: () => undefined,
        waitUntilLoaded: true,
        persistedUsage: { bodyBytes: 200, detailBytes: 0, bodyCount: 20, detailCount: 0 },
        initialMaxBodyBytes: 500,
      });
      expect(sutUnder.needsStartupBuffer(settings, 50)).toBe(false);
      let midScanNeedsBuffer = false;
      let midScanBudget = -1;
      const liveUnderId = exchangeId(testRun, parseChannelKey("56")!);
      const origStat = (
        (globalThis as Record<string, unknown>)["IOUtils"] as {
          stat(path: string): Promise<unknown>;
        }
      ).stat;
      let statCalls = 0;
      (
        (globalThis as Record<string, unknown>)["IOUtils"] as {
          stat(path: string): Promise<unknown>;
        }
      ).stat = async (path: string) => {
        if (path.endsWith(".pack")) {
          statCalls += 1;
          // Batch 1 scanned 64 packs = 384 B < 500 maxBodyBytes, triggering downgrade while scannedBodyBytes < cap.
          if (statCalls === 65) {
            midScanNeedsBuffer = sutUnder.needsStartupBuffer(settings, 50);
            midScanBudget = sutUnder.partBudget(liveUnderId, 400, settings);
          }
        }
        return origStat(path);
      };
      try {
        await sutUnder.loadFromDisk(emptyActivity(testRun), settings, async () => false);
      } finally {
        (
          (globalThis as Record<string, unknown>)["IOUtils"] as {
            stat(path: string): Promise<unknown>;
          }
        ).stat = origStat;
      }
      expect(midScanNeedsBuffer).toBe(true);
      expect(midScanBudget).toBe(0);
      expect(sutUnder.startupGateMetrics()).toEqual({
        gateStartedShut: true,
        scanCompleted: true,
        scanTimedOut: false,
        initiallyTrusted: true,
        downgraded: true,
        preScanFileBytes: 0,
        preScanOpenParts: 0,
        postDowngradeFileBytes: 0,
        postDowngradeOpenParts: 0,
      });
      expect(sutUnder.usage().bodyBytes).toBe(498);
      expect(sutUnder.ledgerSnapshot().bodyCount).toBe(83);
    } finally {
      io.getChildren = origGetChildren;
    }
  });

  it("counts reserved async write bytes in partBudget, updatePart, and retain until released", async () => {
    const site = asSite("reserve-write.example");
    const pack1 = [TEST_ROOT, ...packPath(packId(site, testRun, 1))].join("/");
    const pack2 = [TEST_ROOT, ...packPath(packId(site, testRun, 2))].join("/");
    fs.write(pack1, 300, fakeNow - 2_000);
    fs.write(pack2, 200, fakeNow - 1_000);

    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
    });
    const settings = makeSettings(500, 1_000, 14);
    await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
    expect(sut.usage().bodyBytes).toBe(500);

    // Reserve 250 B for an async body/pack append and evict BEFORE writing bytes to disk.
    const release = sut.reserveWrite(250);
    expect(sut.usage().bodyBytes).toBe(750);
    expect(sut.ledgerSnapshot().bodyBytes).toBe(500);
    await sut.retain(settings, async () => false);
    // pack1 (300 B) was deleted so durable (200 B) + pending (250 B) = 450 B <= 500 B.
    expect(fs.files.has(pack1)).toBe(false);
    expect(fs.files.has(pack2)).toBe(true);
    expect(sut.usage().bodyBytes).toBe(450);

    // While the async append still holds 250 B, a concurrent file-tee part sees maxBodyBytes - pending = 250 B cap and schedules retention at > 500 B.
    const partId = exchangeId(testRun, parseChannelKey("77")!);
    sut.trackPart(partId, `${TEST_ROOT}/parts/77.part`);
    expect(sut.partBudget(partId, 400, settings)).toBe(250);
    expect(sut.updatePart(partId, 100, settings)).toBe(true);
    expect(fs.files.has(pack2)).toBe(true);
    await sut.retain(settings, async () => false);
    expect(fs.files.has(pack2)).toBe(false);
    expect(sut.usage().bodyBytes).toBe(350);

    // Idempotent release hands off atomically to recordBodyFile without double-subtracting.
    release();
    release();
    sut.recordBodyFile(
      site,
      exchangeId(testRun, parseChannelKey("78")!),
      `${TEST_ROOT}/bodies/78.body`,
      250,
      fakeNow as EpochMs,
    );
    expect(sut.usage().bodyBytes).toBe(350);
    expect(sut.ledgerSnapshot().bodyBytes).toBe(250);
  });

  it("reserves post-scan expected part bytes in drain and retain until written or capped", async () => {
    const site = asSite("post-scan-expected.example");
    const pack1 = [TEST_ROOT, ...packPath(packId(site, testRun, 1))].join("/");
    const pack2 = [TEST_ROOT, ...packPath(packId(site, testRun, 2))].join("/");
    fs.write(pack1, 400_000, fakeNow - 2_000);
    fs.write(pack2, 400_000, fakeNow - 1_000);

    const sut = createMaintenance({
      root: TEST_ROOT as unknown as Parameters<typeof createMaintenance>[0]["root"],
      onSegmentRemoved: () => undefined,
    });
    const settings = makeSettings(1_000_000, 1_000_000, 14);
    await sut.loadFromDisk(emptyActivity(testRun), settings, async () => false);
    expect(sut.needsRetentionDrain(settings)).toBe(false);

    // Parallel file-tee streams whose Content-Length exceeds remaining headroom trigger drain before chunk 1.
    const part1 = exchangeId(testRun, parseChannelKey("81")!);
    const part2 = exchangeId(testRun, parseChannelKey("82")!);
    sut.trackPart(part1, `${TEST_ROOT}/parts/81.part`, 300_000);
    sut.trackPart(part2, `${TEST_ROOT}/parts/82.part`, 300_000);
    expect(sut.isOverCap(settings)).toBe(true);
    expect(sut.needsRetentionDrain(settings)).toBe(true);

    // retain evicts pack1 (400 KB) upfront so 400 KB pack2 + 600 KB expected parts <= 1 MB cap.
    await sut.retain(settings, async () => false);
    expect(fs.files.has(pack1)).toBe(false);
    expect(fs.files.has(pack2)).toBe(true);
    expect(sut.needsRetentionDrain(settings)).toBe(false);

    // As part1 streams 150 KB and is capped early, remaining expected reserve releases immediately.
    sut.updatePart(part1, 150_000, settings, true);
    sut.updatePart(part2, 100_000, settings);
    expect(sut.usage().bodyBytes).toBe(650_000);

    // Without capped=true, part2 still holds 200 KB expected reserve until untrack/recordBodyFile.
    const part3 = exchangeId(testRun, parseChannelKey("83")!);
    sut.trackPart(part3, `${TEST_ROOT}/parts/83.part`, 300_000);
    // packs(400k) + parts(250k) + expected(part2:200k + part3:300k) = 1.15M > 1M + 128 KiB.
    expect(sut.needsRetentionDrain(settings)).toBe(true);
    sut.untrackPart(part3);
    expect(sut.needsRetentionDrain(settings)).toBe(false);
  });
});
