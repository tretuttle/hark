// The experiment host: system principal, parent process. Tab ids from extension pages are looked up here and never
// throw; counts come from the activity index; an export reads the archive and writes one file through guardFolder.
// What returns to a page is counts, rows and job states. No path, body byte or HAR text crosses back.

import type {
  DevtoolsState,
  ExportId,
  ExportJob,
  ExportRequest,
  PopupTab,
  Preview,
} from "@hark/export/jobs";
import { runExport, WriteRefused } from "@hark/export/run";
import {
  inSelection,
  PRESETS,
  resolveSelection,
  type Selection,
  type SelectionContext,
} from "@hark/export/selection";
import type { BodyReader, ExchangeSource, SourceItem } from "@hark/export/source";
import { formatHarFilename } from "@hark/har/filename";
import {
  countWindows,
  currentRunKeys,
  firstMinuteOfTab,
  type ActivityIndex,
} from "@hark/recording/activity";
import type { LiveExchange } from "@hark/recording/exchange";
import {
  exchangeId,
  toMinute,
  type ByteCount,
  type EpochMs,
  type Minute,
  type RunId,
  type Site,
  type TabId,
  type TabKey,
} from "@hark/recording/ids";
import {
  ARCHIVE_ROOTS,
  guardFolder,
  LAYOUT,
  type ForbiddenRoots,
  type SafeFolder,
} from "@hark/recording/layout";
import type { StoredSettings } from "@hark/recording/settings";
import { archiveBodies, archiveSource, decodeContent, itemOf } from "./archive-source.ts";
import type { PopupTabArgument, PopupView, ToolboxState } from "./contract.ts";
import { createDevtoolsSource, toolboxOf } from "./devtools.ts";
import type { PinHandle, PinTargets } from "./maintenance.ts";
import {
  createPartSink,
  exportFiles,
  journalLine,
  type ExportPause,
  type ExportPlatform,
  type JournalEntry,
  type Part,
  type PartJournal,
} from "./export-file.ts";
import { createExportJobs, type ExportJobs, type RunOutcome } from "./export-jobs.ts";
import { forbiddenRoots, platform } from "./files.ts";
import type { WorkerArch, WorkerPlatform } from "./file-worker.ts";
import { holdFolderIn, type FaultFor } from "./held-folder.ts";
import {
  appendText,
  localFile,
  oneShot,
  pathState,
  randomBytes,
  readHead,
  sha256,
  siteOfUri,
  type Modes,
} from "./gecko-io.ts";

/** What the host reads from a running recording. null while the archive could not be opened. */
export interface RecordingReads {
  readonly run: RunId;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly activity: ActivityIndex;
  readonly settings: () => StoredSettings;
  /** Resolves when every line committed before the call is in a segment on disk. */
  readonly settle: () => Promise<void>;
  readonly enqueue: (task: () => Promise<void>) => Promise<void>;
  readonly pin: (targets: PinTargets) => PinHandle;
  readonly live: () => readonly { readonly site: Site | null; readonly live: LiveExchange }[];
  /** Startup recovery, which reads and then clears the export journal. */
  readonly recovered: Promise<unknown>;
}

type TabLookup =
  | {
      readonly kind: "tab";
      readonly tabId: TabId;
      readonly tab: NativeTab;
      readonly browserId: number;
      readonly private: boolean;
      readonly site: Site | null;
    }
  | { readonly kind: "no-such-tab" };

/**
 * `tabManager.get` throws an ExtensionError for tab 0, a closed tab, an unknown id and a private tab this add-on may
 * not see. That is one state, not an error.
 */
const lookupTab = (extension: ExtensionContext["extension"], tabId: TabId): TabLookup => {
  try {
    const tab = extension.tabManager.get(tabId).nativeTab;
    const browser = tab.linkedBrowser;
    return {
      kind: "tab",
      tabId,
      tab,
      browserId: browser.browserId,
      private: browser.browsingContext?.usePrivateBrowsing === true,
      site: siteOfUri(browser.currentURI),
    };
  } catch {
    return { kind: "no-such-tab" };
  }
};

const DEVTOOLS_STATES: { readonly [Reason: string]: DevtoolsState } = {
  "devtools-not-started": "not-started",
};

const devtoolsState = (toolbox: ToolboxState): DevtoolsState =>
  toolbox.open ? "open" : (DEVTOOLS_STATES[toolbox.reason] ?? "closed");

const gateOf = (
  found: TabLookup,
  settings: StoredSettings | null,
): "private-window" | "excluded-site" | null => {
  if (found.kind !== "tab") return null;
  if (found.private) return "private-window";
  const excluded = settings?.user.excludedSites ?? [];
  return found.site !== null && excluded.includes(found.site) ? "excluded-site" : null;
};

const localMidnight = (now: EpochMs): EpochMs => {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() as EpochMs;
};

const EMPTY_RECORDING_SOURCE: ExchangeSource = {
  name: "recording",
  list: async () => ({ items: [], notNetwork: {} }),
  load: async () => {
    throw new Error("the recording source is unavailable");
  },
};

const EMPTY_BODY_READER: BodyReader = {
  open: async () => ({ ok: false, reason: "source-error" }),
};

const combinedBodies = (stored: BodyReader, devtools: BodyReader): BodyReader => ({
  open: (source, chunkBytes, signal) =>
    source.kind === "stored"
      ? stored.open(source, chunkBytes, signal)
      : devtools.open(source, chunkBytes, signal),
});

const yieldNow = (): Promise<void> =>
  new Promise((resolve) => Services.tm.dispatchToMainThread(() => resolve()));

/**
 * How long one export file call may run before the export ends `timed-out`. A rename or a delete on a local disk takes
 * milliseconds; this leaves room for a slow network share.
 */
const EXPORT_STEP_MS = 15_000;

export const realPathOf = (path: string): string => {
  const file = localFile(path);
  file.normalize();
  return file.path;
};

/** Architectures file-worker.ts has the open flags for. */
const WORKER_ARCHES: { readonly [arch: string]: WorkerArch } = {
  "x86-64": "x86-64",
  aarch64: "aarch64",
};
const WORKER_PLATFORMS: { readonly [os: string]: WorkerPlatform } = {
  Linux: "linux",
  WINNT: "win",
  Darwin: "macosx",
};
/** Set only in a harness profile, beside `extensions.hark.harness`: exports name a part on Linux too. */
const NAMED_PARTS_PREF = "extensions.hark.harness.namedParts";

/**
 * Held-folder worker setup for Linux, Windows, and macOS. Non-Linux platforms (and Linux when the harness asks)
 * prefer named parts inside the held folder rather than unnamed files.
 */
const heldFolders = (
  workerUrl: string | null,
  modes: Modes,
  fault: FaultFor,
): Pick<ExportPlatform, "holdFolder" | "preferNamed"> => {
  const arch = WORKER_ARCHES[Services.sysinfo.getProperty("arch")];
  const workerPlatform = WORKER_PLATFORMS[Services.appinfo.OS];
  if (workerUrl === null || workerPlatform === undefined || arch === undefined) return {};
  const holdFolder = holdFolderIn(workerUrl, workerPlatform, arch, modes.file ?? 0o644, fault);
  if (workerPlatform !== "linux") return { holdFolder, preferNamed: "platform" };
  if (
    Services.prefs.getBoolPref("extensions.hark.harness", false) &&
    Services.prefs.getBoolPref(NAMED_PARTS_PREF, false)
  )
    return { holdFolder, preferNamed: "harness-pref" };
  return { holdFolder };
};

/**
 * Errors a harness profile arms through the harness topic for the next worker call of one kind, for the errnos no
 * file system here produces: the call answers the errno instead of running. Unarmed, every call runs.
 */
const exportFaults = () => {
  const armed = new Map<string, string>();
  return {
    take: ((op) => {
      const errno = armed.get(op) ?? null;
      armed.delete(op);
      return errno;
    }) satisfies FaultFor,
    arm: (op: string, errno: string): void => {
      armed.set(op, errno);
    },
  };
};

/** Points where a harness profile can hold an export, armed and let go through the harness topic. */
const exportPauses = () => {
  const armed = new Set<ExportPause>();
  const waiting = new Map<ExportPause, () => void>();
  return {
    pass: (point: ExportPause): Promise<void> => {
      if (!armed.delete(point)) return Promise.resolve();
      return new Promise((resolve) => waiting.set(point, resolve));
    },
    arm: (point: ExportPause): void => {
      armed.add(point);
    },
    reached: (point: ExportPause): boolean => waiting.has(point),
    release: (point: ExportPause): boolean => {
      const resolve = waiting.get(point);
      waiting.delete(point);
      resolve?.();
      return resolve !== undefined;
    },
  };
};

/** The only raw file calls an export makes outside the worker. `exportFiles` classifies whatever they throw. */
const geckoExportPlatform = (
  held: Pick<ExportPlatform, "holdFolder" | "preferNamed">,
): ExportPlatform => ({
  ...held,
  state: pathState,
  realPath: realPathOf,
  parent: (path) => PathUtils.parent(path),
  join: (folder, name) => PathUtils.join(folder, name),
  filename: (path) => PathUtils.filename(path),
  makeFolder: (folder) =>
    IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true }),
  readHead,
  freeBytes: (folder) => localFile(folder).diskSpaceAvailable,
  sha256,
});

/** Roots an export folder may not be in or contain, links resolved, since a folder is checked by its real path. */
export const realRoots = (archive: string | null): ForbiddenRoots => {
  const real = (path: string): string => {
    try {
      return realPathOf(path);
    } catch {
      return path;
    }
  };
  const roots = forbiddenRoots();
  return {
    profile: real(roots.profile),
    greDir: real(roots.greDir),
    appDir: real(roots.appDir),
    substitutions: [...roots.substitutions, ...(archive === null ? [] : [archive])].map(real),
  };
};

const SCOPE_NAMES = { tab: "tab", site: "site", everything: "all", sessions: "site" } as const;

let exportCounter = 0;

export function createGeckoHost(options: {
  readonly run: RunId;
  readonly reads: () => RecordingReads | null;
  readonly creator: { readonly name: string; readonly version: string };
  /** The add-on's own tab manager answers for every page. */
  readonly extension: ExtensionContext["extension"];
  /** file-worker.js as a resource URL a ChromeWorker can start from; null where it is not registered. */
  readonly workerUrl: string | null;
}) {
  const pauses = exportPauses();
  const faults = exportFaults();
  const { run: currentRun, reads, creator } = options;
  const finished = new Map<ExportId, string>();
  const pendingDevtools = new Map<ExportId, ReturnType<typeof makeDevtools>>();

  const lookup = (tabId: TabId): TabLookup => lookupTab(options.extension, tabId);
  const canAccessTab = (tab: NativeTab): boolean =>
    tab.linkedBrowser.browsingContext?.usePrivateBrowsing !== true ||
    options.extension.privateBrowsingAllowed === true;
  const makeDevtools = () =>
    createDevtoolsSource({
      run: currentRun,
      tabOf: (tabId) => {
        const found = lookup(tabId);
        return found.kind === "tab" ? found.tab : null;
      },
      canAccessTab,
    });

  /** Tab scope resolves the tab id to this run's TabKey once, here. */
  const selectionContext = async (
    rec: RecordingReads | null,
    selection: Selection,
    devtools: ReturnType<typeof makeDevtools>,
  ): Promise<SelectionContext> => {
    const now = Date.now() as EpochMs;
    const found = selection.scope === "tab" ? lookup(selection.tabId) : null;
    const tab: TabKey | null =
      found?.kind === "tab" ? { run: currentRun, browserId: found.browserId } : null;
    const devtoolsFirst =
      selection.scope === "tab" && selection.range.kind === "since-tab-opened"
        ? await devtools.firstMinute(selection.tabId)
        : null;
    return {
      now: toMinute(now),
      localMidnight: toMinute(localMidnight(now)),
      tab,
      tabFirstSeen: rec === null || tab === null ? null : firstMinuteOfTab(rec.activity, tab),
      devtoolsFirst,
    };
  };

  const preview = async (selection: Selection): Promise<Preview> => {
    const rec = reads();
    const gate =
      selection.scope === "tab" ? gateOf(lookup(selection.tabId), rec?.settings() ?? null) : null;
    if (rec !== null) await rec.settle();
    const devtools = makeDevtools();
    const resolved = resolveSelection(selection, await selectionContext(rec, selection, devtools));
    const dtListing = await devtools.source.list(resolved);
    const dtSeenKeys = new Set<string>();
    const dtUnique: SourceItem[] = [];
    for (const item of dtListing.items) {
      if (item.key === null) {
        dtUnique.push(item);
      } else if (!dtSeenKeys.has(item.key)) {
        dtSeenKeys.add(item.key);
        dtUnique.push(item);
      }
    }
    let dtFirst: Minute | null = null;
    for (const item of dtUnique) {
      if (dtFirst === null || item.startedMinute < dtFirst) dtFirst = item.startedMinute;
    }
    if (rec === null) {
      return {
        requests: dtUnique.length,
        sources: { both: 0, recordingOnly: 0, devtoolsOnly: dtUnique.length },
        bodyBytesAtMost: 0 as ByteCount,
        first: dtFirst,
        gate,
        inProgress: dtUnique.filter((item) => item.inProgress).length,
      };
    }
    const counts = countWindows(rec.activity, resolved.windows);
    const recorded = resolved.include === "fetch-and-xhr" ? counts.fetchOrXhr : counts.requests;
    const liveItems = rec
      .live()
      .map(({ site, live }) => itemOf(live.request, site, true, 0))
      .filter((item) => inSelection(resolved, item));
    const tabFilter =
      resolved.tabId === null
        ? null
        : (() => {
            const found = lookup(resolved.tabId);
            return found.kind === "tab" ? { run: rec.run, browserId: found.browserId } : null;
          })();
    const recKeys = new Set<string>();
    for (const channel of currentRunKeys(rec.activity, tabFilter)) {
      recKeys.add(exchangeId(rec.run, channel));
    }
    for (const item of liveItems) {
      if (item.key !== null) recKeys.add(item.key);
    }
    let both = 0;
    let devtoolsOnly = 0;
    for (const item of dtUnique) {
      if (item.key !== null && recKeys.has(item.key)) both += 1;
      else devtoolsOnly += 1;
    }
    const totalRecording = recorded + liveItems.length;
    const recordingOnly = Math.max(0, totalRecording - both);
    const first =
      counts.first === null
        ? dtFirst
        : dtFirst === null
          ? counts.first
          : counts.first < dtFirst
            ? counts.first
            : dtFirst;
    return {
      requests: totalRecording + devtoolsOnly,
      sources: { both, recordingOnly, devtoolsOnly },
      bodyBytesAtMost: counts.bodyBytesAtMost,
      first,
      gate,
      inProgress: liveItems.length,
    };
  };

  const popup = async (argument: PopupTabArgument): Promise<Omit<PopupView, "problems">> => {
    const found: TabLookup =
      argument.tabId === null ? { kind: "no-such-tab" } : lookup(argument.tabId);
    const tab: PopupTab =
      argument.tabId === null
        ? { kind: "no-tab" }
        : found.kind === "tab"
          ? { kind: "tab", tabId: found.tabId }
          : { kind: "no-such-tab", tabId: argument.tabId };
    const tabId = found.kind === "tab" ? found.tabId : null;
    const site = found.kind === "tab" ? found.site : null;
    const settings = reads()?.settings() ?? null;
    const rows = [];
    for (const preset of PRESETS) {
      const selection = preset.selection(tabId, site);
      rows.push({ id: preset.id, preview: selection === null ? null : await preview(selection) });
    }
    const all = jobs.list();
    const defaults = settings?.user.exportDefaults ?? { bodies: "include", secrets: "remove" };
    return {
      tab,
      site,
      devtools: found.kind === "tab" ? devtoolsState(toolboxOf(found.tab)) : "closed",
      gate: gateOf(found, settings),
      rows,
      running: all.find((job) => job.state.kind === "writing") ?? null,
      last: all.find((job) => job.state.kind !== "writing") ?? null,
      defaults: {
        bodies: defaults.bodies,
        redaction: defaults.secrets === "remove" ? "standard" : "none",
      },
    };
  };

  const siteOf = (selection: Selection): Site | null => {
    if (selection.scope === "site") return selection.site;
    if (selection.scope === "sessions") {
      // A file of several sites' sessions is not named after one of them.
      const [first, ...rest] = selection.sessions;
      return rest.every((s) => s.site === first.site) ? first.site : null;
    }
    if (selection.scope === "tab") {
      const found = lookup(selection.tabId);
      return found.kind === "tab" ? found.site : null;
    }
    return null;
  };

  const plannedName = (request: ExportRequest): string => {
    if (request.fileName !== null)
      return request.fileName.endsWith(".har") ? request.fileName : `${request.fileName}.har`;
    return formatHarFilename({
      host: siteOf(request.selection),
      timeRange: { start: Date.now() },
      scope: SCOPE_NAMES[request.selection.scope],
      includeBodies: request.bodies === "include",
      redacted: request.redaction !== "none",
      extension: "har",
    });
  };

  /** The folder settings name, or the browser's Downloads folder, as configured. Checked by `exportFiles`. */
  const configuredFolder = async (
    settings: StoredSettings | null,
  ): Promise<{ readonly path: string; readonly label: string | null }> => {
    const chosen = settings?.exportFolder;
    if (chosen?.kind === "chosen") return { path: chosen.path, label: chosen.label };
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    return { path: await Downloads.getPreferredDownloadsDirectory(), label: null };
  };

  const run = async (
    job: { readonly id: ExportId; readonly request: ExportRequest },
    control: Parameters<Parameters<typeof createExportJobs>[0]["run"]>[1],
  ): Promise<RunOutcome> => {
    const rec = reads();
    await rec?.recovered;
    const modes: Modes = rec?.modes ?? {
      dir: ARCHIVE_ROOTS[platform()].dirMode,
      file: ARCHIVE_ROOTS[platform()].fileMode,
    };
    const journal = rec === null ? null : PathUtils.join(rec.root, LAYOUT.exportsJournal);
    const note = async (entry: JournalEntry): Promise<void> => {
      if (journal !== null) await appendText(journal, journalLine(entry), modes);
    };
    const partJournal: PartJournal = {
      started: (path, head) => note({ started: path, head }),
      ended: (path) => note({ ended: path }),
      discardFailed: (path, reason) => note({ discardFailed: path, reason }),
    };
    const roots = realRoots(rec?.root ?? null);
    const files = exportFiles(
      geckoExportPlatform(heldFolders(options.workerUrl, modes, faults.take)),
      (real) => guardFolder(real, roots, platform()).ok,
      { stepMs: EXPORT_STEP_MS, timer: oneShot, signal: control.signal, pause: pauses.pass },
    );
    let written: { readonly part: Part; readonly path: string } | null = null;
    let last = { done: 0, total: 0 };
    const pins: PinHandle[] = [];
    try {
      const configured = await configuredFolder(rec?.settings() ?? null);
      const folder = await files.openFolder(configured.path);
      const planned = jobs.job(job.id)?.fileName ?? plannedName(job.request);
      written = await folder.createPart(planned, partJournal);
      const { part } = written;
      const sink = createPartSink(part.append, (bytes) => control.progress({ ...last, bytes }));
      const devtools = pendingDevtools.get(job.id) ?? makeDevtools();
      pendingDevtools.delete(job.id);
      const resolved = resolveSelection(
        job.request.selection,
        await selectionContext(rec, job.request.selection, devtools),
      );
      const baseBodies = combinedBodies(
        rec === null ? EMPTY_BODY_READER : archiveBodies(rec.root),
        devtools.bodies,
      );
      const report = await runExport(job.request, resolved, {
        recording:
          rec === null
            ? EMPTY_RECORDING_SOURCE
            : archiveSource({
                root: rec.root,
                activity: rec.activity,
                settle: rec.settle,
                enqueue: rec.enqueue,
                pin: (targets) => {
                  const handle = rec.pin(targets);
                  pins.push(handle);
                  return handle;
                },
                live: rec.live,
              }),
        devtools: devtools.source,
        bodies: {
          open: async (source, chunkBytes, signal) => {
            await pauses.pass("before-bodies");
            return baseBodies.open(source, chunkBytes, signal);
          },
        },
        sink,
        creator,
        fileId: Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
        decode: decodeContent,
        yieldNow,
        onProgress: (p) => {
          last = { done: p.done, total: p.total };
          control.progress(p);
        },
        signal: control.signal,
      });
      await sink.close();
      const name = await part.finish(planned);
      finished.set(job.id, PathUtils.join(folder.path, name));
      return {
        kind: "done",
        fileName: name,
        folderLabel: configured.label ?? PathUtils.filename(folder.path),
        report,
        route: part.route(),
      };
    } catch (error) {
      if (written !== null) await written.part.discard().catch(() => undefined);
      if (control.signal.aborted) return { kind: "cancelled" };
      const failure = error instanceof WriteRefused ? error.failure : { kind: "other" as const };
      return {
        kind: "write-failed",
        failure,
        ...(written === null ? {} : { route: written.part.route() }),
        ...(written?.part.unconfirmed() === true ? { unconfirmed: true as const } : {}),
      };
    } finally {
      for (const pin of pins) pin.release();
    }
  };

  const jobs: ExportJobs = createExportJobs({
    run,
    now: () => Date.now() as EpochMs,
    newId: () => {
      exportCounter += 1;
      return `${Date.now().toString(36)}-${String(exportCounter)}` as ExportId;
    },
    plannedName,
    onChange: () => undefined,
  });

  const existing = (id: ExportId): string | null => {
    const path = finished.get(id);
    return path !== undefined && localFile(path).exists() ? path : null;
  };

  return {
    jobs,
    pauses,
    faults,
    lookup,
    popup,
    preview,
    exports: {
      start: (request: ExportRequest): ExportJob => {
        const devtools = makeDevtools();
        devtools.snapshot(request.selection.scope === "tab" ? request.selection.tabId : null);
        const job = jobs.start(request);
        pendingDevtools.set(job.id, devtools);
        return job;
      },
      list: () => jobs.list(),
      cancel: (id: ExportId) => jobs.cancel(id),
      reveal: async (id: ExportId): Promise<boolean> => {
        const path = existing(id);
        if (path === null) return false;
        try {
          localFile(path).reveal();
        } catch {
          // Linux file managers may not support reveal; opening the folder is the fallback.
          localFile(PathUtils.parent(path) ?? path).launch();
        }
        return true;
      },
      copyPath: (id: ExportId): boolean => {
        const path = existing(id);
        if (path === null) return false;
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(path);
        return true;
      },
    },
  };
}

export type GeckoHost = ReturnType<typeof createGeckoHost>;
