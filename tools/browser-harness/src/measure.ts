import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  launchBrowser,
  type BrowserDisplay,
  type BrowserIdentity,
  type BrowserSession,
} from "./browser.ts";
import type { RemoteProtocol } from "./remote.ts";
import { FIXTURE_SEED, SMALL_KINDS, SMALL_PER_KIND } from "./fixtures.ts";
import { readProcessSnapshot, type ProcessSnapshot } from "./process-table.ts";
import { SCENARIOS, type MeasuredScenario } from "./scenarios.ts";
import { startFixtureServer } from "./server.ts";

const SAMPLE_DEFINITION = "last-resource-finished";

export type Summary = {
  readonly median: number;
  readonly spread: number;
  readonly min: number;
  readonly max: number;
  readonly runCount: number;
};

export type MeasureSample = {
  readonly run: number;
  readonly lastResourceFinishedMs: number;
  readonly parentWorkingSetBytes: number;
  readonly parentCpuMs: number;
  readonly wallMs: number;
  readonly requestCount: number;
};

export type FailedRun = {
  readonly run: number;
  readonly reason: string;
};

export type RunsResult = {
  readonly samples: readonly MeasureSample[];
  readonly failures: readonly FailedRun[];
};

export type MachineInfo = {
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
};

export type MachineLoad = {
  readonly cpuBusyPercent: number;
  readonly loadAverage: readonly number[] | null;
};

export type MeasureResult = {
  readonly scenario: string;
  readonly sampleDefinition: typeof SAMPLE_DEFINITION;
  readonly runCount: number;
  readonly errors: number;
  readonly failures: readonly FailedRun[];
  readonly samples: readonly MeasureSample[];
  readonly lastResourceFinishedMs: Summary | null;
  readonly parentWorkingSetBytes: Summary | null;
  readonly wallTimeMs: number;
  readonly browserCpuMs: number;
  readonly limiter: string;
  readonly extensionPath: string | null;
  readonly browser: BrowserIdentity;
  readonly machine: MachineInfo;
  readonly load: { readonly before: MachineLoad; readonly after: MachineLoad };
};

/** The browser as a baseline file records it: its build, without the local binary path. */
export type RecordedBrowser = Omit<BrowserIdentity, "binaryPath">;

export type BaselineCapture = Omit<MeasureResult, "extensionPath"> & {
  readonly capturedAt: string;
  readonly extension: null;
  readonly page: {
    readonly resourceCount: number;
    readonly cache: "no-store";
    readonly seed: string;
    readonly smallPerKind: number;
    readonly kinds: readonly string[];
  };
};

export type BaselineFile = Omit<BaselineCapture, "browser"> & { readonly browser: RecordedBrowser };

export function recordedBrowser(identity: BrowserIdentity): RecordedBrowser {
  const { binaryPath: _binaryPath, ...recorded } = identity;
  return recorded;
}

export type MeasureTarget = Pick<
  BrowserSession,
  "browserPid" | "openTab" | "evaluate" | "closeTab"
>;
export type RequestLog = {
  readonly origin: string;
  readonly takeRequests: () => readonly { readonly method: string; readonly path: string }[];
};

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (index: number): number => sorted[index] ?? Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
  const min = at(0);
  const max = at(sorted.length - 1);
  return { median, spread: max - min, min, max, runCount: values.length };
}

export async function measureRuns(options: {
  readonly browser: MeasureTarget;
  readonly server: RequestLog;
  readonly scenario: MeasuredScenario;
  readonly runs: number;
  readonly inspect: (pid: number) => ProcessSnapshot;
  readonly signal: AbortSignal;
}): Promise<RunsResult> {
  const { browser, server, scenario, signal } = options;
  const samples: MeasureSample[] = [];
  const failures: FailedRun[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    signal.throwIfAborted();
    server.takeRequests();
    let context: string | null = null;
    let sample: MeasureSample | null = null;
    let reason: string | null = null;
    try {
      const before = options.inspect(browser.browserPid);
      const started = process.hrtime.bigint();
      context = await abortable(browser.openTab(`${server.origin}${scenario.pagePath}`), signal);
      const report = parsePageReport(
        await abortable(browser.evaluate(context, "window.__harnessReady"), signal),
      );
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const after = options.inspect(browser.browserPid);
      const served = server.takeRequests();
      const problem = runProblem(report, served, scenario);
      if (problem !== null) throw new Error(problem);
      sample = {
        run,
        lastResourceFinishedMs: report.lastResourceFinishedMs,
        parentWorkingSetBytes: after.workingSetBytes,
        parentCpuMs: after.cpuTimeMs - before.cpuTimeMs,
        wallMs,
        requestCount: served.length,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      reason = errorMessage(error);
    }
    if (context !== null) {
      try {
        await browser.closeTab(context);
      } catch (error) {
        reason = `${reason === null ? "" : `${reason}; `}close tab: ${errorMessage(error)}`;
      }
    }
    if (reason !== null) failures.push({ run, reason });
    else if (sample !== null) samples.push(sample);
  }
  return { samples, failures };
}

export type RunTally = Pick<
  MeasureResult,
  | "sampleDefinition"
  | "runCount"
  | "errors"
  | "failures"
  | "samples"
  | "lastResourceFinishedMs"
  | "parentWorkingSetBytes"
  | "wallTimeMs"
  | "browserCpuMs"
  | "limiter"
>;

export function tallyRuns(runs: RunsResult, runCount: number): RunTally {
  const { samples, failures } = runs;
  if (samples.length + failures.length !== runCount) {
    throw new Error(
      `${String(runCount)} runs requested, ${String(samples.length)} sampled and ${String(failures.length)} failed`,
    );
  }
  const wallTimeMs = sum(samples.map((sample) => sample.wallMs));
  const browserCpuMs = sum(samples.map((sample) => sample.parentCpuMs));
  return {
    sampleDefinition: SAMPLE_DEFINITION,
    runCount,
    errors: failures.length,
    failures,
    samples,
    lastResourceFinishedMs: summarize(samples.map((sample) => sample.lastResourceFinishedMs)),
    parentWorkingSetBytes: summarize(samples.map((sample) => sample.parentWorkingSetBytes)),
    wallTimeMs,
    browserCpuMs,
    limiter: limiterNote(wallTimeMs, browserCpuMs),
  };
}

export async function measurePage(options: {
  readonly runs: number;
  readonly binaryPath: string;
  readonly extensionPath: string | null;
  readonly display: BrowserDisplay;
  readonly protocol?: RemoteProtocol;
  readonly signal: AbortSignal;
}): Promise<MeasureResult> {
  await using server = await startFixtureServer();
  await using browser = await launchBrowser({
    binaryPath: options.binaryPath,
    extensionPath: options.extensionPath,
    display: options.display,
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    signal: options.signal,
  });
  const loadBefore = await machineLoad();
  const scenario = SCENARIOS.page;
  const runs = await measureRuns({
    browser,
    server,
    scenario,
    runs: options.runs,
    inspect: readProcessSnapshot,
    signal: options.signal,
  });
  const loadAfter = await machineLoad();
  return {
    scenario: scenario.name,
    ...tallyRuns(runs, options.runs),
    extensionPath: options.extensionPath,
    browser: browser.identity,
    machine: machineInfo(),
    load: { before: loadBefore, after: loadAfter },
  };
}

export async function captureBaseline(options: {
  readonly runs: number;
  readonly binaryPath: string;
  readonly display: BrowserDisplay;
  readonly protocol?: RemoteProtocol;
  readonly outDir: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly file: BaselineCapture; readonly path: string }> {
  const { extensionPath: _extension, ...measured } = await measurePage({
    runs: options.runs,
    binaryPath: options.binaryPath,
    extensionPath: null,
    display: options.display,
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    signal: options.signal,
  });
  const file: BaselineCapture = {
    capturedAt: new Date().toISOString(),
    extension: null,
    page: {
      resourceCount: SMALL_KINDS.length * SMALL_PER_KIND,
      cache: "no-store",
      seed: FIXTURE_SEED,
      smallPerKind: SMALL_PER_KIND,
      kinds: SMALL_KINDS,
    },
    ...measured,
  };
  const path = await writeBaseline(file, options.outDir);
  return { file, path };
}

export async function writeBaseline(capture: BaselineCapture, outDir: string): Promise<string> {
  if (capture.errors > 0) {
    const reasons = capture.failures
      .map((failure) => `run ${String(failure.run)}: ${failure.reason}`)
      .join("; ");
    throw new Error(
      `refusing to write a baseline with ${String(capture.errors)} failed runs${reasons.length > 0 ? `: ${reasons}` : ""}`,
    );
  }
  const file: BaselineFile = { ...capture, browser: recordedBrowser(capture.browser) };
  const path = NodePath.join(outDir, baselineFileName(file));
  await NodeFSP.mkdir(outDir, { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return path;
}

// Two baselines compare only when every part of this name matches.
export function baselineFileName(baseline: {
  readonly machine: Pick<MachineInfo, "platform" | "arch" | "cpuCount" | "cpuModel">;
  readonly browser: Pick<BrowserIdentity, "name" | "version" | "buildId" | "headless">;
}): string {
  const { machine, browser } = baseline;
  return `${[
    machine.platform,
    machine.arch,
    `${String(machine.cpuCount)}cpu`,
    slug(machine.cpuModel),
    slug(browser.name),
    slug(browser.version),
    slug(browser.buildId),
    browser.headless ? "headless" : "window",
  ].join("-")}.json`;
}

type PageReport = {
  readonly lastResourceFinishedMs: number;
  readonly finished: readonly string[];
  readonly failed: readonly string[];
};

function runProblem(
  report: PageReport,
  served: readonly { readonly method: string; readonly path: string }[],
  scenario: MeasuredScenario,
): string | null {
  const problems: string[] = [];
  if (report.failed.length > 0) problems.push(`page failed ${report.failed.join(" ")}`);
  const resources = scenario.responses.filter((response) => response.path !== scenario.pagePath);
  const finished = new Set(report.finished);
  const unfinished = resources.filter((response) => !finished.has(response.path));
  if (unfinished.length > 0) {
    problems.push(`page did not finish ${unfinished.map((response) => response.path).join(" ")}`);
  }
  if (!(report.lastResourceFinishedMs > 0)) {
    problems.push(`last resource finished at ${String(report.lastResourceFinishedMs)} ms`);
  }
  const expected = scenario.responses.map((response) => `${response.method} ${response.path}`);
  const observed = served.map((request) => `${request.method} ${request.path}`);
  const missing = without(expected, observed);
  const extra = without(observed, expected);
  if (missing.length > 0) problems.push(`server never served ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`server also served ${extra.join(", ")}`);
  return problems.length === 0 ? null : problems.join("; ");
}

function without(values: readonly string[], remove: readonly string[]): string[] {
  const left = [...values];
  for (const value of remove) {
    const index = left.indexOf(value);
    if (index !== -1) left.splice(index, 1);
  }
  return left;
}

function parsePageReport(text: string): PageReport {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.lastResourceFinishedMs !== "number" ||
    !isStringArray(value.finished) ||
    !isStringArray(value.failed)
  ) {
    throw new Error(`page report was ${text}`);
  }
  return {
    lastResourceFinishedMs: value.lastResourceFinishedMs,
    finished: value.finished,
    failed: value.failed,
  };
}

export function machineInfo(): MachineInfo {
  const cpus = NodeOS.cpus();
  return {
    platform: NodeOS.platform(),
    release: kernelVersion(NodeOS.release()),
    arch: NodeOS.arch(),
    cpuModel: cpus[0]?.model.trim() || "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: NodeOS.totalmem(),
  };
}

// Only the numeric version: a Linux release string goes on to name the distribution's kernel build.
function kernelVersion(release: string): string {
  return /^\d+(?:\.\d+)*/u.exec(release)?.[0] ?? "unknown";
}

async function machineLoad(): Promise<MachineLoad> {
  const busy = (): { busy: number; total: number } => {
    let busyTime = 0;
    let total = 0;
    for (const cpu of NodeOS.cpus()) {
      const { idle, ...rest } = cpu.times;
      const used = rest.user + rest.nice + rest.sys + rest.irq;
      busyTime += used;
      total += used + idle;
    }
    return { busy: busyTime, total };
  };
  const first = busy();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const second = busy();
  const total = second.total - first.total;
  return {
    cpuBusyPercent: total > 0 ? Math.round(((second.busy - first.busy) / total) * 1000) / 10 : 0,
    loadAverage: NodeOS.platform() === "win32" ? null : NodeOS.loadavg(),
  };
}

function limiterNote(wallTimeMs: number, browserCpuMs: number): string {
  if (!(wallTimeMs > 0)) return "No run completed, so there is no wall time.";
  const share = browserCpuMs / wallTimeMs;
  const percent = String(Math.round(share * 100));
  const verdict =
    share >= 0.4
      ? "so parent CPU is on the critical path"
      : "so parent CPU does not fill the timed region";
  return `The browser parent used ${percent} percent of one core while runs were timed, ${verdict}. A timed region runs from opening the tab to the page reporting its last resource finished. Process inspection happens outside it. Each run loaded 200 uncached localhost resources.`;
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

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
