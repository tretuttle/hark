// The experiment API's parent script: system principal, parent process. Recording is always on by construction:
// the manifest's experiment entry lists "events": ["startup"], so onStartup starts the recorder before any page
// loads, and no API function starts or stops it.

import { pageSites } from "@hark/recording/activity";
import { parseSite, runIdAt, toMinute, type EpochMs, type RunId } from "@hark/recording/ids";
import { guardFolder, LAYOUT } from "@hark/recording/layout";
import type { ReconcileStep } from "@hark/recording/reconcile";
import { compileRoutes } from "@hark/recording/routes";
import type { StoredSettings } from "@hark/recording/settings";
import { FILE_WORKER, namespace } from "./contract.ts";
import { primeToolboxes, toolboxOf } from "./devtools.ts";
import { unfinishedExports } from "./export-file.ts";
import { parseExportId } from "@hark/export/jobs";
import {
  forbiddenRoots,
  loadSettings,
  openArchive,
  openPersistedLedger,
  platform,
  type Archive,
  type RootProblem,
} from "./files.ts";
import { Timers } from "./gecko-io.ts";
import {
  createGeckoHost,
  realPathOf,
  realRoots,
  type GeckoHost,
  type RecordingReads,
} from "./host.ts";
import { recover } from "./maintenance.ts";
import { createHarkApi, type RawApi, type RecordingFacts } from "./parent-api.ts";
import { startRecorder, type Recorder } from "./recorder.ts";
import { settingsHost } from "./settings-host.ts";
import { HOLD_POINTS, openStore, type HoldPoint, type Store } from "./store.ts";

/** Set only in a harness profile's user.js. Enables the observer topic below, which only system-principal code reaches. */
const HARNESS_PREF = "extensions.hark.harness";
const HARNESS_TOPIC = "hark-harness";
/** The resource root file-worker.js is served under, and its path in the package. */
const WORKER_ROOT = "hark";
const resourceHandler = () =>
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler);

interface Running {
  readonly run: RunId;
  readonly archive: Archive;
  readonly store: Store;
  readonly recorder: Recorder;
  readonly timers: Timers;
  readonly settingsRejected: boolean;
  readonly recovery: Promise<readonly ReconcileStep[]>;
}

type Lifecycle =
  | { readonly kind: "stopped" }
  | { readonly kind: "unavailable"; readonly problem: RootProblem }
  | ({ readonly kind: "running" } & Running);

const compile = (settings: StoredSettings, archive: Archive) =>
  compileRoutes({
    platform: archive.platform,
    excluded: settings.user.excludedSites,
    keepMedia: settings.user.media === "keep-bodies",
    maxBodyBytes: settings.user.retention.maxBodyBytes,
    supported: ["memory-tee", "file-tee"],
  });

/** Observers are added before anything is awaited: a 650 ms delay missed the first page. */
function start(): Lifecycle {
  const run = runIdAt(Date.now() as EpochMs);
  const opened = openArchive();
  if (!opened.ok) return { kind: "unavailable", problem: opened.problem };
  const { archive } = opened;
  const { settings, rejected } = loadSettings(archive.root);
  const harness = Services.prefs.getBoolPref(HARNESS_PREF, false);
  const persistedUsage = openPersistedLedger(archive.root, archive.modes, run);
  const scanDelayMs = harness
    ? Math.max(0, Services.prefs.getIntPref("extensions.hark.harnessScanDelayMs", 0))
    : 0;
  const timers = new Timers();
  let recorder: Recorder | null = null;
  const store = openStore({
    run,
    root: archive.root,
    modes: archive.modes,
    settings,
    timers,
    onSettings: (next) => recorder?.setRoutes(compile(next, archive)),
    persistedUsage,
    ...(scanDelayMs > 0 ? { scanDelayMs } : {}),
    countWork: harness,
  });
  recorder = startRecorder({
    run,
    routes: compile(settings, archive),
    store,
    root: archive.root,
    modes: archive.modes,
    timers,
  });
  store.beginStartup();
  let steps: readonly ReconcileStep[] = [];
  const journal = PathUtils.join(archive.root, LAYOUT.exportsJournal);
  const recovery = store
    .enqueue(async () => {
      try {
        const started = await IOUtils.readUTF8(journal).catch(() => "");
        steps = await recover(
          archive.root,
          archive.modes,
          run,
          settings.user.excludedSites,
          unfinishedExports(started),
        );
        await IOUtils.remove(journal, { ignoreAbsent: true });
      } finally {
        await store.initRetention();
      }
    })
    .then(() => steps);
  return {
    kind: "running",
    run,
    archive,
    store,
    recorder,
    timers,
    settingsRejected: rejected,
    recovery,
  };
}

/** AsyncShutdown keeps the profile writable until the seal finishes; a phase already under way refuses a blocker. */
function blockShutdown(closing: Promise<void>): void {
  const { AsyncShutdown } = ChromeUtils.importESModule(
    "resource://gre/modules/AsyncShutdown.sys.mjs",
  );
  for (const phase of [AsyncShutdown.profileBeforeChange, AsyncShutdown.sendTelemetry]) {
    try {
      phase.addBlocker("Hark: write the last lines of the recording", closing);
      return;
    } catch {
      // Too late for this phase; try the next one.
    }
  }
}

type HarnessRequest =
  | {
      readonly kind:
        | "flush"
        | "seal"
        | "recovery"
        | "status"
        | "retain"
        | "reset-work"
        | "pin-oldest-pack"
        | "sites";
    }
  | { readonly kind: "exclude"; readonly site: string }
  | { readonly kind: "unpin"; readonly pinId: string }
  | { readonly kind: "arm" | "reached"; readonly point: string }
  | { readonly kind: "guard"; readonly path: string }
  | { readonly kind: "export-audit" | "export-route"; readonly id: string }
  | { readonly kind: "export-fault"; readonly op: string; readonly errno: string }
  | {
      readonly kind: "export-pause";
      readonly point: string;
      readonly action: "arm" | "reached" | "release";
    };

/** The worker calls a harness profile may make answer an errno, once. */
const FAULT_OPS = new Set([
  "hold-folder",
  "create",
  "create-part",
  "write",
  "link",
  "rename-part",
  "discard-part",
]);

const isHoldPoint = (value: string): value is HoldPoint =>
  (HOLD_POINTS as readonly string[]).includes(value);

/**
 * The harness's way in: flush, seal, exclude, hold the write chain at a crash point or an export at a pause, arm an
 * export's worker call to fail, read recovery, the guard and an export's route.
 */
async function answerHarness(
  state: Running,
  host: GeckoHost,
  request: HarnessRequest,
): Promise<unknown> {
  switch (request.kind) {
    case "flush":
      return state.store.flush();
    case "seal":
      return state.store.sealAll();
    case "recovery":
      return state.recovery;
    case "status":
      return {
        run: state.run,
        root: state.archive.root,
        keyCreated: state.archive.keyCreated,
        ready: state.store.isReady(),
        unreadableEntries: state.store.unreadableEntries(),
        problems: state.store.problems(),
        usage: state.store.usage(),
        overCapWhileExporting: state.store.overCapWhileExporting(),
        work: state.store.workMetrics(),
        startupGate: state.store.startupGateMetrics(),
        ...state.recorder.counts(),
      };
    case "retain":
      return state.store.retain();
    case "reset-work":
      state.store.resetWorkMetrics();
      state.recorder.resetGuardCounts();
      return { ok: true };
    case "pin-oldest-pack":
      return state.store.pinOldestPack();
    case "unpin":
      return state.store.unpin(request.pinId);
    case "sites":
      return pageSites(state.store.activity(), null, 500, toMinute(Date.now() as EpochMs)).rows.map(
        (row) => row.site,
      );
    case "exclude": {
      const site = parseSite(request.site);
      if (site === null) throw new Error(`not a site: ${request.site}`);
      return state.store.excludeSite(site);
    }
    case "arm":
    case "reached": {
      const point = request.point;
      if (!isHoldPoint(point)) throw new Error(`not a hold point: ${point}`);
      if (request.kind === "arm") return state.store.arm(point);
      return state.store.reached(point);
    }
    case "guard":
      return {
        forbidden: forbiddenRoots(),
        verdict: guardFolder(request.path, forbiddenRoots(), platform()),
      };
    case "export-audit": {
      const id = parseExportId(request.id);
      if (id === null) throw new Error(`not an export id: ${request.id}`);
      return host.jobs.audit(id);
    }
    case "export-route": {
      const id = parseExportId(request.id);
      if (id === null) throw new Error(`not an export id: ${request.id}`);
      return host.jobs.route(id);
    }
    case "export-fault": {
      if (!FAULT_OPS.has(request.op)) throw new Error(`not a worker call: ${request.op}`);
      if (!/^E[A-Z]{2,15}$/u.test(request.errno)) throw new Error(`not an errno: ${request.errno}`);
      host.faults.arm(request.op, request.errno);
      return null;
    }
    case "export-pause": {
      const point = request.point;
      if (
        point !== "before-bodies" &&
        point !== "before-link" &&
        point !== "before-rename" &&
        point !== "after-link"
      )
        throw new Error(`not an export pause: ${point}`);
      return host.pauses[request.action](point) ?? null;
    }
  }
}

/** The archive as the host reads it, or null while the recording is not running. */
const recordingReads = (state: Lifecycle): RecordingReads | null =>
  state.kind !== "running"
    ? null
    : {
        run: state.run,
        root: state.archive.root,
        modes: state.archive.modes,
        activity: state.store.activity(),
        settings: state.store.settings,
        settle: async () => {
          // A file body's line joins a batch only after its rename, which runs on the chain; the second flush writes it.
          await state.store.flush();
          await state.store.flush();
        },
        enqueue: state.store.enqueue,
        pin: state.store.pin,
        live: () => state.recorder.snapshot(),
        recovered: state.recovery,
      };

const refusal = (message: string): Error => {
  const { ExtensionUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs",
  );
  return new ExtensionUtils.ExtensionError(message);
};

class HarkParent extends ExtensionAPI {
  #state: Lifecycle = { kind: "stopped" };
  #harness: Observer | null = null;
  #host: GeckoHost | null = null;
  #priming: { dispose(): void } | null = null;
  readonly #run: RunId = runIdAt(Date.now() as EpochMs);

  /** One host per add-on, so an export started from the popup keeps running after the popup closes. */
  get #shared(): GeckoHost {
    this.#host ??= createGeckoHost({
      run: this.#state.kind === "running" ? this.#state.run : this.#run,
      reads: () => recordingReads(this.#state),
      creator: { name: this.extension.manifest.name, version: this.extension.version },
      extension: this.extension,
      workerUrl: this.#workerUrl(),
    });
    return this.#host;
  }

  override onStartup(): void {
    if (this.#state.kind !== "stopped") return;
    this.#state = start();
    this.#priming = primeToolboxes();
    if (!Services.prefs.getBoolPref(HARNESS_PREF, false)) return;
    this.#harness = {
      observe: (subject) => {
        const holder = (
          subject as { wrappedJSObject?: { request: HarnessRequest; done(result: unknown): void } }
        ).wrappedJSObject;
        if (holder === undefined) return;
        const state = this.#state;
        const answer =
          state.kind === "running"
            ? answerHarness(state, this.#shared, holder.request)
            : Promise.resolve({ unavailable: state.kind === "unavailable" ? state.problem : null });
        answer.then(
          (result) => holder.done({ ok: true, result }),
          (error: unknown) => holder.done({ ok: false, error: String(error) }),
        );
      },
    };
    Services.obs.addObserver(this.#harness, HARNESS_TOPIC);
  }

  /**
   * file-worker.js under a resource URL, the only kind a ChromeWorker starts from. Only system-principal code loads
   * it: the substitution grants no content access.
   */
  #workerUrl(): string | null {
    try {
      resourceHandler().setSubstitution(WORKER_ROOT, this.extension.rootURI);
      return `resource://${WORKER_ROOT}/${FILE_WORKER}`;
    } catch {
      return null;
    }
  }

  override onShutdown(isAppShutdown: boolean): void {
    this.#priming?.dispose();
    this.#priming = null;
    try {
      if (this.#host !== null) resourceHandler().setSubstitution(WORKER_ROOT, null);
    } catch {
      // Nothing was registered.
    }
    if (this.#harness !== null) Services.obs.removeObserver(this.#harness, HARNESS_TOPIC);
    this.#harness = null;
    for (const job of this.#host?.jobs.list() ?? [])
      if (job.state.kind === "writing") this.#host?.jobs.cancel(job.id);
    const state = this.#state;
    this.#state = { kind: "stopped" };
    if (state.kind !== "running") return;
    state.recorder.stop(isAppShutdown ? "browser-closed" : "recording-stopped");
    const closing = state.store.close();
    state.timers.cancelAll();
    if (isAppShutdown) blockShutdown(closing);
  }

  #facts(): RecordingFacts {
    const state = this.#state;
    const strictOriginPolicy = Services.prefs.getBoolPref(
      "security.fileuri.strict_origin_policy",
      true,
    );
    if (state.kind !== "running") {
      return {
        archive:
          state.kind === "unavailable" && state.problem.kind === "archive-refused"
            ? "refused"
            : "unwritable",
        strictOriginPolicy,
        settingsRejected: false,
        writeFailures: 0,
        liveOverflow: 0,
      };
    }
    return {
      archive: null,
      strictOriginPolicy,
      settingsRejected: state.settingsRejected,
      writeFailures: state.store.problems().filter((p) => p.kind === "write-failed").length,
      unreadableEntries: state.store.unreadableEntries(),
      liveOverflow: state.recorder.counts().overflow,
      overCapWhileExporting: state.store.overCapWhileExporting(),
    };
  }

  override getAPI(_context: ExtensionContext): Record<string, RawApi> {
    const host = this.#shared;
    return {
      [namespace]: createHarkApi(
        {
          identity: () => ({
            name: Services.appinfo.name,
            version: Services.appinfo.version,
            buildId: Services.appinfo.appBuildID,
          }),
          toolbox: (tabId) => {
            const found = host.lookup(tabId);
            return found.kind === "tab"
              ? toolboxOf(found.tab)
              : { open: false, reason: "no-such-tab" };
          },
          recording: () => this.#facts(),
          popup: host.popup,
          preview: host.preview,
          exports: host.exports,
          ...settingsHost(
            () => {
              const state = this.#state;
              return state.kind === "running"
                ? { store: state.store, archive: state.archive.root }
                : null;
            },
            { realPath: realPathOf, roots: realRoots, platform: platform() },
          ),
        },
        refusal,
      ),
    };
  }
}

// ExtensionCommon.sys.mjs reads the API class from this script's global under the namespace name.
Object.assign(globalThis, { [namespace]: HarkParent });
