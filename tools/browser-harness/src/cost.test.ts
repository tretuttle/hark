import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  COST_ARMS,
  computeBudget,
  costBaselineFileName,
  detectSlowArchiveCost,
  detectSlowArm,
  highLoadReason,
  readProcInfoFromChrome,
  rotateArms,
  runCostArm,
  summarizeCostSamples,
  writeCostBaselines,
  type CostArmSession,
  type CostBaselineFile,
  type CostSample,
  type CostScenarioResult,
  type ProcInfoSample,
} from "./cost.ts";
import { getCostScenario } from "./scenarios.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("three-arm cost measurement", () => {
  it("rotates arms across rounds", () => {
    expect(COST_ARMS).toEqual(["off", "extension", "panel"]);
    expect(rotateArms(0)).toEqual(["off", "extension", "panel"]);
    expect(rotateArms(1)).toEqual(["extension", "panel", "off"]);
    expect(rotateArms(2)).toEqual(["panel", "off", "extension"]);
    expect(rotateArms(3)).toEqual(["off", "extension", "panel"]);
  });

  it("drops round 0 warmup and computes median and spread over scored rounds", () => {
    const samples: CostSample[] = [
      sample(0, "off", 999),
      sample(1, "off", 40),
      sample(2, "off", 50),
      sample(3, "off", 45),
      sample(0, "extension", 888),
      sample(1, "extension", 42),
      sample(2, "extension", 54),
      sample(3, "extension", 48),
    ];
    const offSummary = summarizeCostSamples(samples, "off");
    expect(offSummary.scoredRunCount).toBe(3);
    expect(offSummary.parentMainThreadMs).toEqual({
      median: 45,
      spread: 10,
      min: 40,
      max: 50,
      runCount: 3,
    });
    const extSummary = summarizeCostSamples(samples, "extension");
    expect(extSummary.parentMainThreadMs).toEqual({
      median: 48,
      spread: 12,
      min: 42,
      max: 54,
      runCount: 3,
    });
  });

  it("detects a slow arm exceeding off + half(panel - off)", () => {
    expect(computeBudget(40, 120)).toBe(80);
    expect(
      detectSlowArm({
        arm: "extension",
        observedMedianMs: 65,
        offMedianMs: 40,
        panelMedianMs: 120,
      }),
    ).toMatchObject({ ok: true, budgetMs: 80, reason: null });

    const slow = detectSlowArm({
      arm: "extension",
      observedMedianMs: 95,
      offMedianMs: 40,
      panelMedianMs: 120,
    });
    expect(slow.ok).toBe(false);
    expect(slow.reason).toMatch(/extension median 95\.0 ms exceeded budget 80\.0 ms/);

    expect(
      detectSlowArchiveCost({
        emptyDownloadMedianMs: 40,
        fullDownloadMedianMs: 48,
        emptyBrowseMedianMs: 280,
        fullBrowseMedianMs: 300,
      }),
    ).toMatchObject({
      ok: true,
      downloadBudgetMs: 68,
      browseBudgetMs: 345.4,
      reason: null,
    });

    const slowDownload = detectSlowArchiveCost({
      emptyDownloadMedianMs: 38.3,
      fullDownloadMedianMs: 75.8,
      emptyBrowseMedianMs: 280,
      fullBrowseMedianMs: 295,
    });
    expect(slowDownload.ok).toBe(false);
    expect(slowDownload.reason).toMatch(
      /10,000-file download median 75\.8 ms exceeded budget 65\.5 ms/,
    );

    const slowBrowse = detectSlowArchiveCost({
      emptyDownloadMedianMs: 40,
      fullDownloadMedianMs: 46,
      emptyBrowseMedianMs: 280,
      fullBrowseMedianMs: 365,
    });
    expect(slowBrowse.ok).toBe(false);
    expect(slowBrowse.reason).toMatch(
      /10,000-file browse median 365\.0 ms exceeded budget 345\.4 ms/,
    );
  });

  it("drives the panel arm through chrome toolbox open, netmonitor verification, and close", async () => {
    const scenario = getCostScenario("cost-images");
    const calls: string[] = [];
    let mainMs = 100;
    const result = await runCostArm({
      session: {
        openTab: async (url) => {
          calls.push(`open:${url}`);
          return "tab-1";
        },
        navigateTab: async (_ctx, url) => {
          calls.push(`nav:${url}`);
        },
        evaluate: async (_ctx, expr) => {
          calls.push(`eval:${expr}`);
          return JSON.stringify({
            lastResourceFinishedMs: 55,
            finished: scenario.responses
              .map((r) => r.path)
              .filter((path) => path !== scenario.pagePath),
            failed: [],
          });
        },
        evaluateChrome: async (script) => {
          if (script.includes("showToolboxForTab")) calls.push("chrome:openPanel");
          else if (script.includes("closeToolboxForTab")) calls.push("chrome:closePanel");
          else if (script.includes("getNetMonitorAPI")) calls.push("chrome:verifyPanelCount");
          else calls.push("chrome:precondition");
          return { ok: true, tool: "netmonitor", count: scenario.responses.length };
        },
        closeTab: async () => {
          calls.push("closeTab");
        },
      },
      server: makeMockServer(scenario.responses),
      scenario,
      round: 1,
      arm: "panel",
      addonId: "ext@test",
      popupPath: "action/index.html",
      signal: new AbortController().signal,
      readProcInfo: async () => {
        mainMs += 25;
        return procInfo(mainMs);
      },
      settle: async () => 50,
    });

    expect(calls).toEqual([
      "open:http://127.0.0.1:1234/",
      "closeTab",
      "open:about:blank",
      "chrome:precondition",
      "chrome:openPanel",
      "nav:http://127.0.0.1:1234/cost/images",
      "eval:window.__harnessReady",
      "chrome:verifyPanelCount",
      "chrome:closePanel",
      "closeTab",
    ]);
    expect(result.parentMainThreadMs).toBe(25);
    expect(result.lastResourceFinishedMs).toBe(55);
  });

  it("rejects failed preconditions across off, extension, and panel arms", async () => {
    const scenario = getCostScenario("cost-images");

    // Extension arm fails if policy is missing/inactive.
    await expect(
      runCostArm({
        session: {
          openTab: async () => "tab-1",
          navigateTab: async () => undefined,
          evaluate: async () => "{}",
          evaluateChrome: async () => ({ error: "extension policy missing for ext@test" }),
          closeTab: async () => undefined,
        },
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "extension",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/extension policy missing/);

    // Extension arm fails if experiment API fails or returns invalid data.
    await expect(
      runCostArm({
        session: {
          openTab: async () => "tab-1",
          navigateTab: async () => undefined,
          evaluate: async () => JSON.stringify({ error: "API crashed" }),
          evaluateChrome: async (script) =>
            script.includes("WebExtensionPolicy.getByID")
              ? { url: "moz-extension://x/action/index.html" }
              : { ok: true },
          closeTab: async () => undefined,
        },
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "extension",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/extension API returned invalid environment/);

    // Panel arm fails if Netmonitor recorded fewer requests than the server served.
    await expect(
      runCostArm({
        session: {
          openTab: async () => "tab-1",
          navigateTab: async () => undefined,
          evaluate: async () =>
            JSON.stringify({
              lastResourceFinishedMs: 20,
              finished: scenario.responses.map((r) => r.path),
              failed: [],
            }),
          evaluateChrome: async (script) => {
            if (script.includes("getNetMonitorAPI")) {
              return { error: "netmonitor recorded 0 requests, expected at least 201" };
            }
            return { ok: true };
          },
          closeTab: async () => undefined,
        },
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "panel",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/netmonitor recorded 0 requests/);

    // Off arm fails if unexpected extension/toolbox precondition reports error.
    await expect(
      runCostArm({
        session: {
          openTab: async () => "tab-1",
          navigateTab: async () => undefined,
          evaluate: async () => "{}",
          evaluateChrome: async () => ({
            error: "off arm requires extension absent, found ext@test",
          }),
          closeTab: async () => undefined,
        },
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "off",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/off precondition failed/);
  });

  it("rejects failed page resources, unexpected server requests and a recorder that missed one", async () => {
    const scenario = getCostScenario("cost-images");
    const baseSession: CostArmSession = {
      openTab: async () => "tab-1",
      navigateTab: async () => undefined,
      evaluate: async () =>
        JSON.stringify({
          lastResourceFinishedMs: 20,
          finished: scenario.responses.map((r) => r.path),
          failed: ["/cost/small/0.png"],
        }),
      evaluateChrome: async () => ({ ok: true }),
      closeTab: async () => undefined,
    };
    await expect(
      runCostArm({
        session: baseSession,
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "off",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/page failed \/cost\/small\/0\.png/);

    await expect(
      runCostArm({
        session: {
          ...baseSession,
          evaluate: async () =>
            JSON.stringify({
              lastResourceFinishedMs: 20,
              finished: scenario.responses.map((r) => r.path),
              failed: [],
            }),
        },
        server: makeMockServer([...scenario.responses, { method: "GET", path: "/unexpected.png" }]),
        scenario,
        round: 1,
        arm: "off",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
      }),
    ).rejects.toThrow(/server also served 1 unexpected/);

    const cleanSession: CostArmSession = {
      ...baseSession,
      evaluate: async () =>
        JSON.stringify({
          lastResourceFinishedMs: 20,
          finished: scenario.responses.map((r) => r.path),
          failed: [],
        }),
    };
    const served = scenario.responses.map((r) => `${r.method} ${r.path}`);
    const withRecorded = (recorded: readonly string[]) =>
      runCostArm({
        session: cleanSession,
        server: makeMockServer(scenario.responses),
        scenario,
        round: 1,
        arm: "off",
        addonId: "ext@test",
        popupPath: "action/index.html",
        signal: new AbortController().signal,
        readProcInfo: async () => procInfo(10),
        settle: async () => 10,
        readRecorded: async () => recorded,
      });
    await expect(withRecorded(served)).resolves.toMatchObject({ arm: "off" });
    await expect(withRecorded(served.slice(1))).rejects.toThrow(
      new RegExp(`recorder missed 1 of ${String(served.length)} served requests`),
    );
  });

  it("reads parent main-thread CPU time by tid === pid from ChromeUtils.requestProcInfo", async () => {
    const info = await readProcInfoFromChrome({
      evaluateChrome: async (script) =>
        new Promise((resolve) => {
          const fn = new Function("ChromeUtils", "arguments", script) as (
            cu: {
              requestProcInfo: () => Promise<{
                pid: number;
                cpuTime: number;
                memory: number;
                threads: Array<{ tid: number; name: string; cpuTime: number }>;
              }>;
            },
            args: unknown[],
          ) => void;
          fn(
            {
              requestProcInfo: async () => ({
                pid: 42,
                cpuTime: 120_000_000,
                memory: 256_000_000,
                threads: [
                  { tid: 99, name: "MainThread", cpuTime: 90_000_000 },
                  { tid: 42, name: "gecko", cpuTime: 45_500_000 },
                ],
              }),
            },
            [resolve],
          );
        }),
    });
    expect(info).toEqual({
      mainThreadMs: 45.5,
      processCpuMs: 120,
      workingSetBytes: 256_000_000,
      mainThreadHow: "tid",
    });
  });

  it("classifies a round as overloaded by CPU busy percent or 1-minute loadavg", () => {
    expect(highLoadReason({ cpuBusyPercent: 30, loadAverage: [1.0, 1.0, 1.0] })).toMatch(/cpu/);
    expect(highLoadReason({ cpuBusyPercent: 5, loadAverage: [8.3, 4.0, 2.0] })).toMatch(/loadavg/);
    expect(highLoadReason({ cpuBusyPercent: 5, loadAverage: [1.5, 1.2, 1.0] })).toBeNull();
  });

  it("refuses to write cost baselines when errors > 0 and writes off and panel when errors === 0", async () => {
    const outDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-cost-"));
    cleanupDirs.push(outDir);
    const failed = costResultStub(1);
    await expect(writeCostBaselines(failed, outDir)).rejects.toThrow(
      /refusing to write cost baselines with 1 failed runs/,
    );
    expect(NodeFS.readdirSync(outDir)).toEqual([]);

    const ok = costResultStub(0);
    const written = await writeCostBaselines(ok, outDir);
    expect(written).toHaveLength(2);
    const arms: string[] = [];
    for (const filePath of written) {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as CostBaselineFile;
      arms.push(parsed.arm);
      expect(["off", "panel"]).toContain(parsed.arm);
      expect(NodePath.basename(filePath)).toBe(costBaselineFileName(ok, parsed.arm));
      expect(parsed.errors).toBe(0);
      expect(parsed.failures).toEqual([]);
      expect(parsed.cpuMetric).toBe("parent-main-thread");
      expect(parsed.warmupDropped).toBe(1);
      expect(parsed.runCount).toBe(1);
      expect(parsed.samples).toHaveLength(parsed.runCount);
      expect(parsed.parentMainThreadMs?.runCount).toBe(parsed.runCount);
      expect(parsed.lastResourceFinishedMs?.runCount).toBe(parsed.runCount);
      expect(parsed.load.before).toBeDefined();
      expect(parsed.load.after).toBeDefined();
      expect(parsed.browser).toEqual(expect.objectContaining({ name: "zen", version: "1.25t" }));
      expect(parsed.browser).not.toHaveProperty("binaryPath");
      expect(parsed.machine.release).toMatch(/^\d+(?:\.\d+)*$/u);
    }
    expect(arms).toEqual(["off", "panel"]);
  });
});

function makeMockServer(responses: readonly { readonly method: string; readonly path: string }[]) {
  return {
    origin: "http://127.0.0.1:1234",
    takeRequests: () =>
      responses.map((r, index) => ({
        seq: index + 1,
        method: r.method,
        path: r.path,
        url: r.path,
        status: 200,
      })),
  };
}

function procInfo(mainThreadMs: number): ProcInfoSample {
  return {
    mainThreadMs,
    processCpuMs: mainThreadMs * 2,
    workingSetBytes: 500_000_000,
    mainThreadHow: "tid",
  };
}

function sample(round: number, arm: CostSample["arm"], cpuMs: number): CostSample {
  return {
    round,
    arm,
    lastResourceFinishedMs: cpuMs + 5,
    parentWorkingSetBytes: 600_000_000,
    parentMainThreadMs: cpuMs,
    parentProcessCpuMs: cpuMs * 2,
    wallMs: cpuMs + 20,
    settleMs: 2500,
    requestCount: 201,
  };
}

function costResultStub(errors: number): CostScenarioResult {
  const offSample = sample(1, "off", 40);
  const extSample = sample(1, "extension", 42);
  const panelSample = sample(1, "panel", 120);
  const all = [offSample, extSample, panelSample];
  return {
    scenario: "cost-images",
    cpuMetric: "parent-main-thread",
    rounds: 2,
    warmupDropped: 1,
    discardedRounds: [],
    errors,
    failures: errors === 0 ? [] : [{ run: 1, reason: "page failed" }],
    warmupSamples: [],
    scoredSamples: all,
    arms: {
      off: summarizeCostSamples(all, "off"),
      extension: summarizeCostSamples(all, "extension"),
      panel: summarizeCostSamples(all, "panel"),
    },
    budget: { parentMainThreadMs: 80, lastResourceFinishedMs: 85 },
    browser: {
      binaryPath: "/zen",
      name: "zen",
      version: "1.25t",
      buildId: "20261115114312",
      userAgent: "Mozilla",
      remoteProtocol: "marionette",
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
      before: { cpuBusyPercent: 1, loadAverage: [0.1, 0.1, 0.1] },
      after: { cpuBusyPercent: 1, loadAverage: [0.1, 0.1, 0.1] },
    },
  };
}
