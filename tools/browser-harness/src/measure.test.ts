import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  baselineFileName,
  measureRuns,
  summarize,
  tallyRuns,
  writeBaseline,
  type BaselineCapture,
  type BaselineFile,
  type MeasureTarget,
  type RequestLog,
} from "./measure.ts";
import { SCENARIOS } from "./scenarios.ts";

const scenario = SCENARIOS.page;
const resourcePaths = scenario.responses
  .map((response) => response.path)
  .filter((path) => path !== scenario.pagePath);

type RunScript = {
  readonly evaluate?: () => Promise<string>;
  readonly closeTab?: () => Promise<void>;
  readonly served?: readonly { method: string; path: string }[];
};

function fakeRig(script: readonly RunScript[]): {
  browser: MeasureTarget;
  server: RequestLog;
} {
  let run = 0;
  let pending: readonly { method: string; path: string }[] = [];
  const current = (): RunScript => script[run - 1] ?? {};
  return {
    browser: {
      browserPid: 4242,
      openTab: async () => {
        run += 1;
        pending =
          current().served ??
          scenario.responses.map((response) => ({ method: response.method, path: response.path }));
        return `tab-${String(run)}`;
      },
      evaluate: async () =>
        current().evaluate?.() ??
        JSON.stringify({ lastResourceFinishedMs: 100 + run, finished: resourcePaths, failed: [] }),
      closeTab: async () => current().closeTab?.(),
    },
    server: {
      origin: "http://127.0.0.1:1",
      takeRequests: () => {
        const taken = pending;
        pending = [];
        return taken;
      },
    },
  };
}

function measure(script: readonly RunScript[], runs: number) {
  let cpu = 0;
  return measureRuns({
    ...fakeRig(script),
    scenario,
    runs,
    inspect: () => {
      cpu += 10;
      return { parentPid: 1, workingSetBytes: 1000, cpuTimeMs: cpu };
    },
    signal: new AbortController().signal,
  });
}

describe("measure runs", () => {
  it("keeps every run: a failed run is counted with its reason and the rest are sampled", async () => {
    const result = await measure(
      [{}, { evaluate: () => Promise.reject(new Error("script.evaluate timed out")) }, {}],
      3,
    );
    expect(result.samples.map((sample) => sample.run)).toEqual([1, 3]);
    expect(result.samples.map((sample) => sample.lastResourceFinishedMs)).toEqual([101, 103]);
    expect(result.failures).toEqual([{ run: 2, reason: "script.evaluate timed out" }]);
    const tally = tallyRuns(result, 3);
    expect(tally.errors).toBe(1);
    expect(tally.lastResourceFinishedMs?.runCount).toBe(2);
    expect(() => tallyRuns({ samples: result.samples, failures: [] }, 3)).toThrow(
      "3 runs requested, 2 sampled and 0 failed",
    );
  });

  it.each([
    {
      label: "a resource the page reports as failed",
      run: {
        evaluate: async () =>
          JSON.stringify({
            lastResourceFinishedMs: 50,
            finished: resourcePaths.slice(1),
            failed: [resourcePaths[0]],
          }),
      },
      reason: /page failed \/r\/css\/0/,
    },
    {
      label: "a resource the server never served",
      run: { served: [{ method: "GET", path: "/" }] },
      reason: /server never served GET \/r\/css\/0/,
    },
    {
      label: "a request the scenario did not ask for",
      run: {
        served: [
          ...scenario.responses.map((response) => ({
            method: response.method,
            path: response.path,
          })),
          { method: "GET", path: "/unexpected" },
        ],
      },
      reason: /server also served GET \/unexpected/,
    },
    {
      label: "a resource that never finished when the page reports no failure",
      run: {
        evaluate: async () =>
          JSON.stringify({
            lastResourceFinishedMs: 50,
            finished: resourcePaths.slice(1),
            failed: [],
          }),
      },
      reason: /page did not finish \/r\/css\/0/,
    },
    {
      label: "a sample of zero milliseconds",
      run: {
        evaluate: async () =>
          JSON.stringify({ lastResourceFinishedMs: 0, finished: resourcePaths, failed: [] }),
      },
      reason: /last resource finished at 0 ms/,
    },
    {
      label: "a tab that will not close",
      run: { closeTab: () => Promise.reject(new Error("no such frame")) },
      reason: /close tab: no such frame/,
    },
  ])("fails the run on $label", async ({ run, reason }) => {
    const result = await measure([run], 1);
    expect(result.samples).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(reason);
  });

  it("stops at once when interrupted instead of counting the interruption as a failed run", async () => {
    const controller = new AbortController();
    const rig = fakeRig([
      { evaluate: () => new Promise(() => controller.abort(new Error("SIGINT"))) },
    ]);
    await expect(
      measureRuns({
        ...rig,
        scenario,
        runs: 3,
        inspect: () => ({ parentPid: 1, workingSetBytes: 1, cpuTimeMs: 1 }),
        signal: controller.signal,
      }),
    ).rejects.toThrow("SIGINT");
  });

  it("reports the median, the spread, and the run count, and nothing for no runs", () => {
    expect(summarize([10, 1, 3, 2])).toEqual({
      median: 2.5,
      spread: 9,
      min: 1,
      max: 10,
      runCount: 4,
    });
    expect(summarize([4, 1, 9])?.median).toBe(4);
    expect(summarize([])).toBeNull();
  });
});

describe("baselines", () => {
  it("names a baseline after its machine, browser build and display", () => {
    expect(
      baselineFileName({
        machine: { platform: "linux", arch: "x64", cpuCount: 8, cpuModel: "Example CPU 9000" },
        browser: { name: "zen", version: "1.25t", buildId: "20261115114312", headless: true },
      }),
    ).toBe("linux-x64-8cpu-example-cpu-9000-zen-1.25t-20261115114312-headless.json");
  });

  it("writes no baseline file when any run failed, and none with the binary path", async () => {
    const outDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-baseline-"));
    const failed = { ...baselineStub(), errors: 2, failures: [{ run: 1, reason: "page failed" }] };
    await expect(writeBaseline(failed, outDir)).rejects.toThrow(
      "refusing to write a baseline with 2 failed runs",
    );
    expect(NodeFS.readdirSync(outDir)).toEqual([]);
    const written = await writeBaseline(baselineStub(), outDir);
    const file = JSON.parse(await NodeFSP.readFile(written, "utf8")) as BaselineFile;
    expect(NodePath.basename(written)).toBe(baselineFileName(file));
    expect(file.browser).toEqual(expect.objectContaining({ name: "zen", buildId: "1" }));
    expect(file.browser).not.toHaveProperty("binaryPath");
    expect(file.machine.release).toMatch(/^\d+(?:\.\d+)*$/u);
    expect(file.errors).toBe(0);
    expect(file.failures).toEqual([]);
    expect(file.samples).toHaveLength(file.runCount);
    expect(file.lastResourceFinishedMs).not.toBeNull();
    expect(file.parentWorkingSetBytes).not.toBeNull();
    expect(file.lastResourceFinishedMs?.runCount).toBe(file.runCount);
    expect(file.parentWorkingSetBytes?.runCount).toBe(file.runCount);
    await NodeFSP.rm(outDir, { recursive: true, force: true });
  });
});

function baselineStub(): BaselineCapture {
  return {
    capturedAt: "2026-11-16T00:00:00.000Z",
    extension: null,
    scenario: "page",
    sampleDefinition: "last-resource-finished",
    runCount: 1,
    errors: 0,
    failures: [],
    samples: [
      {
        run: 1,
        lastResourceFinishedMs: 10,
        parentWorkingSetBytes: 1,
        parentCpuMs: 1,
        wallMs: 1,
        requestCount: 1,
      },
    ],
    lastResourceFinishedMs: { median: 10, spread: 0, min: 10, max: 10, runCount: 1 },
    parentWorkingSetBytes: { median: 1, spread: 0, min: 1, max: 1, runCount: 1 },
    wallTimeMs: 1,
    browserCpuMs: 1,
    limiter: "parent CPU does not fill the timed region",
    browser: {
      binaryPath: "/zen",
      name: "zen",
      version: "1",
      buildId: "1",
      userAgent: "Mozilla",
      remoteProtocol: "bidi",
      headless: true,
    },
    machine: {
      platform: "linux",
      release: "1",
      arch: "x64",
      cpuModel: "test",
      cpuCount: 1,
      totalMemoryBytes: 1,
    },
    load: {
      before: { cpuBusyPercent: 0, loadAverage: [0, 0, 0] },
      after: { cpuBusyPercent: 0, loadAverage: [0, 0, 0] },
    },
    page: {
      resourceCount: 200,
      cache: "no-store",
      seed: "s",
      smallPerKind: 50,
      kinds: ["css", "js", "image", "json"],
    },
  };
}
