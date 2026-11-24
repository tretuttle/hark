// The archive's single writer: every write runs on one promise chain, so commits, seals and exclusions never
// interleave. The line is the commit point. A memory body's pack append resolves before its line is appended; a file
// body's part is renamed into bodies/ before its line joins a batch. No line points at bytes not yet written.

import { applyActivity, emptyActivity, type ActivityIndex } from "@hark/recording/activity";
import {
  settle,
  type AbandonedExchange,
  type BodyLocation,
  type SettledExchange,
  type SettleInput,
  type UnansweredExchange,
  type UploadOutcome,
} from "@hark/recording/exchange";
import type {
  ByteCount,
  EpochMs,
  ExchangeId,
  LogSegmentId,
  PackId,
  RunId,
  Site,
} from "@hark/recording/ids";
import {
  bodyFilePath,
  LAYOUT,
  LOG_SEAL_BYTES,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  PACK_PENDING_MAX,
  PACK_SEAL_BYTES,
  packId,
  packPath,
  partPath,
  ROTATE_IDLE_MS,
  siteDirName,
  type SafeFolder,
} from "@hark/recording/layout";
import { encodeLine, encodeSummary, summarize } from "@hark/recording/log";
import type { RetentionRef, RetentionStep } from "@hark/recording/retention";
import {
  applySettingChange,
  type ExportFolder,
  type SettingChange,
  type StoredSettings,
} from "@hark/recording/settings";
import {
  appendStreams,
  appendText,
  makeDirectory,
  type Modes,
  type Timers,
  writeAtomic,
} from "./gecko-io.ts";
import {
  createMaintenance,
  RETENTION_EVERY_MS,
  type MaintenanceWorkMetrics,
  type PersistedUsage,
  type PinHandle,
  type PinTargets,
  type StartupGateMetrics,
} from "./maintenance.ts";

/** Flush every second, or at once when a site's pending pack bytes reach the memory tee cutoff. */
const FLUSH_MS = 1_000;

/** Points the harness can park the write chain at, to kill the browser there. */
export const HOLD_POINTS = [
  "before-line-append",
  "summary-tmp-written",
  "exclusion-mid-delete",
] as const;
export type HoldPoint = (typeof HOLD_POINTS)[number];

/** What a copy left when its sink closed: a memory tee, a startup-buffered file body, or an on-disk part. */
export type CopiedBytes =
  | { readonly kind: "memory"; readonly stream: InputStream }
  | { readonly kind: "part"; readonly id: ExchangeId }
  | {
      readonly kind: "buffer";
      readonly id: ExchangeId;
      readonly stream: InputStream;
      readonly length: number;
    };

/** A request body read at examine, waiting for its range in the site's pack. */
export interface PendingUpload {
  readonly stream: InputStream;
  readonly length: ByteCount;
  readonly mimeType: string | null;
}

export interface AnsweredCommit {
  readonly site: Site | null;
  readonly input: SettleInput;
  readonly bytes: CopiedBytes | null;
  readonly upload: PendingUpload | null;
}

interface Segment {
  readonly id: LogSegmentId;
  readonly path: string;
  bytes: number;
  readonly exchanges: SettledExchange[];
}

interface PackRef {
  readonly id: PackId;
  readonly path: string;
  reserved: number;
}

interface SiteState {
  readonly site: Site;
  segmentSeq: number;
  /** Changed only on the write chain. */
  segment: Segment | null;
  packSeq: number;
  /** Reserved synchronously at commit, so offsets follow commit order. Null after an idle rotation. */
  pack: PackRef | null;
  streams: InputStream[];
  streamBytes: number;
  lines: string[];
  exchanges: SettledExchange[];
  lastCommitAt: number;
  open: boolean;
}

interface PendingBatch {
  readonly streams: InputStream[];
  readonly streamBytes: number;
  readonly lines: string[];
  readonly exchanges: SettledExchange[];
  readonly pack: PackRef | null;
}

export type StoreProblem =
  | { readonly kind: "write-failed"; readonly detail: string }
  | { readonly kind: "unreadable-entries"; readonly detail: string };

export interface Store {
  readonly run: RunId;
  readonly settings: () => StoredSettings;
  readonly activity: () => ActivityIndex;
  commit(commit: AnsweredCommit): void;
  commitUnanswered(site: Site | null, exchange: UnansweredExchange): void;
  /** Lines for captures still live at shutdown. Their parts stay for recovery to delete. */
  commitAbandoned(
    entries: readonly { readonly site: Site | null; readonly exchange: AbandonedExchange }[],
  ): void;
  /** Settings first, so the gate stops new captures; then, on the chain, the site's directory is deleted. */
  excludeSite(site: Site): Promise<void>;
  /** Records the site again from its next request. What was deleted when it was excluded stays deleted. */
  includeSite(site: Site): Promise<StoredSettings>;
  /**
   * Changes one editable setting, applied on the chain to the settings held then, or the export folder. The excluded
   * sites are not in it: excludeSite and includeSite own that list. Resolves once settings.json holds the change; a
   * failed write rejects and changes nothing.
   */
  updateSettings(change: {
    readonly setting?: SettingChange;
    readonly exportFolder?: ExportFolder;
  }): Promise<StoredSettings>;
  /** Appends every pending batch and resolves when the chain is empty. */
  flush(): Promise<void>;
  /** Seals every open segment now, as an idle rotation would. */
  sealAll(): Promise<void>;
  /** Runs `step` on the write chain, after everything queued before it. */
  enqueue(step: () => Promise<void>): Promise<void>;
  /** Loads existing summaries into the activity index and runs the first retention pass. */
  beginStartup(): void;
  initRetention(): Promise<readonly RetentionStep[]>;
  isReady(): boolean;
  isScanCompleted(): boolean;
  needsStartupBuffer(expectedBytes?: number | null): boolean;
  onReady(listener: () => void): () => void;
  onScanComplete(listener: () => void): () => void;
  unreadableEntries(): number;
  retain(): Promise<readonly RetentionStep[]>;
  openPart(id: ExchangeId, path: string, expectedBytes?: number): void;
  updatePart(id: ExchangeId, bytes: number, capped?: boolean): void;
  partBudget(id: ExchangeId, routeCap: number): number;
  reserveWrite(bytes: number): () => void;
  needsRetentionDrain(): boolean;
  onRetentionDrain(listener: () => void): () => void;
  pin(targets: PinTargets): PinHandle;
  pinOldestPack(): Promise<{ readonly pinId: string; readonly pack: PackId } | null>;
  unpin(pinId: string): Promise<boolean>;
  usage(): { readonly bodyBytes: ByteCount; readonly detailBytes: ByteCount };
  overCapWhileExporting(): boolean;
  workMetrics(): MaintenanceWorkMetrics;
  resetWorkMetrics(): void;
  startupGateMetrics(): StartupGateMetrics;
  close(): Promise<void>;
  readonly problems: () => readonly StoreProblem[];
  arm(point: HoldPoint): void;
  reached(point: HoldPoint): boolean;
}

/** Where a body would go, to ask settle whether it is kept before any bytes are placed. */
const PROBE: BodyLocation = { kind: "pack", pack: "" as PackId, offset: 0, length: 0 as ByteCount };

const withUpload = (input: SettleInput, upload: UploadOutcome): SettleInput =>
  input.sink === null
    ? { ...input, capture: { ...input.capture, upload } }
    : { ...input, capture: { ...input.capture, upload } };

export function openStore(options: {
  readonly run: RunId;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly settings: StoredSettings;
  readonly timers: Timers;
  readonly onSettings: (settings: StoredSettings) => void;
  readonly persistedUsage?: PersistedUsage | null;
  readonly scanTimeoutMs?: number;
  readonly scanDelayMs?: number;
  readonly countWork?: boolean;
}): Store {
  const { run, root, modes, timers } = options;
  let settings = options.settings;
  let chain: Promise<void> = Promise.resolve();
  const problems: StoreProblem[] = [];
  const sites = new Map<Site, SiteState>();
  const excluded = new Set<Site>(settings.user.excludedSites);
  const madeDirs = new Set<string>();
  const armed = new Set<HoldPoint>();
  const reachedPoints = new Set<HoldPoint>();
  const activity = emptyActivity(run);
  const drainListeners = new Set<() => void>();
  let retentionQueued = false;
  const maintenance = createMaintenance({
    root,
    onSegmentRemoved: (segment) => applyActivity(activity, { kind: "segment-removed", segment }),
    waitUntilLoaded: true,
    ...(options.persistedUsage === undefined ? {} : { persistedUsage: options.persistedUsage }),
    initialMaxBodyBytes: settings.user.retention.maxBodyBytes,
    ...(options.scanTimeoutMs === undefined ? {} : { scanTimeoutMs: options.scanTimeoutMs }),
    ...(options.scanDelayMs === undefined ? {} : { scanDelayMs: options.scanDelayMs }),
    timers,
    countWork: options.countWork ?? false,
  });
  let ticker: { cancel(): void } | null = null;
  let retentionTicker: { cancel(): void } | null = null;

  const at = (segments: readonly string[]): string => PathUtils.join(root, ...segments);
  const dirOf = (segments: readonly string[]): string => at(segments.slice(0, -1));

  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const next = chain.then(step).catch((error: unknown) => {
      problems.push({ kind: "write-failed", detail: String(error) });
    });
    chain = next;
    return next;
  };

  const hold = async (point: HoldPoint): Promise<void> => {
    if (!armed.has(point)) return;
    armed.delete(point);
    reachedPoints.add(point);
    await new Promise<never>(() => undefined);
  };

  const ensureDir = async (path: string): Promise<void> => {
    if (madeDirs.has(path)) return;
    await makeDirectory(path, modes);
    madeDirs.add(path);
  };

  const stateOf = (site: Site): SiteState => {
    const existing = sites.get(site);
    if (existing !== undefined) return existing;
    const created: SiteState = {
      site,
      segmentSeq: 0,
      segment: null,
      packSeq: 0,
      pack: null,
      streams: [],
      streamBytes: 0,
      lines: [],
      exchanges: [],
      lastCommitAt: 0,
      open: false,
    };
    sites.set(site, created);
    return created;
  };

  const takeBatch = (state: SiteState): PendingBatch => {
    const batch: PendingBatch = {
      streams: state.streams,
      streamBytes: state.streamBytes,
      lines: state.lines,
      exchanges: state.exchanges,
      pack: state.pack,
    };
    state.streams = [];
    state.streamBytes = 0;
    state.lines = [];
    state.exchanges = [];
    return batch;
  };

  const seal = async (state: SiteState): Promise<void> => {
    const segment = state.segment;
    if (segment === null) return;
    state.segment = null;
    const summary = summarize(
      segment.id,
      segment.exchanges.map((exchange) => ({ v: 2, exchange }) as const),
      segment.bytes as ByteCount,
    );
    const encoded = encodeSummary(summary);
    await writeAtomic(at(logSummaryPath(segment.id)), encoded, modes, () =>
      hold("summary-tmp-written"),
    );
    if (!excluded.has(state.site)) {
      applyActivity(activity, { kind: "segment-summarized", summary });
    }
    maintenance.recordSegmentSealed(
      segment.id,
      encoded.length,
      summary.lastStartedAt,
      Date.now() as EpochMs,
    );
  };

  const rotateFile = async (ref: RetentionRef): Promise<boolean> => {
    if (ref.kind === "pack") {
      for (const state of sites.values()) {
        if (state.pack?.id !== ref.pack) continue;
        const batch = takeBatch(state);
        state.pack = null;
        state.packSeq += 1;
        if (batch.streams.length > 0 || batch.lines.length > 0) {
          await writeBatch(state, batch, false, false);
        }
        maintenance.markPackClosed(ref.pack);
        return true;
      }
      return maintenance.markPackClosed(ref.pack);
    }
    if (ref.kind === "segment") {
      for (const state of sites.values()) {
        if (state.segment?.id !== ref.segment) continue;
        const batch = takeBatch(state);
        if (batch.streams.length > 0 || batch.lines.length > 0) {
          await writeBatch(state, batch, false, false);
        }
        await seal(state);
        return true;
      }
    }
    return false;
  };

  const notifyDrain = (): void => {
    if (drainListeners.size === 0) return;
    const listeners = [...drainListeners];
    drainListeners.clear();
    for (const listener of listeners) listener();
  };

  const runRetention = async (reserveBytes = 0): Promise<readonly RetentionStep[]> => {
    try {
      return await maintenance.retain(settings.user, rotateFile, reserveBytes);
    } finally {
      notifyDrain();
    }
  };

  /** On the chain. `settings` changes only after settings.json holds `next`, so a failed write changes nothing. */
  const saveSettings = async (next: StoredSettings): Promise<void> => {
    await writeAtomic(at([LAYOUT.settings]), JSON.stringify(next), modes);
    settings = next;
    options.onSettings(next);
  };

  /** A settings change whose failure reaches the caller, not only the problem list. */
  const changeSettings = (
    make: (current: StoredSettings) => StoredSettings,
    applied: () => Promise<void> | void,
  ): Promise<StoredSettings> =>
    new Promise((resolve, reject) => {
      void enqueue(async () => {
        try {
          await saveSettings(make(settings));
          await applied();
          resolve(settings);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

  const scheduleRetention = (): void => {
    if (retentionQueued) return;
    retentionQueued = true;
    void enqueue(async () => {
      retentionQueued = false;
      await runRetention();
    });
  };

  const writeBatch = async (
    state: SiteState,
    batch: PendingBatch,
    allowHold: boolean,
    allowRetention: boolean,
  ): Promise<void> => {
    if (excluded.has(state.site)) return;
    const now = Date.now() as EpochMs;
    const hasPackWrite = batch.streams.length > 0 && batch.pack !== null;
    const releaseWrite = hasPackWrite
      ? maintenance.reserveWrite(batch.streamBytes)
      : () => undefined;
    try {
      if (hasPackWrite && batch.pack !== null) {
        await ensureDir(dirOf(packPath(batch.pack.id)));
        if (allowRetention && maintenance.isOverCap(settings.user)) {
          await runRetention();
        }
        await appendStreams(batch.pack.path, batch.streams, modes);
        releaseWrite();
        maintenance.recordPackWrite(
          batch.pack.id,
          batch.pack.path,
          siteDirName(state.site),
          batch.streamBytes,
          now,
          state.pack?.id === batch.pack.id,
        );
      }
    } finally {
      releaseWrite();
    }
    if (allowHold) await hold("before-line-append");
    let sealed = false;
    if (batch.lines.length > 0) {
      if (state.segment === null) {
        const id = logSegmentId(state.site, run, state.segmentSeq);
        state.segmentSeq += 1;
        state.segment = { id, path: at(logSegmentPath(id)), bytes: 0, exchanges: [] };
      }
      const segment = state.segment;
      const text = batch.lines.join("");
      await ensureDir(dirOf(logSegmentPath(segment.id)));
      await appendText(segment.path, text, modes);
      segment.bytes += text.length;
      segment.exchanges.push(...batch.exchanges);
      for (const exchange of batch.exchanges) {
        if (!excluded.has(state.site)) {
          applyActivity(activity, { kind: "settled", segment: segment.id, exchange });
        }
      }
      maintenance.recordSegmentWrite(
        segment.id,
        segment.path,
        at(logSummaryPath(segment.id)),
        siteDirName(state.site),
        text.length,
        now,
        true,
      );
      if (segment.bytes >= LOG_SEAL_BYTES) {
        await seal(state);
        sealed = true;
      }
    }
    if (allowRetention && (sealed || maintenance.isOverCap(settings.user))) {
      await runRetention();
    } else {
      notifyDrain();
    }
  };

  const flushSite = (state: SiteState): void => {
    if (state.streams.length === 0 && state.lines.length === 0) return;
    const batch = takeBatch(state);
    void enqueue(() => writeBatch(state, batch, true, true));
  };

  const tick = (): void => {
    const now = Date.now();
    let busy = false;
    for (const state of sites.values()) {
      if (state.streams.length > 0 || state.lines.length > 0) {
        flushSite(state);
        busy = true;
      } else if (state.open && now - state.lastCommitAt >= ROTATE_IDLE_MS) {
        const closedPack = state.pack?.id ?? null;
        state.open = false;
        state.pack = null;
        state.packSeq += 1;
        void enqueue(async () => {
          if (closedPack !== null) maintenance.markPackClosed(closedPack);
          await seal(state);
          await runRetention();
        });
      } else if (state.open) busy = true;
    }
    if (!busy && ticker !== null) {
      ticker.cancel();
      ticker = null;
    }
  };

  const queueLine = (state: SiteState, exchange: SettledExchange): void => {
    if (excluded.has(state.site)) return;
    state.lines.push(encodeLine({ v: 2, exchange }));
    state.exchanges.push(exchange);
    state.lastCommitAt = Date.now();
    state.open = true;
    ticker ??= timers.repeat(FLUSH_MS, tick);
  };

  /** Reserves `length` bytes at the end of the site's open pack. A full pack is flushed and the next one started. */
  const reserve = (state: SiteState, stream: InputStream, length: ByteCount): BodyLocation => {
    if (
      state.pack !== null &&
      state.pack.reserved > 0 &&
      state.pack.reserved + length > PACK_SEAL_BYTES
    ) {
      const closedPack = state.pack.id;
      const hadPendingStreams = state.streams.length > 0;
      flushSite(state);
      state.pack = null;
      state.packSeq += 1;
      if (!hadPendingStreams) {
        void enqueue(async () => {
          maintenance.markPackClosed(closedPack);
        });
      }
    }
    if (state.pack === null) {
      const id = packId(state.site, run, state.packSeq);
      state.pack = { id, path: at(packPath(id)), reserved: 0 };
    }
    const location: BodyLocation = {
      kind: "pack",
      pack: state.pack.id,
      offset: state.pack.reserved,
      length,
    };
    state.pack.reserved += length;
    state.streams.push(stream);
    state.streamBytes += length;
    return location;
  };

  const removePart = (id: ExchangeId): void => {
    maintenance.untrackPart(id);
    notifyDrain();
    void enqueue(async () => {
      await IOUtils.remove(at(partPath(id)), { ignoreAbsent: true });
      notifyDrain();
    });
  };

  const onPinRelease = (): void => {
    if (maintenance.isOverCap(settings.user) || maintenance.blockedOverBy() !== null) {
      void enqueue(async () => {
        await runRetention();
      });
    }
  };

  retentionTicker = timers.repeat(RETENTION_EVERY_MS, () => {
    void enqueue(async () => {
      await runRetention();
    });
  });

  const commit = ({ site, input, bytes, upload }: AnsweredCommit): void => {
    if (site === null || excluded.has(site)) {
      if (bytes?.kind === "part") removePart(bytes.id);
      return;
    }
    const state = stateOf(site);
    const settling =
      upload === null
        ? input
        : withUpload(input, {
            kind: "stored",
            at: reserve(state, upload.stream, upload.length),
            mimeType: upload.mimeType,
          });
    const length = (settling.sink?.kind === "closed" ? settling.sink.bytes : 0) as ByteCount;
    if (bytes === null || settle(settling, PROBE).body.kind !== "stored") {
      if (bytes?.kind === "part") removePart(bytes.id);
      queueLine(state, settle(settling, null));
    } else if (bytes.kind === "memory") {
      queueLine(state, settle(settling, reserve(state, bytes.stream, length)));
    } else if (bytes.kind === "buffer") {
      const settled = settle(settling, { kind: "file", site, id: bytes.id, length });
      void enqueue(async () => {
        if (excluded.has(site)) return;
        const releaseWrite = maintenance.reserveWrite(bytes.length);
        try {
          const target = bodyFilePath(site, bytes.id);
          await ensureDir(dirOf(target));
          if (maintenance.isOverCap(settings.user)) {
            await runRetention();
          }
          await appendStreams(at(target), [bytes.stream], modes);
          if (excluded.has(site)) {
            await IOUtils.remove(at(target), { ignoreAbsent: true });
            return;
          }
          releaseWrite();
          maintenance.recordBodyFile(site, bytes.id, at(target), length, Date.now() as EpochMs);
          queueLine(state, settled);
          if (maintenance.isOverCap(settings.user)) await runRetention();
        } finally {
          releaseWrite();
        }
      });
    } else {
      const settled = settle(settling, { kind: "file", site, id: bytes.id, length });
      void enqueue(async () => {
        if (excluded.has(site)) {
          maintenance.untrackPart(bytes.id);
          await IOUtils.remove(at(partPath(bytes.id)), { ignoreAbsent: true });
          return;
        }
        const target = bodyFilePath(site, bytes.id);
        await ensureDir(dirOf(target));
        await IOUtils.move(at(partPath(bytes.id)), at(target));
        if (excluded.has(site)) {
          maintenance.untrackPart(bytes.id);
          await IOUtils.remove(at(target), { ignoreAbsent: true });
          return;
        }
        maintenance.recordBodyFile(site, bytes.id, at(target), length, Date.now() as EpochMs);
        queueLine(state, settled);
        if (maintenance.isOverCap(settings.user)) await runRetention();
      });
    }
    if (state.streamBytes >= PACK_PENDING_MAX) flushSite(state);
  };

  const store: Store = {
    run,
    settings: () => settings,
    activity: () => activity,
    commit,
    commitUnanswered: (site, exchange) => {
      if (site === null || excluded.has(site)) return;
      queueLine(stateOf(site), exchange);
    },
    commitAbandoned: (entries) => {
      for (const { site, exchange } of entries) {
        if (site !== null && !excluded.has(site)) queueLine(stateOf(site), exchange);
      }
    },
    excludeSite: (site) => {
      if (excluded.has(site)) return enqueue(async () => undefined);
      excluded.add(site);
      sites.delete(site);
      applyActivity(activity, { kind: "site-forgotten", site });
      return enqueue(async () => {
        await saveSettings({
          ...settings,
          user: { ...settings.user, excludedSites: [...settings.user.excludedSites, site] },
        });
        const dir = at([LAYOUT.sitesDir, siteDirName(site)]);
        for (const [index, sub] of [LAYOUT.logDir, LAYOUT.packDir, LAYOUT.bodyDir].entries()) {
          await IOUtils.remove(PathUtils.join(dir, sub), { recursive: true, ignoreAbsent: true });
          if (index === 0) await hold("exclusion-mid-delete");
        }
        await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
        for (const made of madeDirs) if (made.startsWith(dir)) madeDirs.delete(made);
        maintenance.forgetSite(site);
        applyActivity(activity, { kind: "site-forgotten", site });
        notifyDrain();
      });
    },
    includeSite: (site) =>
      changeSettings(
        (current) => ({
          ...current,
          user: {
            ...current.user,
            excludedSites: current.user.excludedSites.filter((s) => s !== site),
          },
        }),
        () => {
          excluded.delete(site);
        },
      ),
    updateSettings: (change) =>
      changeSettings(
        (current) => {
          const user =
            change.setting === undefined
              ? current.user
              : applySettingChange(current.user, change.setting);
          if (user === null) throw new Error(`not a setting: ${JSON.stringify(change.setting)}`);
          return {
            user: { ...user, excludedSites: current.user.excludedSites },
            exportFolder: change.exportFolder ?? current.exportFolder,
          };
        },
        async () => {
          if (maintenance.isOverCap(settings.user)) await runRetention();
        },
      ),
    flush: async () => {
      for (const state of sites.values()) flushSite(state);
      await enqueue(async () => undefined);
      for (const state of sites.values()) flushSite(state);
      await enqueue(async () => undefined);
    },
    sealAll: () => {
      for (const state of sites.values()) {
        const closedPack = state.pack?.id ?? null;
        flushSite(state);
        state.open = false;
        state.pack = null;
        state.packSeq += 1;
        void enqueue(async () => {
          if (closedPack !== null) maintenance.markPackClosed(closedPack);
          await seal(state);
        });
      }
      return enqueue(async () => undefined);
    },
    enqueue,
    beginStartup: () => maintenance.beginStartup(),
    initRetention: async () => {
      const steps = await maintenance.loadFromDisk(activity, settings.user, rotateFile);
      const skipped = maintenance.unreadableEntries();
      if (skipped > 0) {
        problems.push({
          kind: "unreadable-entries",
          detail: `${String(skipped)} unreadable archive entries skipped during startup scan`,
        });
      }
      return steps;
    },
    isReady: () => maintenance.isReady(),
    isScanCompleted: () => maintenance.isScanCompleted(),
    needsStartupBuffer: (expectedBytes) =>
      maintenance.needsStartupBuffer(settings.user, expectedBytes),
    onReady: (listener) => maintenance.onReady(listener),
    onScanComplete: (listener) => maintenance.onScanComplete(listener),
    unreadableEntries: () => maintenance.unreadableEntries(),
    retain: async () => {
      let steps: readonly RetentionStep[] = [];
      await store.flush();
      await enqueue(async () => {
        steps = await runRetention();
      });
      return steps;
    },
    openPart: (id, path, expectedBytes) => {
      maintenance.trackPart(id, path, expectedBytes);
      if (maintenance.isScanCompleted() && maintenance.isOverCap(settings.user)) {
        scheduleRetention();
      }
    },
    updatePart: (id, bytes, capped) => {
      if (maintenance.updatePart(id, bytes, settings.user, capped)) scheduleRetention();
    },
    partBudget: (id, routeCap) => maintenance.partBudget(id, routeCap, settings.user),
    reserveWrite: (bytes) => maintenance.reserveWrite(bytes),
    needsRetentionDrain: () => maintenance.needsRetentionDrain(settings.user),
    onRetentionDrain: (listener) => {
      drainListeners.add(listener);
      scheduleRetention();
      return () => {
        drainListeners.delete(listener);
      };
    },
    pin: (targets) => maintenance.pin(targets, onPinRelease),
    pinOldestPack: async () => {
      await store.flush();
      let pinned: { readonly pinId: string; readonly pack: PackId } | null = null;
      await enqueue(async () => {
        pinned = maintenance.pinOldestPack(onPinRelease);
      });
      return pinned;
    },
    unpin: async (pinId) => {
      let released = false;
      await enqueue(async () => {
        released = maintenance.unpin(pinId);
        if (released) await runRetention();
      });
      return released;
    },
    usage: () => maintenance.usage(),
    overCapWhileExporting: () => maintenance.blockedOverBy() !== null,
    workMetrics: () => maintenance.workMetrics(),
    resetWorkMetrics: () => maintenance.resetWorkMetrics(),
    startupGateMetrics: () => maintenance.startupGateMetrics(),
    close: async () => {
      ticker?.cancel();
      ticker = null;
      retentionTicker?.cancel();
      retentionTicker = null;
      await store.sealAll();
      const snapshot = maintenance.ledgerSnapshot();
      const siteCount = await IOUtils.getChildren(at([LAYOUT.sitesDir])).then(
        (children) => children.length,
        () => 0,
      );
      await writeAtomic(
        at([LAYOUT.ledger]),
        JSON.stringify({
          version: 1,
          run,
          clean: true,
          bodyBytes: snapshot.bodyBytes,
          detailBytes: snapshot.detailBytes,
          bodyCount: snapshot.bodyCount,
          detailCount: snapshot.detailCount,
          siteCount,
        }),
        modes,
      ).catch(() => undefined);
    },
    problems: () => problems,
    arm: (point) => {
      armed.add(point);
    },
    reached: (point) => reachedPoints.has(point),
  };
  return store;
}
