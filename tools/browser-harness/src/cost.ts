import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { locateArchive, readLines } from "./archive.ts";
import {
  launchBrowser,
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserDisplay,
  type BrowserIdentity,
  type BrowserSession,
} from "./browser.ts";
import {
  baselineFileName,
  machineInfo,
  recordedBrowser,
  summarize,
  type FailedRun,
  type MachineInfo,
  type MachineLoad,
  type RecordedBrowser,
  type Summary,
} from "./measure.ts";
import { callHook, HARNESS_PREFS } from "./recording-session.ts";
import { getCostScenario, type CostScenarioName, type MeasuredScenario } from "./scenarios.ts";
import { startFixtureServer, type ServedRequest } from "./server.ts";

export const COST_ARMS = ["off", "extension", "panel"] as const;
export type CostArm = (typeof COST_ARMS)[number];

const MIN_SETTLE_MS = 2_500;
const MAX_SETTLE_MS = 8_000;
const SETTLE_WINDOW_MS = 250;
const SETTLE_QUIET_MAIN_MS = 5.0;

const MAX_ROUND_CPU_BUSY_PERCENT = 25;
function defaultMaxLoad1m(cpuCount: number = NodeOS.cpus().length): number {
  return Math.max(4, Math.round(cpuCount * 0.25));
}
const MAX_LOAD_RETRIES_PER_ROUND = 5;
const LOAD_COOLDOWN_MS = 2_000;
const NETMONITOR_FLUSH_MS = 3_000;

export type ProcInfoSample = {
  readonly mainThreadMs: number;
  readonly processCpuMs: number;
  readonly workingSetBytes: number;
  readonly mainThreadHow: "tid" | "name";
};

export type DiscardedCostRound = {
  readonly round: number;
  readonly attempt: number;
  readonly reason: string;
  readonly load: MachineLoad;
};

export type CostSample = {
  readonly round: number;
  readonly arm: CostArm;
  readonly lastResourceFinishedMs: number;
  readonly parentWorkingSetBytes: number;
  readonly parentMainThreadMs: number;
  readonly parentProcessCpuMs: number;
  readonly wallMs: number;
  readonly settleMs: number;
  readonly requestCount: number;
};

export type ArmSummary = {
  readonly arm: CostArm;
  readonly scoredRunCount: number;
  readonly lastResourceFinishedMs: Summary | null;
  readonly parentMainThreadMs: Summary | null;
  readonly parentProcessCpuMs: Summary | null;
  readonly parentWorkingSetBytes: Summary | null;
  readonly wallMs: Summary | null;
};

export type CostScenarioResult = {
  readonly scenario: CostScenarioName;
  readonly cpuMetric: "parent-main-thread";
  readonly rounds: number;
  readonly warmupDropped: 1;
  readonly discardedRounds: readonly DiscardedCostRound[];
  readonly errors: number;
  readonly failures: readonly FailedRun[];
  readonly warmupSamples: readonly CostSample[];
  readonly scoredSamples: readonly CostSample[];
  readonly arms: Readonly<Record<CostArm, ArmSummary>>;
  readonly budget: {
    readonly parentMainThreadMs: number | null;
    readonly lastResourceFinishedMs: number | null;
  };
  readonly browser: BrowserIdentity;
  readonly machine: MachineInfo;
  readonly load: { readonly before: MachineLoad; readonly after: MachineLoad };
};

export type CostBaselineFile = {
  readonly capturedAt: string;
  readonly scenario: CostScenarioName;
  readonly cpuMetric: "parent-main-thread";
  readonly arm: "off" | "panel";
  readonly rounds: number;
  readonly warmupDropped: 1;
  readonly discardedRounds: readonly DiscardedCostRound[];
  readonly runCount: number;
  readonly errors: number;
  readonly failures: readonly FailedRun[];
  readonly samples: readonly CostSample[];
  readonly lastResourceFinishedMs: Summary | null;
  readonly parentMainThreadMs: Summary | null;
  readonly parentProcessCpuMs: Summary | null;
  readonly parentWorkingSetBytes: Summary | null;
  readonly wallMs: Summary | null;
  readonly browser: RecordedBrowser;
  readonly machine: MachineInfo;
  readonly load: { readonly before: MachineLoad; readonly after: MachineLoad };
};

export function rotateArms(round: number): readonly CostArm[] {
  return COST_ARMS.map((_, index) => COST_ARMS[(index + round) % COST_ARMS.length] ?? "off");
}

export function computeBudget(offMedian: number, panelMedian: number): number {
  return offMedian + 0.5 * (panelMedian - offMedian);
}

export const ARCHIVE_DOWNLOAD_RATIO = 1.45;
export const ARCHIVE_DOWNLOAD_SLACK_MS = 10;
export const ARCHIVE_BROWSE_RATIO = 1.18;
export const ARCHIVE_BROWSE_SLACK_MS = 15;

export function detectSlowArm(options: {
  readonly arm: CostArm;
  readonly observedMedianMs: number;
  readonly offMedianMs: number;
  readonly panelMedianMs: number;
  readonly slackMs?: number;
}): { readonly ok: boolean; readonly budgetMs: number; readonly reason: string | null } {
  const budgetMs = computeBudget(options.offMedianMs, options.panelMedianMs);
  const ceiling = budgetMs + (options.slackMs ?? 0);
  if (options.panelMedianMs > options.offMedianMs && options.observedMedianMs > ceiling) {
    return {
      ok: false,
      budgetMs,
      reason: `${options.arm} median ${options.observedMedianMs.toFixed(1)} ms exceeded budget ${budgetMs.toFixed(1)} ms (off ${options.offMedianMs.toFixed(1)} ms, panel ${options.panelMedianMs.toFixed(1)} ms)`,
    };
  }
  return { ok: true, budgetMs, reason: null };
}

export function detectSlowArchiveCost(options: {
  readonly emptyDownloadMedianMs: number;
  readonly fullDownloadMedianMs: number;
  readonly emptyBrowseMedianMs: number;
  readonly fullBrowseMedianMs: number;
  readonly downloadRatio?: number;
  readonly downloadSlackMs?: number;
  readonly browseRatio?: number;
  readonly browseSlackMs?: number;
}): {
  readonly ok: boolean;
  readonly downloadBudgetMs: number;
  readonly browseBudgetMs: number;
  readonly reason: string | null;
} {
  const dlRatio = options.downloadRatio ?? ARCHIVE_DOWNLOAD_RATIO;
  const dlSlack = options.downloadSlackMs ?? ARCHIVE_DOWNLOAD_SLACK_MS;
  const brRatio = options.browseRatio ?? ARCHIVE_BROWSE_RATIO;
  const brSlack = options.browseSlackMs ?? ARCHIVE_BROWSE_SLACK_MS;
  const downloadBudgetMs =
    Math.round((options.emptyDownloadMedianMs * dlRatio + dlSlack) * 10) / 10;
  const browseBudgetMs = Math.round((options.emptyBrowseMedianMs * brRatio + brSlack) * 10) / 10;
  const reasons: string[] = [];
  if (options.fullDownloadMedianMs > downloadBudgetMs) {
    reasons.push(
      `10,000-file download median ${options.fullDownloadMedianMs.toFixed(1)} ms exceeded budget ${downloadBudgetMs.toFixed(1)} ms (empty ${options.emptyDownloadMedianMs.toFixed(1)} ms * ${String(dlRatio)} + ${String(dlSlack)} ms)`,
    );
  }
  if (options.fullBrowseMedianMs > browseBudgetMs) {
    reasons.push(
      `10,000-file browse median ${options.fullBrowseMedianMs.toFixed(1)} ms exceeded budget ${browseBudgetMs.toFixed(1)} ms (empty ${options.emptyBrowseMedianMs.toFixed(1)} ms * ${String(brRatio)} + ${String(brSlack)} ms)`,
    );
  }
  return {
    ok: reasons.length === 0,
    downloadBudgetMs,
    browseBudgetMs,
    reason: reasons.length === 0 ? null : reasons.join("; "),
  };
}

export function summarizeCostSamples(samples: readonly CostSample[], arm: CostArm): ArmSummary {
  const matching = samples.filter((sample) => sample.arm === arm && sample.round > 0);
  return {
    arm,
    scoredRunCount: matching.length,
    lastResourceFinishedMs: summarize(matching.map((sample) => sample.lastResourceFinishedMs)),
    parentMainThreadMs: summarize(matching.map((sample) => sample.parentMainThreadMs)),
    parentProcessCpuMs: summarize(matching.map((sample) => sample.parentProcessCpuMs)),
    parentWorkingSetBytes: summarize(matching.map((sample) => sample.parentWorkingSetBytes)),
    wallMs: summarize(matching.map((sample) => sample.wallMs)),
  };
}

export function highLoadReason(
  load: MachineLoad,
  limits: { readonly maxLoad1m: number; readonly maxCpuBusyPercent: number } = {
    maxLoad1m: defaultMaxLoad1m(),
    maxCpuBusyPercent: MAX_ROUND_CPU_BUSY_PERCENT,
  },
): string | null {
  if (load.cpuBusyPercent > limits.maxCpuBusyPercent) {
    return `cpu ${load.cpuBusyPercent.toFixed(1)}% exceeded ${String(limits.maxCpuBusyPercent)}%`;
  }
  const load1m = load.loadAverage?.[0];
  if (load1m !== undefined && load1m > limits.maxLoad1m) {
    return `loadavg ${load1m.toFixed(2)} exceeded ${limits.maxLoad1m.toFixed(2)}`;
  }
  return null;
}

export async function measureCostScenario(options: {
  readonly scenarioName: CostScenarioName;
  readonly rounds: number;
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly display: BrowserDisplay;
  readonly signal: AbortSignal;
  readonly maxLoad1m?: number;
  readonly maxCpuBusyPercent?: number;
  readonly readLoad?: () => Promise<MachineLoad>;
  readonly cooldown?: (ms: number) => Promise<void>;
  readonly runRound?: (
    round: number,
    rotatedArms: readonly CostArm[],
  ) => Promise<{
    readonly samples: readonly CostSample[];
    readonly failures: readonly FailedRun[];
    readonly browserIdentity: BrowserIdentity | null;
  }>;
}): Promise<CostScenarioResult> {
  if (options.rounds < 2) {
    throw new Error("cost measurement requires at least 2 rounds (round 0 warmup is dropped)");
  }
  const limits = {
    maxLoad1m: options.maxLoad1m ?? defaultMaxLoad1m(),
    maxCpuBusyPercent: options.maxCpuBusyPercent ?? MAX_ROUND_CPU_BUSY_PERCENT,
  };
  const readLoad = options.readLoad ?? readMachineLoad;
  const cooldown = options.cooldown ?? ((ms: number) => delay(ms));

  const scenario = getCostScenario(options.scenarioName);
  const ownedServer = options.runRound === undefined ? await startFixtureServer() : null;
  await using serverStack = new AsyncDisposableStack();
  if (ownedServer !== null) serverStack.use(ownedServer);

  const addonId =
    options.runRound === undefined ? await readExtensionId(options.extensionPath) : "";
  const popupPath =
    options.runRound === undefined ? await readExtensionPopupPath(options.extensionPath) : "";

  const loadBefore = await readLoad();
  const allSamples: CostSample[] = [];
  const failures: FailedRun[] = [];
  const discardedRounds: DiscardedCostRound[] = [];
  let browserIdentity: BrowserIdentity | null = null;
  let runIndex = 0;

  for (let round = 0; round < options.rounds; round += 1) {
    const rotated = rotateArms(round);
    let roundDone = false;
    for (let attempt = 1; attempt <= MAX_LOAD_RETRIES_PER_ROUND + 1; attempt += 1) {
      options.signal.throwIfAborted();
      const roundLoadBefore = await readLoad();
      const preReason = highLoadReason(roundLoadBefore, limits);
      if (preReason !== null && attempt <= MAX_LOAD_RETRIES_PER_ROUND) {
        discardedRounds.push({
          round,
          attempt,
          reason: `before round: ${preReason}`,
          load: roundLoadBefore,
        });
        await cooldown(LOAD_COOLDOWN_MS);
        continue;
      }

      const roundResult = options.runRound
        ? await options.runRound(round, rotated)
        : await executeRound({
            round,
            arms: rotated,
            binaryPath: options.binaryPath,
            extensionPath: options.extensionPath,
            addonId,
            popupPath,
            display: options.display,
            scenario,
            server: ownedServer!,
            signal: options.signal,
            nextRunIndex: () => {
              runIndex += 1;
              return runIndex;
            },
          });

      if (roundResult.browserIdentity !== null) {
        browserIdentity ??= roundResult.browserIdentity;
      }

      const roundLoadAfter = await readLoad();
      const postReason = highLoadReason(roundLoadAfter, limits);
      if (postReason !== null) {
        if (attempt <= MAX_LOAD_RETRIES_PER_ROUND) {
          discardedRounds.push({
            round,
            attempt,
            reason: `after round: ${postReason}`,
            load: roundLoadAfter,
          });
          await cooldown(LOAD_COOLDOWN_MS);
          continue;
        }
        failures.push({
          run: runIndex,
          reason: `round ${String(round)}: high load persisted (${postReason})`,
        });
        roundDone = true;
        break;
      }

      allSamples.push(...roundResult.samples);
      failures.push(...roundResult.failures);
      roundDone = true;
      break;
    }
    if (!roundDone) {
      failures.push({
        run: runIndex,
        reason: `round ${String(round)}: could not run under load limit`,
      });
    }
  }

  const loadAfter = await readLoad();
  if (browserIdentity === null && options.runRound === undefined) {
    throw new Error(
      `all cost runs failed for ${options.scenarioName}: ${failures.map((f) => f.reason).join("; ")}`,
    );
  }
  const warmupSamples = allSamples.filter((sample) => sample.round === 0);
  const scoredSamples = allSamples.filter((sample) => sample.round > 0);
  const arms: Record<CostArm, ArmSummary> = {
    off: summarizeCostSamples(allSamples, "off"),
    extension: summarizeCostSamples(allSamples, "extension"),
    panel: summarizeCostSamples(allSamples, "panel"),
  };
  const offCpu = arms.off.parentMainThreadMs?.median ?? null;
  const panelCpu = arms.panel.parentMainThreadMs?.median ?? null;
  const offLast = arms.off.lastResourceFinishedMs?.median ?? null;
  const panelLast = arms.panel.lastResourceFinishedMs?.median ?? null;

  return {
    scenario: options.scenarioName,
    cpuMetric: "parent-main-thread",
    rounds: options.rounds,
    warmupDropped: 1,
    discardedRounds,
    errors: failures.length,
    failures,
    warmupSamples,
    scoredSamples,
    arms,
    budget: {
      parentMainThreadMs:
        offCpu !== null && panelCpu !== null ? computeBudget(offCpu, panelCpu) : null,
      lastResourceFinishedMs:
        offLast !== null && panelLast !== null ? computeBudget(offLast, panelLast) : null,
    },
    browser: browserIdentity ?? defaultIdentity(options.binaryPath),
    machine: machineInfo(),
    load: { before: loadBefore, after: loadAfter },
  };
}

async function executeRound(options: {
  readonly round: number;
  readonly arms: readonly CostArm[];
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly addonId: string;
  readonly popupPath: string;
  readonly display: BrowserDisplay;
  readonly scenario: MeasuredScenario;
  readonly server: {
    readonly origin: string;
    readonly takeRequests: () => readonly ServedRequest[];
  };
  readonly signal: AbortSignal;
  readonly nextRunIndex: () => number;
}): Promise<{
  readonly samples: readonly CostSample[];
  readonly failures: readonly FailedRun[];
  readonly browserIdentity: BrowserIdentity | null;
}> {
  const samples: CostSample[] = [];
  const failures: FailedRun[] = [];
  let browserIdentity: BrowserIdentity | null = null;
  for (const arm of options.arms) {
    options.signal.throwIfAborted();
    const run = options.nextRunIndex();
    try {
      await using session = await launchBrowser({
        binaryPath: options.binaryPath,
        extensionPath: arm === "extension" ? options.extensionPath : null,
        display: options.display,
        protocol: "marionette",
        allowSystemAccess: true,
        extraPrefs: arm === "extension" ? HARNESS_PREFS : [],
        signal: options.signal,
      });
      browserIdentity ??= session.identity;
      const sample = await runCostArm({
        session,
        ...(arm === "extension" ? { readRecorded: () => recordedRequests(session) } : {}),
        server: options.server,
        scenario: options.scenario,
        round: options.round,
        arm,
        addonId: options.addonId,
        popupPath: options.popupPath,
        signal: options.signal,
      });
      samples.push(sample);
    } catch (error) {
      if (options.signal.aborted) throw error;
      failures.push({
        run,
        reason: `round ${String(options.round)} ${arm}: ${errorMessage(error)}`,
      });
    }
  }
  return { samples, failures, browserIdentity };
}

/** Flushes the recorder, then reads `METHOD path` for every line in the launch's archive. */
async function recordedRequests(session: BrowserSession): Promise<readonly string[]> {
  await callHook(session, { kind: "flush" });
  const archive = locateArchive(session.dataHome, session.profileDir);
  return archive === null
    ? []
    : readLines(archive.root).map(
        ({ exchange }) => `${exchange.request.method} ${new URL(exchange.request.url).pathname}`,
      );
}

export type CostArmSession = Pick<
  BrowserSession,
  "openTab" | "navigateTab" | "evaluate" | "evaluateChrome" | "closeTab"
>;

export async function runCostArm(options: {
  readonly session: CostArmSession;
  readonly server: {
    readonly origin: string;
    readonly takeRequests: () => readonly ServedRequest[];
  };
  readonly scenario: MeasuredScenario;
  readonly round: number;
  readonly arm: CostArm;
  readonly addonId: string;
  readonly popupPath: string;
  readonly signal: AbortSignal;
  readonly readProcInfo?: (session: CostArmSession) => Promise<ProcInfoSample>;
  /** The extension arm's proof that the recorder did the work it was timed on: every request it recorded. */
  readonly readRecorded?: () => Promise<readonly string[]>;
  readonly settle?: (
    session: CostArmSession,
    readInfo: () => Promise<ProcInfoSample>,
    signal: AbortSignal,
  ) => Promise<number>;
}): Promise<CostSample> {
  const { session, server, scenario, round, arm, addonId, popupPath, signal } = options;
  const readInfo = (): Promise<ProcInfoSample> =>
    options.readProcInfo
      ? options.readProcInfo(session)
      : abortable(readProcInfoFromChrome(session), signal);

  if (arm === "extension") {
    const popupUrl = await abortable(
      waitForActiveExtensionUrl(session, addonId, popupPath),
      signal,
    );
    await verifyExtensionApiAnswers(session, popupUrl, signal);
  }

  // Warm Necko/content-process pipelines identically in every arm before opening the measured tab/panel.
  const warmupTab = await abortable(session.openTab(`${server.origin}/`), signal);
  await session.closeTab(warmupTab).catch(() => undefined);

  const context = await abortable(session.openTab("about:blank"), signal);
  let toolboxOpened = false;
  try {
    await verifyArmChromePrecondition(session, arm, addonId, signal);
    if (arm === "panel") {
      await openNetmonitorPanel(session, signal);
      toolboxOpened = true;
    }

    const settleMs = options.settle
      ? await options.settle(session, readInfo, signal)
      : await settleBeforeMeasurement(session, readInfo, signal);

    server.takeRequests();
    const before = await readInfo();
    const started = process.hrtime.bigint();
    await abortable(session.navigateTab(context, `${server.origin}${scenario.pagePath}`), signal);
    const rawReport = await abortable(session.evaluate(context, "window.__harnessReady"), signal);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const after = await readInfo();
    const served = server.takeRequests();
    const report = parseReport(rawReport);

    if (arm === "panel") {
      await verifyPanelRecordedRequests(session, served.length, signal);
    }

    const problem = verifyCostRequests(report, served, scenario);
    if (problem !== null) throw new Error(problem);
    if (options.readRecorded !== undefined) {
      const recorded = await options.readRecorded();
      const missed = subtractMultiset(
        served.map((request) => `${request.method} ${request.path}`),
        recorded,
      );
      if (missed.length > 0)
        throw new Error(
          `the recorder missed ${String(missed.length)} of ${String(served.length)} served requests`,
        );
    }
    return {
      round,
      arm,
      lastResourceFinishedMs: report.lastResourceFinishedMs,
      parentWorkingSetBytes: after.workingSetBytes,
      parentMainThreadMs: Math.round((after.mainThreadMs - before.mainThreadMs) * 10) / 10,
      parentProcessCpuMs: Math.round((after.processCpuMs - before.processCpuMs) * 10) / 10,
      wallMs,
      settleMs,
      requestCount: served.length,
    };
  } finally {
    if (toolboxOpened) {
      await session
        .evaluateChrome(
          `const done = arguments[arguments.length - 1];
           const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
           const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
           gDevTools.closeToolboxForTab(window.gBrowser.selectedTab).then(() => done(true), () => done(false));`,
        )
        .catch(() => undefined);
    }
    await session.closeTab(context).catch(() => undefined);
  }
}

async function verifyExtensionApiAnswers(
  session: CostArmSession,
  popupUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const popupTab = await abortable(session.openTab(popupUrl), signal);
  try {
    const raw = await abortable(
      session.evaluate(
        popupTab,
        `(async () => {
          const tabs = await browser.tabs.query({ active: true, currentWindow: true });
          const env = await browser.hark.getEnvironment(tabs[0].id);
          return JSON.stringify(env);
        })()`,
      ),
      signal,
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("browser" in parsed) ||
      !("toolbox" in parsed)
    ) {
      throw new Error(`extension API returned invalid environment: ${raw}`);
    }
  } finally {
    await session.closeTab(popupTab).catch(() => undefined);
  }
}

async function verifyArmChromePrecondition(
  session: CostArmSession,
  arm: CostArm,
  addonId: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await abortable(
    session.evaluateChrome(
      `const done = arguments[arguments.length - 1];
       const [arm, addonId] = arguments;
       const policy = WebExtensionPolicy.getByID(addonId);
       const hasPolicy = Boolean(policy);
       const { DevToolsShim } = ChromeUtils.importESModule("chrome://devtools-startup/content/DevToolsShim.sys.mjs");
       const hasToolbox = typeof DevToolsShim.isAnyToolboxPresent === "function"
         ? DevToolsShim.isAnyToolboxPresent()
         : Boolean(DevToolsShim.getToolboxForTab?.(window.gBrowser.selectedTab));
       if (arm === "extension") {
         if (!policy || !policy.active) { done({ error: "extension arm requires active policy for " + addonId }); return; }
         if (hasToolbox) { done({ error: "extension arm requires DevTools closed" }); return; }
         done({ ok: true });
         return;
       }
       if (hasPolicy) { done({ error: arm + " arm requires extension absent, found " + addonId }); return; }
       if (arm === "off" && hasToolbox) { done({ error: "off arm requires DevTools closed" }); return; }
       done({ ok: true });`,
      [arm, addonId],
    ),
    signal,
  );
  checkChromeResult(result, `${arm} precondition`);
}

async function openNetmonitorPanel(session: CostArmSession, signal: AbortSignal): Promise<void> {
  const result = await abortable(
    session.evaluateChrome(
      `const done = arguments[arguments.length - 1];
       const { DevToolsShim } = ChromeUtils.importESModule("chrome://devtools-startup/content/DevToolsShim.sys.mjs");
       const tab = window.gBrowser.selectedTab;
       DevToolsShim.showToolboxForTab(tab, { toolId: "netmonitor" })
         .then(async (tb) => {
           await tb.selectTool("netmonitor");
           const api = await tb.getNetMonitorAPI();
           if (tb.currentToolId !== "netmonitor" || !api) {
             done({ error: "failed to activate netmonitor panel: " + String(tb.currentToolId) });
             return;
           }
           done({ ok: true });
         })
         .catch((err) => done({ error: String(err) }));`,
    ),
    signal,
  );
  checkChromeResult(result, "panel precondition");
}

async function verifyPanelRecordedRequests(
  session: CostArmSession,
  expectedCount: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await abortable(
    session.evaluateChrome(
      `const done = arguments[arguments.length - 1];
       const [expectedCount, timeoutMs] = arguments;
       const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
       const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
       const tb = gDevTools.getToolboxForTab(window.gBrowser.selectedTab);
       if (!tb || tb.currentToolId !== "netmonitor") {
         done({ error: "netmonitor panel not open after navigation" });
         return;
       }
       const deadline = Date.now() + timeoutMs;
       tb.getNetMonitorAPI()
         .then((net) => {
           const poll = () => {
             const reqs = net.store.getState().requests.requests;
             const count = reqs.size ?? reqs.length ?? 0;
             if (count >= expectedCount) {
               done({ ok: true, count });
               return;
             }
             if (Date.now() >= deadline) {
               done({ error: "netmonitor recorded " + String(count) + " requests, expected at least " + String(expectedCount) });
               return;
             }
             setTimeout(poll, 50);
           };
           poll();
         })
         .catch((err) => done({ error: String(err) }));`,
      [expectedCount, NETMONITOR_FLUSH_MS],
    ),
    signal,
  );
  checkChromeResult(result, "panel recording verification");
}

export async function readProcInfoFromChrome(
  session: Pick<CostArmSession, "evaluateChrome">,
): Promise<ProcInfoSample> {
  const result = await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     ChromeUtils.requestProcInfo()
       .then((info) => {
         const mainName = /^(MainThread|GeckoMain|Main Thread)$/;
         let byTid = null;
         let byName = null;
         for (const t of info.threads) {
           if (t.tid === info.pid) byTid = t.cpuTime;
           else if (byName === null && mainName.test(t.name || "")) byName = t.cpuTime;
         }
         if (byTid !== null) {
           done({ ok: true, mainThreadMs: byTid / 1e6, processCpuMs: info.cpuTime / 1e6, workingSetBytes: info.memory || 0, mainThreadHow: "tid" });
           return;
         }
         if (byName !== null) {
           done({ ok: true, mainThreadMs: byName / 1e6, processCpuMs: info.cpuTime / 1e6, workingSetBytes: info.memory || 0, mainThreadHow: "name" });
           return;
         }
         done({ error: "requestProcInfo returned no parent main thread for pid " + String(info.pid) });
       })
       .catch((err) => done({ error: String(err) }));`,
  );
  checkChromeResult(result, "requestProcInfo");
  const record = result as {
    mainThreadMs: number;
    processCpuMs: number;
    workingSetBytes: number;
    mainThreadHow: "tid" | "name";
  };
  return {
    mainThreadMs: record.mainThreadMs,
    processCpuMs: record.processCpuMs,
    workingSetBytes: record.workingSetBytes,
    mainThreadHow: record.mainThreadHow,
  };
}

// Force GC/CC, wait at least MIN_SETTLE_MS for first-run startup burst to clear, and require two consecutive quiet windows.
async function settleBeforeMeasurement(
  session: CostArmSession,
  readInfo: () => Promise<ProcInfoSample>,
  signal: AbortSignal,
): Promise<number> {
  const started = Date.now();
  await abortable(
    session.evaluateChrome(
      `const done = arguments[arguments.length - 1];
       Cu.forceGC();
       Cu.forceCC();
       Cu.forceGC();
       done({ ok: true });`,
    ),
    signal,
  );
  await abortable(delay(MIN_SETTLE_MS), signal);
  let previous = await readInfo();
  let quietWindows = 0;
  while (Date.now() - started < MAX_SETTLE_MS) {
    await abortable(delay(SETTLE_WINDOW_MS), signal);
    const current = await readInfo();
    const delta = current.mainThreadMs - previous.mainThreadMs;
    previous = current;
    if (delta <= SETTLE_QUIET_MAIN_MS) quietWindows += 1;
    else quietWindows = 0;
    if (quietWindows >= 2) break;
  }
  return Date.now() - started;
}

function checkChromeResult(result: unknown, label: string): void {
  if (typeof result === "object" && result !== null && "error" in result) {
    throw new Error(`${label} failed: ${String(result.error)}`);
  }
}

export function costBaselineFileName(result: CostScenarioResult, arm: "off" | "panel"): string {
  const base = baselineFileName(result).replace(/\.json$/u, "");
  return `${base}-${result.scenario}-${arm}.json`;
}

export async function writeCostBaselines(
  result: CostScenarioResult,
  outDir: string,
): Promise<readonly string[]> {
  if (result.errors > 0) {
    throw new Error(`refusing to write cost baselines with ${String(result.errors)} failed runs`);
  }
  await NodeFSP.mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (const arm of ["off", "panel"] as const) {
    const summary = result.arms[arm];
    const samples = result.scoredSamples.filter((sample) => sample.arm === arm);
    const file: CostBaselineFile = {
      capturedAt: new Date().toISOString(),
      scenario: result.scenario,
      cpuMetric: result.cpuMetric,
      arm,
      rounds: result.rounds,
      warmupDropped: 1,
      discardedRounds: result.discardedRounds,
      runCount: summary.scoredRunCount,
      errors: result.errors,
      failures: result.failures,
      samples,
      lastResourceFinishedMs: summary.lastResourceFinishedMs,
      parentMainThreadMs: summary.parentMainThreadMs,
      parentProcessCpuMs: summary.parentProcessCpuMs,
      parentWorkingSetBytes: summary.parentWorkingSetBytes,
      wallMs: summary.wallMs,
      browser: recordedBrowser(result.browser),
      machine: result.machine,
      load: result.load,
    };
    const path = NodePath.join(outDir, costBaselineFileName(result, arm));
    await NodeFSP.writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    paths.push(path);
  }
  return paths;
}

export function formatCostSummary(result: CostScenarioResult): string {
  const lines = [
    `${result.scenario}: ${result.browser.name} ${result.browser.version} (${result.browser.buildId}), metric=${result.cpuMetric}, ${String(result.rounds)} rounds (round 0 dropped, ${String(result.rounds - 1)} scored, ${String(result.discardedRounds.length)} discarded for load), ${String(result.errors)} errors`,
    `load before: cpu ${result.load.before.cpuBusyPercent.toFixed(1)}%, loadavg ${formatLoadAvg(result.load.before.loadAverage)}; after: cpu ${result.load.after.cpuBusyPercent.toFixed(1)}%, loadavg ${formatLoadAvg(result.load.after.loadAverage)}`,
  ];
  for (const arm of COST_ARMS) {
    const s = result.arms[arm];
    const main = s.parentMainThreadMs;
    const proc = s.parentProcessCpuMs;
    const last = s.lastResourceFinishedMs;
    lines.push(
      `  ${arm.padEnd(10)} n=${String(s.scoredRunCount)} main=${main ? `${main.median.toFixed(1)}ms (spread ${main.spread.toFixed(1)}ms)` : "n/a"} proc=${proc ? `${proc.median.toFixed(1)}ms` : "n/a"} last=${last ? `${last.median.toFixed(1)}ms` : "n/a"}`,
    );
  }
  if (result.budget.parentMainThreadMs !== null) {
    lines.push(`  budget main=${result.budget.parentMainThreadMs.toFixed(1)}ms`);
  }
  return lines.join("\n");
}

function formatLoadAvg(load: readonly number[] | null): string {
  if (load === null) return "n/a";
  return load.map((n) => n.toFixed(2)).join(" ");
}

function verifyCostRequests(
  report: {
    lastResourceFinishedMs: number;
    finished: readonly string[];
    failed: readonly string[];
  },
  served: readonly { readonly method: string; readonly path: string }[],
  scenario: MeasuredScenario,
): string | null {
  const problems: string[] = [];
  if (report.failed.length > 0) problems.push(`page failed ${report.failed.slice(0, 5).join(" ")}`);
  const resources = scenario.responses.filter((response) => response.path !== scenario.pagePath);
  const finished = new Set(report.finished);
  const unfinished = resources.filter((response) => !finished.has(response.path));
  if (unfinished.length > 0) {
    problems.push(`page did not finish ${String(unfinished.length)} resources`);
  }
  if (!(report.lastResourceFinishedMs > 0)) {
    problems.push(`last resource finished at ${String(report.lastResourceFinishedMs)} ms`);
  }
  const expected = scenario.responses.map((response) => `${response.method} ${response.path}`);
  const observed = served.map((request) => `${request.method} ${request.path}`);
  const missing = subtractMultiset(expected, observed);
  const extra = subtractMultiset(observed, expected);
  if (missing.length > 0) problems.push(`server never served ${String(missing.length)} expected`);
  if (extra.length > 0) problems.push(`server also served ${String(extra.length)} unexpected`);
  return problems.length === 0 ? null : problems.join("; ");
}

function subtractMultiset(values: readonly string[], remove: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of remove) counts.set(item, (counts.get(item) ?? 0) + 1);
  const left: string[] = [];
  for (const item of values) {
    const count = counts.get(item) ?? 0;
    if (count > 0) counts.set(item, count - 1);
    else left.push(item);
  }
  return left;
}

function parseReport(text: string): {
  lastResourceFinishedMs: number;
  finished: string[];
  failed: string[];
} {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("lastResourceFinishedMs" in parsed) ||
    typeof parsed.lastResourceFinishedMs !== "number" ||
    !("finished" in parsed) ||
    !Array.isArray(parsed.finished) ||
    !("failed" in parsed) ||
    !Array.isArray(parsed.failed)
  ) {
    throw new Error(`unexpected cost page report: ${text}`);
  }
  return {
    lastResourceFinishedMs: parsed.lastResourceFinishedMs,
    finished: parsed.finished.filter((item): item is string => typeof item === "string"),
    failed: parsed.failed.filter((item): item is string => typeof item === "string"),
  };
}

function defaultIdentity(binaryPath: string): BrowserIdentity {
  return {
    binaryPath,
    name: "unknown",
    version: "unknown",
    buildId: "unknown",
    userAgent: "",
    remoteProtocol: "marionette",
    headless: true,
  };
}

async function readMachineLoad(): Promise<MachineLoad> {
  const snap = (): { busy: number; total: number } => {
    let busy = 0;
    let total = 0;
    for (const cpu of NodeOS.cpus()) {
      const { idle, ...rest } = cpu.times;
      const used = rest.user + rest.nice + rest.sys + rest.irq;
      busy += used;
      total += used + idle;
    }
    return { busy, total };
  };
  const first = snap();
  await delay(250);
  const second = snap();
  const total = second.total - first.total;
  return {
    cpuBusyPercent: total > 0 ? Math.round(((second.busy - first.busy) / total) * 1000) / 10 : 0,
    loadAverage: NodeOS.platform() === "win32" ? null : NodeOS.loadavg(),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
