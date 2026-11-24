// Startup recovery, retention and pins behind one interface. Recovery plans with planReconcile before this run writes;
// retention tracks running totals and executes planRetention on the store's write chain.

import type { ActivityIndex } from "@hark/recording/activity";
import { applyActivity } from "@hark/recording/activity";
import type {
  ByteCount,
  EpochMs,
  ExchangeId,
  LogSegmentId,
  PackId,
  RunId,
  Site,
  SiteDir,
} from "@hark/recording/ids";
import {
  LAYOUT,
  logSegmentPath,
  logSummaryPath,
  parseArchiveName,
  parseSiteDir,
  siteDirName,
  type ArchiveName,
  type SafeFolder,
} from "@hark/recording/layout";
import {
  decodeLine,
  decodeSummary,
  encodeSummary,
  summarize,
  type LogLine,
} from "@hark/recording/log";
import {
  planReconcile,
  type DirSnapshot,
  type ReconcileStep,
  type SnapshotEntry,
  type UnfinishedExport,
} from "@hark/recording/reconcile";
import { carriesHead, type JournaledPart } from "./export-file.ts";
import type { RetentionRef, RetentionStep } from "@hark/recording/retention";
import type { UserSettings } from "@hark/recording/settings";
import {
  localFile,
  type Modes,
  pathState,
  readHead,
  type Timers,
  writeAtomic,
} from "./gecko-io.ts";

export const RETENTION_EVERY_MS = 10 * 60_000;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const STAT_BATCH_SIZE = 64;
const STARTUP_DIRECT_MARGIN_CAP = 2 * 1_048_576;

const relative = (root: string, path: string): readonly string[] =>
  path.slice(root.length + 1).split(/[\\/]/);

const children = (path: string): Promise<string[]> =>
  IOUtils.getChildren(path, { ignoreAbsent: true });

const isDirectory = async (path: string): Promise<boolean> =>
  (await IOUtils.stat(path)).type === "directory";

const readUtf8OrNull = async (path: string): Promise<string | null> => {
  try {
    return await IOUtils.readUTF8(path);
  } catch {
    return null;
  }
};

const statMtime = async (
  path: string,
): Promise<{ readonly bytes: number; readonly mtime: EpochMs } | null> => {
  try {
    const info = await IOUtils.stat(path);
    const mtime = info.lastModified ?? localFile(path).lastModifiedTime ?? Date.now();
    return { bytes: info.size, mtime: mtime as EpochMs };
  } catch {
    return null;
  }
};

/** settings.json.tmp, incoming/, and sites/<site>/<folder>/ entries, skipping unreadable entries cleanly. */
async function listFilesSafe(
  root: string,
): Promise<{ readonly files: string[]; readonly unreadable: number }> {
  const found: string[] = [];
  let unreadable = 0;
  for (const name of [LAYOUT.settings, LAYOUT.ledger]) {
    const tmpPath = PathUtils.join(root, `${name}${LAYOUT.tmpSuffix}`);
    try {
      if (await IOUtils.exists(tmpPath)) found.push(tmpPath);
    } catch {
      unreadable += 1;
    }
  }
  try {
    found.push(...(await children(PathUtils.join(root, LAYOUT.incomingDir))));
  } catch {
    unreadable += 1;
  }
  let sites: string[] = [];
  try {
    sites = await children(PathUtils.join(root, LAYOUT.sitesDir));
  } catch {
    unreadable += 1;
    return { files: found, unreadable };
  }
  for (const site of sites) {
    try {
      if (!(await isDirectory(site))) continue;
      found.push(site);
      const folders = await children(site);
      for (const folder of folders) {
        try {
          if (await isDirectory(folder)) found.push(...(await children(folder)));
        } catch {
          unreadable += 1;
        }
      }
    } catch {
      unreadable += 1;
    }
  }
  return { files: found, unreadable };
}

const wholeLines = (text: string): LogLine[] =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .map(decodeLine)
    .filter((line): line is LogLine => line !== null);

const bodiesNamed = (lines: readonly LogLine[]): ExchangeId[] =>
  lines.flatMap(({ exchange }) =>
    exchange.kind === "answered" &&
    exchange.body.kind === "stored" &&
    exchange.body.at.kind === "file"
      ? [exchange.body.at.id]
      : [],
  );

type Named<K extends ArchiveName["kind"]> = Extract<ArchiveName, { readonly kind: K }>;

/**
 * Every log is stat'ed; its lines are read only where planReconcile needs them: an old run's segment with no valid
 * summary (it may end mid-line), or one beside body files of its own run (the orphan check). A body's line is always
 * written by the run that wrote the body.
 */
async function snapshotArchive(
  root: SafeFolder,
  run: RunId,
  excluded: readonly Site[],
  journaled: readonly JournaledPart[] = [],
): Promise<DirSnapshot> {
  const entries: SnapshotEntry[] = [];
  const logs: { readonly path: string; readonly name: Named<"log">; readonly bytes: number }[] = [];
  const summaries: { readonly path: string; readonly name: Named<"summary"> }[] = [];
  const bodyRuns = new Set<string>();
  const { files } = await listFilesSafe(root);
  for (const path of files) {
    const segments = relative(root, path);
    const name = parseArchiveName(segments);
    if (name === null) continue;
    const key = segments.join("/");
    if (name.kind === "log") {
      try {
        logs.push({ path: key, name, bytes: (await IOUtils.stat(path)).size });
      } catch {
        // Unstatable log is skipped; startup scan reports unreadable entries in status.
      }
    } else if (name.kind === "summary") summaries.push({ path: key, name });
    else entries.push({ path: key, name });
    if (name.kind === "body") bodyRuns.add(`${name.dir}/${name.run}`);
  }
  const bytesOf = new Map(logs.map((log) => [log.name.segment, log.bytes]));
  const summarized = new Set<string>();
  for (const { path, name } of summaries) {
    const bytes = bytesOf.get(name.segment);
    const raw =
      bytes === undefined ? null : await readUtf8OrNull(PathUtils.join(root, ...path.split("/")));
    const valid =
      bytes !== undefined && raw !== null && decodeSummary(raw, bytes as ByteCount) !== null;
    if (valid) summarized.add(name.segment);
    entries.push({ path, name, valid });
  }
  for (const { path, name, bytes } of logs) {
    const needsLines =
      name.run !== run &&
      (!summarized.has(name.segment) || bodyRuns.has(`${name.dir}/${name.run}`));
    const text = needsLines ? await readUtf8OrNull(PathUtils.join(root, ...path.split("/"))) : null;
    entries.push({
      path,
      name,
      bytes,
      validBytes: text === null ? bytes : text.lastIndexOf("\n") + 1,
      namesBodies: text === null ? [] : bodiesNamed(wholeLines(text)),
    });
  }
  const unfinishedExports: UnfinishedExport[] = [];
  for (const { path, head } of journaled)
    unfinishedExports.push({ path, at: await whatIsAt(path, head) });
  return { current: run, excluded, entries, unfinishedExports };
}

const GECKO_IO = { state: pathState, readHead };

/** A path the journal names that cannot even be looked at is never taken for the export's part. */
const whatIsAt = async (path: string, head: string): Promise<UnfinishedExport["at"]> => {
  try {
    if (pathState(path).kind === "missing") return "gone";
    return (await carriesHead(GECKO_IO, path, head)) ? "ours" : "other";
  } catch {
    return "other";
  }
};

async function executeReconcile(
  root: SafeFolder,
  modes: Modes,
  step: ReconcileStep,
  heads: ReadonlyMap<string, string>,
): Promise<void> {
  const at = (segments: readonly string[]): string => PathUtils.join(root, ...segments);
  switch (step.kind) {
    case "delete-excluded-site":
      return IOUtils.remove(at([LAYOUT.sitesDir, siteDirName(step.site)]), {
        recursive: true,
        ignoreAbsent: true,
      });
    case "delete-part":
    case "delete-tmp":
    case "delete-orphan-body":
      return IOUtils.remove(at(step.path.split("/")), { ignoreAbsent: true });
    case "delete-invalid-summary":
      return IOUtils.remove(at(logSummaryPath(step.segment)), { ignoreAbsent: true });
    case "truncate-log": {
      const path = at(logSegmentPath(step.segment));
      const text = await IOUtils.readUTF8(path);
      return writeAtomic(path, text.slice(0, step.toBytes), modes);
    }
    case "delete-export-part":
      // Proved again just before the delete, in case the file changed since the snapshot.
      if (await carriesHead(GECKO_IO, step.path, heads.get(step.path) ?? ""))
        await IOUtils.remove(step.path, { ignoreAbsent: true });
      return;
    case "leave-export-part":
      return;
    case "summarize-log": {
      const text = await IOUtils.readUTF8(at(logSegmentPath(step.segment)));
      const summary = summarize(step.segment, wholeLines(text), text.length as ByteCount);
      return writeAtomic(at(logSummaryPath(step.segment)), encodeSummary(summary), modes);
    }
  }
}

/** Runs first on the store's write chain, before this run writes anything. Returns the steps it carried out. */
export async function recover(
  root: SafeFolder,
  modes: Modes,
  run: RunId,
  excluded: readonly Site[],
  journaled: readonly JournaledPart[] = [],
): Promise<readonly ReconcileStep[]> {
  const steps = planReconcile(await snapshotArchive(root, run, excluded, journaled));
  const heads = new Map(journaled.map(({ path, head }) => [path, head]));
  for (const step of steps) await executeReconcile(root, modes, step, heads);
  return steps;
}

export interface PinTargets {
  readonly packs?: readonly PackId[];
  readonly bodyFiles?: readonly ExchangeId[];
  readonly segments?: readonly LogSegmentId[];
}

export interface PinHandle {
  readonly id: string;
  release(): void;
}

interface TrackedBody {
  readonly key: string;
  readonly sortName: string;
  readonly ref: Extract<RetentionRef, { readonly kind: "pack" | "body-file" }>;
  readonly path: string;
  readonly siteDir: SiteDir;
  bytes: number;
  newestAt: EpochMs;
  open: boolean;
  heapIndex: number;
}

interface TrackedDetail {
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
  heapIndex: number;
}

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

interface TrackedPart {
  readonly id: ExchangeId;
  readonly path: string;
  bytes: number;
}

const DAY_MS = 86_400_000;
const DRAIN_MARGIN_BYTES = 128 * 1024;

interface HeapSortable {
  readonly newestAt: EpochMs;
  readonly sortName: string;
  heapIndex: number;
}

const oldestFirst = (
  a: { readonly newestAt: EpochMs; readonly sortName: string },
  b: { readonly newestAt: EpochMs; readonly sortName: string },
): number =>
  a.newestAt - b.newestAt || (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0);

const countingArray = <T>(onAccess: () => void): T[] =>
  new Proxy([] as T[], {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/u.test(prop)) onAccess();
      return Reflect.get(target, prop, receiver);
    },
  });

/** Indexed min-heap ordered by `oldestFirst` so chunk-time eviction and retain stay O(k log N). */
class IndexedMinHeap<T extends HeapSortable> {
  private readonly items: T[];

  constructor(onStep?: () => void) {
    this.items = onStep === undefined ? [] : countingArray<T>(onStep);
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;
    const last = this.items.pop()!;
    top.heapIndex = -1;
    if (this.items.length > 0) {
      this.items[0] = last;
      last.heapIndex = 0;
      this.siftDown(0);
    }
    return top;
  }

  push(item: T): void {
    item.heapIndex = this.items.length;
    this.items.push(item);
    this.siftUp(item.heapIndex);
  }

  remove(item: T): void {
    const idx = item.heapIndex;
    if (idx < 0 || idx >= this.items.length || this.items[idx] !== item) return;
    const last = this.items.pop()!;
    item.heapIndex = -1;
    if (idx < this.items.length) {
      this.items[idx] = last;
      last.heapIndex = idx;
      this.siftUp(idx);
      this.siftDown(last.heapIndex);
    }
  }

  update(item: T): void {
    const idx = item.heapIndex;
    if (idx < 0 || idx >= this.items.length || this.items[idx] !== item) return;
    if (!this.siftUp(idx)) this.siftDown(idx);
  }

  rebuild(entries: Iterable<T>): void {
    this.items.length = 0;
    for (const item of entries) {
      item.heapIndex = this.items.length;
      this.items.push(item);
    }
    for (let i = Math.floor(this.items.length / 2) - 1; i >= 0; i -= 1) {
      this.siftDown(i);
    }
  }

  clear(): void {
    for (const item of this.items) item.heapIndex = -1;
    this.items.length = 0;
  }

  private siftUp(start: number): boolean {
    let idx = start;
    const item = this.items[idx]!;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.items[parentIdx]!;
      if (oldestFirst(item, parent) >= 0) break;
      this.items[idx] = parent;
      parent.heapIndex = idx;
      idx = parentIdx;
    }
    this.items[idx] = item;
    item.heapIndex = idx;
    return idx !== start;
  }

  private siftDown(start: number): void {
    let idx = start;
    const len = this.items.length;
    const item = this.items[idx]!;
    while (true) {
      const leftIdx = idx * 2 + 1;
      if (leftIdx >= len) break;
      const left = this.items[leftIdx]!;
      let smallestIdx = leftIdx;
      let smallest = left;
      const rightIdx = leftIdx + 1;
      if (rightIdx < len) {
        const right = this.items[rightIdx]!;
        if (oldestFirst(right, left) < 0) {
          smallestIdx = rightIdx;
          smallest = right;
        }
      }
      if (oldestFirst(item, smallest) <= 0) break;
      this.items[idx] = smallest;
      smallest.heapIndex = idx;
      idx = smallestIdx;
    }
    this.items[idx] = item;
    item.heapIndex = idx;
  }
}

class CountingMap<K, V> extends Map<K, V> {
  private readonly onVisit: () => void;

  constructor(onVisit: () => void) {
    super();
    this.onVisit = onVisit;
  }

  override *keys(): MapIterator<K> {
    for (const k of super.keys()) {
      this.onVisit();
      yield k;
    }
  }

  override *values(): MapIterator<V> {
    for (const v of super.values()) {
      this.onVisit();
      yield v;
    }
  }

  override *entries(): MapIterator<[K, V]> {
    for (const entry of super.entries()) {
      this.onVisit();
      yield entry;
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  override forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of super.entries()) {
      this.onVisit();
      callbackfn.call(thisArg, v, k, this);
    }
  }
}

function planHeapClass<
  T extends HeapSortable & { readonly ref: RetentionRef; readonly open: boolean },
>(
  heap: IndexedMinHeap<T>,
  itemBytes: (item: T) => number,
  totalBytes: number,
  cap: number,
  maxAgeDays: number,
  now: EpochMs,
  isPinned: (ref: RetentionRef) => boolean,
): RetentionStep[] {
  const steps: RetentionStep[] = [];
  const popped: T[] = [];
  const kept: T[] = [];
  const maxAgeMs = maxAgeDays * DAY_MS;
  let total = totalBytes;

  while (true) {
    const top = heap.peek();
    if (top === undefined || now - top.newestAt <= maxAgeMs) break;
    heap.pop();
    popped.push(top);
    if (!top.open && !isPinned(top.ref)) {
      steps.push({ kind: "delete", ref: top.ref, why: "age" });
      total -= itemBytes(top);
    } else {
      kept.push(top);
    }
  }

  if (total > cap) {
    let hitBlocker = false;
    for (const f of kept) {
      if (total <= cap) break;
      if (isPinned(f.ref)) {
        steps.push({ kind: "blocked-by-pin", ref: f.ref, overBy: (total - cap) as ByteCount });
        hitBlocker = true;
        break;
      }
      steps.push({ kind: "rotate", ref: f.ref });
      hitBlocker = true;
      break;
    }
    if (!hitBlocker) {
      while (total > cap) {
        const f = heap.peek();
        if (f === undefined) break;
        heap.pop();
        popped.push(f);
        if (isPinned(f.ref)) {
          steps.push({ kind: "blocked-by-pin", ref: f.ref, overBy: (total - cap) as ByteCount });
          break;
        }
        if (f.open) {
          steps.push({ kind: "rotate", ref: f.ref });
          break;
        }
        steps.push({ kind: "delete", ref: f.ref, why: "size" });
        total -= itemBytes(f);
      }
    }
  }

  for (let i = popped.length - 1; i >= 0; i -= 1) {
    heap.push(popped[i]!);
  }
  return steps;
}

export interface MaintenanceWorkMetrics {
  readonly flushCalls: number;
  readonly flushPasses: number;
  readonly flushDeletes: number;
  readonly flushRotates: number;
  readonly flushTouched: number;
  readonly flushMaxTouched: number;
  readonly flushMaxDeletes: number;
  readonly flushMaxRotates: number;
  readonly chunkCalls: number;
  readonly chunkDeletes: number;
  readonly chunkTouched: number;
  readonly chunkMaxTouched: number;
  readonly chunkMaxDeletes: number;
  readonly inventorySize: number;
}

export interface StartupGateMetrics {
  readonly gateStartedShut: boolean;
  readonly scanCompleted: boolean;
  readonly scanTimedOut: boolean;
  readonly initiallyTrusted: boolean;
  readonly downgraded: boolean;
  readonly preScanFileBytes: number;
  readonly preScanOpenParts: number;
  readonly postDowngradeFileBytes: number;
  readonly postDowngradeOpenParts: number;
}

export interface PersistedUsage {
  readonly bodyBytes: number;
  readonly detailBytes: number;
  readonly bodyCount?: number;
  readonly detailCount?: number;
}

export interface Maintenance {
  beginStartup(): void;
  loadFromDisk(
    activity: ActivityIndex,
    settings: UserSettings,
    rotate: (ref: RetentionRef) => Promise<boolean>,
  ): Promise<readonly RetentionStep[]>;
  isReady(): boolean;
  isScanCompleted(): boolean;
  needsStartupBuffer(settings: UserSettings, expectedBytes?: number | null): boolean;
  onReady(listener: () => void): () => void;
  onScanComplete(listener: () => void): () => void;
  unreadableEntries(): number;
  scanTimedOut(): boolean;
  ledgerSnapshot(): {
    readonly bodyBytes: ByteCount;
    readonly detailBytes: ByteCount;
    readonly bodyCount: number;
    readonly detailCount: number;
  };
  workMetrics(): MaintenanceWorkMetrics;
  resetWorkMetrics(): void;
  startupGateMetrics(): StartupGateMetrics;
  recordPackWrite(
    pack: PackId,
    path: string,
    siteDir: SiteDir,
    addedBytes: number,
    now: EpochMs,
    open: boolean,
  ): void;
  markPackClosed(pack: PackId): boolean;
  trackPart(id: ExchangeId, path: string, expectedBytes?: number): void;
  updatePart(id: ExchangeId, bytes: number, settings: UserSettings, capped?: boolean): boolean;
  untrackPart(id: ExchangeId): void;
  partBudget(id: ExchangeId, routeCap: number, settings: UserSettings): number;
  recordBodyFile(site: Site, id: ExchangeId, path: string, bytes: number, now: EpochMs): void;
  /** Reserves bytes in `bodyBytes` while an async stream append is queued/writing, until released on commit or error. */
  reserveWrite(bytes: number): () => void;
  recordSegmentWrite(
    segment: LogSegmentId,
    logPath: string,
    summaryPath: string,
    siteDir: SiteDir,
    addedBytes: number,
    now: EpochMs,
    open: boolean,
  ): void;
  recordSegmentSealed(
    segment: LogSegmentId,
    summaryBytes: number,
    lastStartedAt: EpochMs | null,
    now: EpochMs,
  ): void;
  forgetSite(site: Site): void;
  isOverCap(settings: UserSettings, reserveBytes?: number): boolean;
  needsRetentionDrain(settings: UserSettings): boolean;
  retain(
    settings: UserSettings,
    rotate: (ref: RetentionRef) => Promise<boolean>,
    reserveBytes?: number,
  ): Promise<readonly RetentionStep[]>;
  pin(targets: PinTargets, onRelease?: () => void): PinHandle;
  pinOldestPack(onRelease?: () => void): { readonly pinId: string; readonly pack: PackId } | null;
  unpin(pinId: string): boolean;
  usage(): { readonly bodyBytes: ByteCount; readonly detailBytes: ByteCount };
  blockedOverBy(): ByteCount | null;
}

export function createMaintenance(options: {
  readonly root: SafeFolder;
  readonly onSegmentRemoved: (segment: LogSegmentId) => void;
  readonly waitUntilLoaded?: boolean;
  readonly persistedUsage?: PersistedUsage | null;
  readonly initialMaxBodyBytes?: number;
  readonly scanTimeoutMs?: number;
  readonly scanDelayMs?: number;
  readonly timers?: Pick<Timers, "once">;
  readonly countWork?: boolean;
}): Maintenance {
  const { root, onSegmentRemoved } = options;
  const waitUntilLoaded = options.waitUntilLoaded ?? false;
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const counting = options.countWork ?? false;
  let opsCount = 0;
  const tickOp = (): void => {
    opsCount += 1;
  };
  let flushCalls = 0;
  let flushPasses = 0;
  let flushDeletes = 0;
  let flushRotates = 0;
  let flushTouched = 0;
  let flushMaxTouched = 0;
  let flushMaxDeletes = 0;
  let flushMaxRotates = 0;
  let chunkCalls = 0;
  let chunkDeletes = 0;
  let chunkTouched = 0;
  let chunkMaxTouched = 0;
  let chunkMaxDeletes = 0;
  let maxInventorySize = 0;
  const bodies = counting
    ? new CountingMap<string, TrackedBody>(tickOp)
    : new Map<string, TrackedBody>();
  const bodyHeap = new IndexedMinHeap<TrackedBody>(counting ? tickOp : undefined);
  const parts = new Map<ExchangeId, TrackedPart>();
  const preScanReserved = new Map<ExchangeId, number>();
  const partExpectedReserved = new Map<ExchangeId, number>();
  const details = counting
    ? new CountingMap<string, TrackedDetail>(tickOp)
    : new Map<string, TrackedDetail>();
  const detailHeap = new IndexedMinHeap<TrackedDetail>(counting ? tickOp : undefined);
  const pinnedPacks = new Map<PackId, number>();
  const pinnedBodies = new Map<ExchangeId, number>();
  const pinnedSegments = new Map<LogSegmentId, number>();
  const activePins = new Map<string, PinHandle>();
  const readyListeners = new Set<() => void>();
  const scanListeners = new Set<() => void>();
  let ready = !waitUntilLoaded;
  let scanCompleted = !waitUntilLoaded;
  const persisted = options.persistedUsage ?? null;
  const gateStartedShut = waitUntilLoaded;
  const initiallyTrusted = waitUntilLoaded && persisted !== null;
  let ledgerTrust = initiallyTrusted;
  let downgraded = false;
  let timedOut = false;
  let directPreScanBytes = 0;
  let preScanPartReservedBytes = 0;
  let partExpectedBytes = 0;
  let preScanFileBytes = 0;
  let preScanOpenParts = 0;
  let postDowngradeFileBytes = 0;
  let postDowngradeOpenParts = 0;
  let unreadableCount = 0;
  let scanTimer: { cancel(): void } | null = null;
  let nextPinSeq = 0;
  let bodyBytes = waitUntilLoaded
    ? (options.persistedUsage?.bodyBytes ?? options.initialMaxBodyBytes ?? 0)
    : 0;
  let partBytes = 0;
  let pendingWriteBytes = 0;
  let detailBytes = waitUntilLoaded ? (options.persistedUsage?.detailBytes ?? 0) : 0;
  let blockedByPin: ByteCount | null = null;
  let lockAnchor: TrackedBody | null = null;
  let lockedBytes = 0;

  const scheduleOnce = (ms: number, fire: () => void): { cancel(): void } => {
    if (options.timers !== undefined) return options.timers.once(ms, fire);
    const gt = globalThis as {
      readonly setTimeout?: (cb: () => void, delay: number) => unknown;
      readonly clearTimeout?: (id: unknown) => void;
    };
    const id = gt.setTimeout?.(fire, ms);
    return { cancel: () => gt.clearTimeout?.(id) };
  };

  const openGate = (): void => {
    if (scanTimer !== null) {
      scanTimer.cancel();
      scanTimer = null;
    }
    if (ready) return;
    ready = true;
    for (const listener of readyListeners) {
      readyListeners.delete(listener);
      try {
        listener();
      } catch {
        // One listener failing must never block remaining startup streams from draining.
      }
    }
  };

  const armTimeout = (): void => {
    if (ready || scanTimer !== null) return;
    scanTimer = scheduleOnce(scanTimeoutMs, () => {
      scanTimer = null;
      timedOut = true;
      ledgerTrust = false;
      const unknownFloor = options.initialMaxBodyBytes ?? 0;
      if (bodyBytes < unknownFloor + partBytes) {
        bodyBytes = unknownFloor + partBytes;
      }
      openGate();
    });
  };

  const notifyScanComplete = (): void => {
    for (const listener of scanListeners) {
      scanListeners.delete(listener);
      try {
        listener();
      } catch {
        // One listener failing must never block remaining startup streams from draining.
      }
    }
  };

  const unprovenBatchCap = (settings: UserSettings): number =>
    Math.min(STARTUP_DIRECT_MARGIN_CAP, Math.floor(settings.retention.maxBodyBytes / 4));

  const remainingBatchBudget = (settings: UserSettings): number =>
    Math.max(
      0,
      unprovenBatchCap(settings) - partBytes - preScanPartReservedBytes - directPreScanBytes,
    );

  const needsBuffer = (settings: UserSettings, expectedBytes?: number | null): boolean => {
    if (ready) return false;
    const margin = unprovenBatchCap(settings);
    if (bodyBytes + margin >= settings.retention.maxBodyBytes) return true;
    if (!scanCompleted) {
      if (expectedBytes === undefined || expectedBytes === null) return true;
      if (expectedBytes > remainingBatchBudget(settings)) return true;
    }
    return false;
  };

  const isPinned = (ref: RetentionRef): boolean =>
    ref.kind === "pack"
      ? (pinnedPacks.get(ref.pack) ?? 0) > 0
      : ref.kind === "body-file"
        ? (pinnedBodies.get(ref.id) ?? 0) > 0
        : (pinnedSegments.get(ref.segment) ?? 0) > 0;

  const refreshPinLock = (): void => {
    if (pinnedPacks.size === 0 && pinnedBodies.size === 0) {
      lockAnchor = null;
      lockedBytes = 0;
      return;
    }
    let oldestPin: TrackedBody | null = null;
    for (const item of bodies.values()) {
      if (!isPinned(item.ref)) continue;
      if (oldestPin === null || oldestFirst(item, oldestPin) < 0) oldestPin = item;
    }
    lockAnchor = oldestPin;
    if (oldestPin === null) {
      lockedBytes = 0;
      return;
    }
    let sum = 0;
    for (const item of bodies.values()) {
      if (oldestFirst(item, oldestPin) >= 0) sum += item.bytes;
    }
    lockedBytes = sum;
  };

  const insertNewBody = (item: TrackedBody): void => {
    bodies.set(item.key, item);
    bodyHeap.push(item);
    bodyBytes += item.bytes;
    if (isPinned(item.ref)) {
      if (lockAnchor === null || oldestFirst(item, lockAnchor) < 0) {
        refreshPinLock();
      } else {
        lockedBytes += item.bytes;
      }
    } else if (lockAnchor !== null && oldestFirst(item, lockAnchor) >= 0) {
      lockedBytes += item.bytes;
    }
  };

  const removeTrackedBody = (item: TrackedBody): void => {
    if (!bodies.delete(item.key)) return;
    bodyHeap.remove(item);
    bodyBytes = Math.max(0, bodyBytes - item.bytes);
    if (item === lockAnchor) {
      refreshPinLock();
    } else if (lockAnchor !== null && oldestFirst(item, lockAnchor) >= 0) {
      lockedBytes = Math.max(0, lockedBytes - item.bytes);
    }
  };

  const adjustReserved = (
    map: Map<ExchangeId, number>,
    currentTotal: number,
    id: ExchangeId,
    oldBytes: number,
    newBytes: number,
    remove: boolean,
  ): number => {
    const reserved = map.get(id);
    if (reserved === undefined) return currentTotal;
    if (remove) map.delete(id);
    const prevLeft = Math.max(0, reserved - oldBytes);
    const nextLeft = remove ? 0 : Math.max(0, reserved - newBytes);
    return Math.max(0, currentTotal - prevLeft + nextLeft);
  };

  const recomputeTotals = (): void => {
    let b = 0;
    for (const item of bodies.values()) b += item.bytes;
    let p = 0;
    for (const part of parts.values()) p += part.bytes;
    partBytes = p;
    bodyBytes = b + p + pendingWriteBytes;
    let d = 0;
    for (const item of details.values()) d += item.logBytes + item.summaryBytes;
    detailBytes = d;
  };

  const addRef = <K>(map: Map<K, number>, key: K, delta: 1 | -1): void => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const deleteRef = async (ref: RetentionRef): Promise<number> => {
    const key = refKey(ref);
    if (ref.kind === "segment") {
      const entry = details.get(key);
      if (entry === undefined) return 0;
      await IOUtils.remove(entry.logPath, { ignoreAbsent: true });
      await IOUtils.remove(entry.summaryPath, { ignoreAbsent: true });
      const opStart = opsCount;
      if (!details.delete(key)) return opsCount - opStart;
      detailHeap.remove(entry);
      detailBytes = Math.max(0, detailBytes - (entry.logBytes + entry.summaryBytes));
      onSegmentRemoved(ref.segment);
      return opsCount - opStart;
    }
    const entry = bodies.get(key);
    if (entry === undefined) return 0;
    await IOUtils.remove(entry.path, { ignoreAbsent: true });
    const opStart = opsCount;
    removeTrackedBody(entry);
    return opsCount - opStart;
  };

  const retain: Maintenance["retain"] = async (settings, rotate, reserveBytes = 0) => {
    flushCalls += 1;
    maxInventorySize = Math.max(maxInventorySize, bodies.size + details.size);
    const executed: RetentionStep[] = [];
    const limit = bodies.size + details.size + 2;
    for (let pass = 0; pass < limit; pass += 1) {
      flushPasses += 1;
      const syncStart = opsCount;
      const now = Date.now() as EpochMs;
      const bodySteps = planHeapClass(
        bodyHeap,
        (item) => item.bytes,
        Math.max(0, bodyBytes - partBytes),
        Math.max(0, settings.retention.maxBodyBytes - partBytes - partExpectedBytes - reserveBytes),
        settings.retention.maxAgeDays,
        now,
        isPinned,
      );
      const detailSteps = planHeapClass(
        detailHeap,
        (item) => item.logBytes + item.summaryBytes,
        detailBytes,
        settings.retention.maxDetailBytes,
        settings.retention.maxAgeDays,
        now,
        isPinned,
      );
      const steps = [...bodySteps, ...detailSteps];
      let overBy: ByteCount | null = null;
      for (const step of steps) {
        if (step.kind === "blocked-by-pin") {
          overBy = overBy === null || step.overBy > overBy ? step.overBy : overBy;
        }
      }
      blockedByPin = overBy;
      const deletes = steps.filter((s) => s.kind === "delete");
      const rotates = steps.filter((s) => s.kind === "rotate");
      let passTouched = opsCount - syncStart;
      const deleteWork = await Promise.all(deletes.map((step) => deleteRef(step.ref)));
      for (const w of deleteWork) passTouched += w;
      flushTouched += passTouched;
      flushDeletes += deletes.length;
      flushRotates += rotates.length;
      if (passTouched > flushMaxTouched) {
        flushMaxTouched = passTouched;
        flushMaxDeletes = deletes.length;
        flushMaxRotates = rotates.length;
      }
      executed.push(...deletes);
      if (rotates.length === 0) {
        for (const step of steps) {
          if (step.kind === "blocked-by-pin") executed.push(step);
        }
        break;
      }
      let rotatedAny = false;
      for (const step of rotates) {
        executed.push(step);
        if (await rotate(step.ref)) rotatedAny = true;
      }
      if (!rotatedAny) break;
    }
    return executed;
  };

  const pin: Maintenance["pin"] = (targets, onRelease) => {
    const packs = [...new Set(targets.packs ?? [])];
    const bodyFiles = [...new Set(targets.bodyFiles ?? [])];
    const segments = [...new Set(targets.segments ?? [])];
    for (const p of packs) addRef(pinnedPacks, p, 1);
    for (const b of bodyFiles) addRef(pinnedBodies, b, 1);
    for (const s of segments) addRef(pinnedSegments, s, 1);
    refreshPinLock();
    const id = `pin-${String(++nextPinSeq)}`;
    let released = false;
    const handle: PinHandle = {
      id,
      release: () => {
        if (released) return;
        released = true;
        activePins.delete(id);
        for (const p of packs) addRef(pinnedPacks, p, -1);
        for (const b of bodyFiles) addRef(pinnedBodies, b, -1);
        for (const s of segments) addRef(pinnedSegments, s, -1);
        refreshPinLock();
        onRelease?.();
      },
    };
    activePins.set(id, handle);
    return handle;
  };

  return {
    beginStartup: () => {
      armTimeout();
    },
    isReady: () => ready,
    isScanCompleted: () => scanCompleted,
    needsStartupBuffer: needsBuffer,
    onReady: (listener) => {
      if (ready) {
        listener();
        return () => undefined;
      }
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onScanComplete: (listener) => {
      if (scanCompleted) {
        listener();
        return () => undefined;
      }
      scanListeners.add(listener);
      return () => {
        scanListeners.delete(listener);
      };
    },
    unreadableEntries: () => unreadableCount,
    scanTimedOut: () => timedOut,
    ledgerSnapshot: () => ({
      bodyBytes: Math.max(0, bodyBytes - partBytes - pendingWriteBytes) as ByteCount,
      detailBytes: detailBytes as ByteCount,
      bodyCount: bodies.size,
      detailCount: details.size,
    }),
    workMetrics: () => ({
      flushCalls,
      flushPasses,
      flushDeletes,
      flushRotates,
      flushTouched,
      flushMaxTouched,
      flushMaxDeletes,
      flushMaxRotates,
      chunkCalls,
      chunkDeletes,
      chunkTouched,
      chunkMaxTouched,
      chunkMaxDeletes,
      inventorySize: Math.max(maxInventorySize, bodies.size + details.size),
    }),
    resetWorkMetrics: () => {
      flushCalls = 0;
      flushPasses = 0;
      flushDeletes = 0;
      flushRotates = 0;
      flushTouched = 0;
      flushMaxTouched = 0;
      flushMaxDeletes = 0;
      flushMaxRotates = 0;
      chunkCalls = 0;
      chunkDeletes = 0;
      chunkTouched = 0;
      chunkMaxTouched = 0;
      chunkMaxDeletes = 0;
      maxInventorySize = bodies.size + details.size;
    },
    startupGateMetrics: () => ({
      gateStartedShut,
      scanCompleted,
      scanTimedOut: timedOut,
      initiallyTrusted,
      downgraded,
      preScanFileBytes,
      preScanOpenParts,
      postDowngradeFileBytes,
      postDowngradeOpenParts,
    }),
    loadFromDisk: async (activity, settings, rotate) => {
      if (waitUntilLoaded) armTimeout();
      try {
        const scannedBodies = new Map<string, TrackedBody>();
        const logs = new Map<
          LogSegmentId,
          {
            readonly logPath: string;
            readonly siteDir: SiteDir;
            readonly bytes: number;
            readonly mtime: EpochMs;
          }
        >();
        const summaries = new Map<
          LogSegmentId,
          { readonly summaryPath: string; readonly bytes: number; readonly raw: string | null }
        >();

        const listed = await listFilesSafe(root);
        let scannedUnreadable = listed.unreadable;
        const parsed: {
          readonly path: string;
          readonly name: ArchiveName;
        }[] = [];
        for (const path of listed.files) {
          const name = parseArchiveName(relative(root, path));
          if (name !== null) parsed.push({ path, name });
        }

        let scannedBodyBytes = 0;
        let scannedBodyCount = 0;
        let scannedDetailBytes = 0;
        const delayMs = options.scanDelayMs ?? 0;
        const totalBatches = Math.ceil(parsed.length / STAT_BATCH_SIZE);
        const earlyDelayBatch = Math.floor(totalBatches * 0.1);
        const lateDelayBatch = Math.max(earlyDelayBatch + 1, Math.floor(totalBatches * 0.6));
        const earlyDelayMs = totalBatches <= 1 ? delayMs : Math.floor(delayMs * 0.25);
        const lateDelayMs = totalBatches <= 1 ? 0 : delayMs - earlyDelayMs;
        for (let i = 0; i < parsed.length; i += STAT_BATCH_SIZE) {
          const batchIdx = Math.floor(i / STAT_BATCH_SIZE);
          const chunk = parsed.slice(i, i + STAT_BATCH_SIZE);
          await Promise.all(
            chunk.map(async ({ path, name }) => {
              if (name.kind === "pack") {
                const stat = await statMtime(path);
                if (stat === null) {
                  scannedUnreadable += 1;
                  return;
                }
                scannedBodyBytes += stat.bytes;
                scannedBodyCount += 1;
                const ref = { kind: "pack", pack: name.pack } as const;
                const key = refKey(ref);
                scannedBodies.set(key, {
                  key,
                  sortName: refSortName(ref),
                  ref,
                  path,
                  siteDir: name.dir,
                  bytes: stat.bytes,
                  newestAt: stat.mtime,
                  open: false,
                  heapIndex: -1,
                });
              } else if (name.kind === "body") {
                const stat = await statMtime(path);
                if (stat === null) {
                  scannedUnreadable += 1;
                  return;
                }
                scannedBodyBytes += stat.bytes;
                scannedBodyCount += 1;
                // A >64-char cut dir cannot round-trip via parseSiteDir; ref.site only breaks ties in refSortName.
                const site = parseSiteDir(name.dir) ?? (name.dir as unknown as Site);
                const ref = { kind: "body-file", site, id: name.id } as const;
                const key = refKey(ref);
                scannedBodies.set(key, {
                  key,
                  sortName: refSortName(ref),
                  ref,
                  path,
                  siteDir: name.dir,
                  bytes: stat.bytes,
                  newestAt: stat.mtime,
                  open: false,
                  heapIndex: -1,
                });
              } else if (name.kind === "log") {
                const stat = await statMtime(path);
                if (stat === null) {
                  scannedUnreadable += 1;
                  return;
                }
                scannedDetailBytes += stat.bytes;
                logs.set(name.segment, {
                  logPath: path,
                  siteDir: name.dir,
                  bytes: stat.bytes,
                  mtime: stat.mtime,
                });
              } else if (name.kind === "summary") {
                const stat = await statMtime(path);
                if (stat === null) {
                  scannedUnreadable += 1;
                  return;
                }
                scannedDetailBytes += stat.bytes;
                summaries.set(name.segment, {
                  summaryPath: path,
                  bytes: stat.bytes,
                  raw: await readUtf8OrNull(path),
                });
              }
            }),
          );
          // Any persisted total understated relative to files found so far loses trust immediately.
          if (
            ledgerTrust &&
            persisted !== null &&
            (scannedBodyBytes > persisted.bodyBytes ||
              (persisted.bodyCount !== undefined && scannedBodyCount > persisted.bodyCount) ||
              scannedDetailBytes > persisted.detailBytes)
          ) {
            ledgerTrust = false;
            downgraded = true;
            const unknownFloor = Math.max(options.initialMaxBodyBytes ?? 0, scannedBodyBytes);
            if (bodyBytes < unknownFloor + partBytes) {
              bodyBytes = unknownFloor + partBytes;
            }
          }
          if (delayMs > 0) {
            const batchPause =
              batchIdx === earlyDelayBatch
                ? earlyDelayMs
                : batchIdx === lateDelayBatch
                  ? lateDelayMs
                  : 0;
            if (batchPause > 0) {
              await new Promise<void>((resolve) => {
                scheduleOnce(batchPause, resolve);
              });
            }
          }
        }

        if (delayMs > 0 && totalBatches === 0) {
          await new Promise<void>((resolve) => {
            scheduleOnce(delayMs, resolve);
          });
        }

        const scannedDetails = new Map<string, TrackedDetail>();
        for (const [segment, log] of logs) {
          const summaryInfo = summaries.get(segment);
          const decoded =
            summaryInfo !== undefined && summaryInfo.raw !== null
              ? decodeSummary(summaryInfo.raw, log.bytes as ByteCount)
              : null;
          if (decoded !== null) {
            applyActivity(activity, { kind: "segment-summarized", summary: decoded });
          }
          const ref = { kind: "segment", segment } as const;
          const key = refKey(ref);
          scannedDetails.set(key, {
            key,
            sortName: refSortName(ref),
            ref,
            logPath: log.logPath,
            summaryPath:
              summaryInfo?.summaryPath ?? PathUtils.join(root, ...logSummaryPath(segment)),
            siteDir: log.siteDir,
            logBytes: log.bytes,
            summaryBytes: summaryInfo?.bytes ?? 0,
            newestAt: decoded?.lastStartedAt ?? log.mtime,
            open: false,
            heapIndex: -1,
          });
        }

        // Preserve any entries written after a scan timeout opened the gate before the scan landed.
        for (const [key, item] of scannedBodies) {
          if (!bodies.has(key)) bodies.set(key, item);
        }
        for (const [key, item] of scannedDetails) {
          if (!details.has(key)) details.set(key, item);
        }
        unreadableCount = scannedUnreadable;
        bodyHeap.rebuild(bodies.values());
        detailHeap.rebuild(details.values());
        maxInventorySize = Math.max(maxInventorySize, bodies.size + details.size);
        recomputeTotals();
        refreshPinLock();
        scanCompleted = true;
        ledgerTrust = true;
        const steps = await retain(settings, rotate);
        notifyScanComplete();
        return steps;
      } finally {
        openGate();
      }
    },

    recordPackWrite: (pack, path, siteDir, addedBytes, now, open) => {
      if (!scanCompleted && addedBytes > 0) {
        directPreScanBytes += addedBytes;
      }
      const ref = { kind: "pack", pack } as const;
      const key = refKey(ref);
      const existing = bodies.get(key);
      if (existing === undefined) {
        insertNewBody({
          key,
          sortName: refSortName(ref),
          ref,
          path,
          siteDir,
          bytes: addedBytes,
          newestAt: now,
          open,
          heapIndex: -1,
        });
        return;
      }
      const wasLocked = lockAnchor !== null && oldestFirst(existing, lockAnchor) >= 0;
      existing.bytes += addedBytes;
      existing.newestAt = now;
      existing.open = open;
      bodyHeap.update(existing);
      bodyBytes += addedBytes;
      if (lockAnchor !== null) {
        if (existing === lockAnchor) {
          refreshPinLock();
        } else {
          const nowLocked = oldestFirst(existing, lockAnchor) >= 0;
          if (wasLocked && nowLocked) lockedBytes += addedBytes;
          else if (wasLocked !== nowLocked) refreshPinLock();
        }
      }
    },

    markPackClosed: (pack) => {
      const existing = bodies.get(refKey({ kind: "pack", pack }));
      if (existing === undefined || !existing.open) return false;
      existing.open = false;
      return true;
    },

    trackPart: (id, path, expectedBytes) => {
      if (!parts.has(id)) {
        parts.set(id, { id, path, bytes: 0 });
        if (!scanCompleted) {
          preScanOpenParts += 1;
          if (downgraded) postDowngradeOpenParts += 1;
        }
        if (expectedBytes !== undefined && expectedBytes > 0) {
          if (!scanCompleted) {
            preScanReserved.set(id, expectedBytes);
            preScanPartReservedBytes += expectedBytes;
          } else {
            partExpectedReserved.set(id, expectedBytes);
            partExpectedBytes += expectedBytes;
          }
        }
      }
    },

    updatePart: (id, bytes, settings, capped = false) => {
      chunkCalls += 1;
      const syncStart = opsCount;
      try {
        const part = parts.get(id);
        if (part === undefined) return false;
        const oldBytes = part.bytes;
        const delta = bytes - oldBytes;
        part.bytes = bytes;
        partBytes = Math.max(0, partBytes + delta);
        bodyBytes = Math.max(0, bodyBytes + delta);
        if (!scanCompleted && delta > 0) {
          preScanFileBytes += delta;
          if (downgraded) postDowngradeFileBytes += delta;
        }
        preScanPartReservedBytes = adjustReserved(
          preScanReserved,
          preScanPartReservedBytes,
          id,
          oldBytes,
          bytes,
          false,
        );
        const expected = partExpectedReserved.get(id);
        partExpectedBytes = adjustReserved(
          partExpectedReserved,
          partExpectedBytes,
          id,
          oldBytes,
          bytes,
          capped || (expected !== undefined && bytes >= expected),
        );
        return (
          bodyBytes + partExpectedBytes > settings.retention.maxBodyBytes ||
          detailBytes > settings.retention.maxDetailBytes
        );
      } finally {
        const dt = opsCount - syncStart;
        chunkTouched += dt;
        if (dt > chunkMaxTouched) {
          chunkMaxTouched = dt;
          chunkMaxDeletes = 0;
        }
      }
    },

    untrackPart: (id) => {
      const part = parts.get(id);
      if (part === undefined) return;
      parts.delete(id);
      preScanPartReservedBytes = adjustReserved(
        preScanReserved,
        preScanPartReservedBytes,
        id,
        part.bytes,
        0,
        true,
      );
      partExpectedBytes = adjustReserved(
        partExpectedReserved,
        partExpectedBytes,
        id,
        part.bytes,
        0,
        true,
      );
      partBytes = Math.max(0, partBytes - part.bytes);
      bodyBytes = Math.max(0, bodyBytes - part.bytes);
    },

    partBudget: (id, routeCap, settings) => {
      chunkCalls += 1;
      const syncStart = opsCount;
      try {
        const otherParts = Math.max(0, partBytes - (parts.get(id)?.bytes ?? 0));
        let locked = lockedBytes;
        if (lockAnchor !== null) {
          const now = Date.now();
          const maxAgeMs = settings.retention.maxAgeDays * DAY_MS;
          if (now - lockAnchor.newestAt > maxAgeMs) {
            locked = 0;
            for (const item of bodies.values()) {
              if (oldestFirst(item, lockAnchor) < 0) continue;
              if (!item.open && !isPinned(item.ref) && now - item.newestAt > maxAgeMs) continue;
              locked += item.bytes;
            }
          }
        }
        if (!scanCompleted && (ready || downgraded || !needsBuffer(settings, 0))) {
          const ownPart = parts.get(id)?.bytes ?? 0;
          const committedOther = Math.max(
            locked + otherParts + pendingWriteBytes,
            Math.max(0, bodyBytes - ownPart),
          );
          const capRoom = Math.max(0, settings.retention.maxBodyBytes - committedOther);
          if (ledgerTrust && !ready) {
            const ownReserved = Math.max(0, (preScanReserved.get(id) ?? 0) - ownPart);
            const otherReserved = Math.max(0, preScanPartReservedBytes - ownReserved);
            const otherDirect = Math.max(0, otherParts + otherReserved + directPreScanBytes);
            const batchLeft = Math.max(0, unprovenBatchCap(settings) - otherDirect);
            return Math.min(routeCap, capRoom, batchLeft);
          }
          return Math.min(routeCap, capRoom);
        }
        return Math.min(
          routeCap,
          Math.max(0, settings.retention.maxBodyBytes - locked - otherParts - pendingWriteBytes),
        );
      } finally {
        const dt = opsCount - syncStart;
        chunkTouched += dt;
        if (dt > chunkMaxTouched) {
          chunkMaxTouched = dt;
          chunkMaxDeletes = 0;
        }
      }
    },

    recordBodyFile: (site, id, path, bytes, now) => {
      const part = parts.get(id);
      if (part !== undefined) {
        parts.delete(id);
        preScanPartReservedBytes = adjustReserved(
          preScanReserved,
          preScanPartReservedBytes,
          id,
          part.bytes,
          0,
          true,
        );
        partExpectedBytes = adjustReserved(
          partExpectedReserved,
          partExpectedBytes,
          id,
          part.bytes,
          0,
          true,
        );
        partBytes = Math.max(0, partBytes - part.bytes);
        bodyBytes = Math.max(0, bodyBytes - part.bytes);
      }
      if (!scanCompleted && bytes > 0) {
        directPreScanBytes += bytes;
      }
      const ref = { kind: "body-file", site, id } as const;
      const key = refKey(ref);
      const prev = bodies.get(key);
      if (prev !== undefined) removeTrackedBody(prev);
      insertNewBody({
        key,
        sortName: refSortName(ref),
        ref,
        path,
        siteDir: siteDirName(site),
        bytes,
        newestAt: now,
        open: false,
        heapIndex: -1,
      });
    },

    reserveWrite: (bytes) => {
      if (bytes <= 0) return () => undefined;
      pendingWriteBytes += bytes;
      bodyBytes += bytes;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        pendingWriteBytes = Math.max(0, pendingWriteBytes - bytes);
        bodyBytes = Math.max(0, bodyBytes - bytes);
      };
    },

    recordSegmentWrite: (segment, logPath, summaryPath, siteDir, addedBytes, now, open) => {
      const ref = { kind: "segment", segment } as const;
      const key = refKey(ref);
      const existing = details.get(key);
      if (existing === undefined) {
        const created: TrackedDetail = {
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
          heapIndex: -1,
        };
        details.set(key, created);
        detailHeap.push(created);
      } else {
        existing.logBytes += addedBytes;
        existing.newestAt = now;
        existing.open = open;
        detailHeap.update(existing);
      }
      detailBytes += addedBytes;
    },

    recordSegmentSealed: (segment, summaryBytes, lastStartedAt, now) => {
      const existing = details.get(refKey({ kind: "segment", segment }));
      if (existing === undefined) return;
      detailBytes = Math.max(0, detailBytes - existing.summaryBytes) + summaryBytes;
      existing.summaryBytes = summaryBytes;
      existing.newestAt = lastStartedAt ?? now;
      existing.open = false;
      detailHeap.update(existing);
    },

    forgetSite: (site) => {
      const dir = siteDirName(site);
      for (const [key, item] of bodies) {
        if (item.siteDir === dir) {
          bodies.delete(key);
          bodyHeap.remove(item);
        }
      }
      for (const [key, item] of details) {
        if (item.siteDir === dir) {
          details.delete(key);
          detailHeap.remove(item);
        }
      }
      recomputeTotals();
      refreshPinLock();
    },

    isOverCap: (settings, reserveBytes = 0) =>
      bodyBytes + partExpectedBytes + reserveBytes > settings.retention.maxBodyBytes ||
      detailBytes > settings.retention.maxDetailBytes,

    needsRetentionDrain: (settings) => {
      if (!scanCompleted || !ready) return false;
      if (bodyBytes + partExpectedBytes <= settings.retention.maxBodyBytes + DRAIN_MARGIN_BYTES) {
        return false;
      }
      if (partBytes + lockedBytes + pendingWriteBytes > settings.retention.maxBodyBytes)
        return false;
      const oldest = bodyHeap.peek();
      return oldest !== undefined && !isPinned(oldest.ref);
    },

    retain,
    pin,

    pinOldestPack: (onRelease) => {
      let oldest:
        | (TrackedBody & { readonly ref: { readonly kind: "pack"; readonly pack: PackId } })
        | null = null;
      for (const item of bodies.values()) {
        if (item.ref.kind !== "pack") continue;
        const packItem = item as TrackedBody & {
          readonly ref: { readonly kind: "pack"; readonly pack: PackId };
        };
        if (oldest === null || oldestFirst(packItem, oldest) < 0) oldest = packItem;
      }
      if (oldest === null) return null;
      const handle = pin({ packs: [oldest.ref.pack] }, onRelease);
      return { pinId: handle.id, pack: oldest.ref.pack };
    },

    unpin: (pinId) => {
      const handle = activePins.get(pinId);
      if (handle === undefined) return false;
      handle.release();
      return true;
    },

    usage: () => ({
      bodyBytes: bodyBytes as ByteCount,
      detailBytes: detailBytes as ByteCount,
    }),

    blockedOverBy: () => blockedByPin,
  };
}
