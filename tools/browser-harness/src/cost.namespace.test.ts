import { describe, expect, it } from "vite-plus/test";
import { COST_ARMS, measureCostScenario, type CostSample } from "./cost.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";

requireIsolatedPidNamespace();

// measureCostScenario launches real browsers unless a round runner is injected, so it is tested here.
describe("three-arm cost measurement", () => {
  it("discards and repeats rounds when machine load exceeds the threshold", async () => {
    // Simulate an overload after round 1's first attempt (8.5 > 8.0), followed by quiet retry.
    const loads = [
      { cpuBusyPercent: 2, loadAverage: [0.5, 0.5, 0.5] },
      { cpuBusyPercent: 2, loadAverage: [0.5, 0.5, 0.5] },
      { cpuBusyPercent: 3, loadAverage: [0.6, 0.5, 0.5] },
      { cpuBusyPercent: 4, loadAverage: [0.7, 0.5, 0.5] },
      { cpuBusyPercent: 5, loadAverage: [8.5, 2.0, 1.0] },
      { cpuBusyPercent: 3, loadAverage: [1.1, 1.0, 1.0] },
      { cpuBusyPercent: 3, loadAverage: [1.2, 1.0, 1.0] },
      { cpuBusyPercent: 2, loadAverage: [1.0, 1.0, 1.0] },
    ];
    let loadCursor = 0;
    let round1Attempt = 0;
    const result = await measureCostScenario({
      scenarioName: "cost-images",
      rounds: 2,
      binaryPath: "/fake",
      extensionPath: "/fake.xpi",
      display: "headless",
      signal: new AbortController().signal,
      readLoad: async () =>
        loads[loadCursor++] ?? { cpuBusyPercent: 1, loadAverage: [0.5, 0.5, 0.5] },
      cooldown: async () => undefined,
      runRound: async (round) => {
        if (round === 1) round1Attempt += 1;
        const cpu = round === 1 && round1Attempt === 1 ? 999 : 45;
        return {
          samples: COST_ARMS.map((arm) => sample(round, arm, arm === "panel" ? cpu * 3 : cpu)),
          failures: [],
          browserIdentity: null,
        };
      },
    });

    expect(result.discardedRounds).toHaveLength(1);
    expect(result.discardedRounds[0]?.round).toBe(1);
    expect(result.scoredSamples.every((s) => s.parentMainThreadMs < 500)).toBe(true);
    expect(result.arms.off.parentMainThreadMs?.median).toBe(45);
  });
});

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
