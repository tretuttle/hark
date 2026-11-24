import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { detectSlowArm, formatCostSummary, measureCostScenario } from "../src/cost.ts";
import type { CostScenarioName } from "../src/scenarios.ts";

const check: HarnessCheck = {
  name: "cost-baseline",
  description:
    "runs rotated three-arm cost measurement (off, extension, panel) with round 0 dropped",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null || !NodeFS.existsSync(context.extensionPath)) {
      return {
        name: "cost-baseline",
        ok: false,
        durationMs: Date.now() - started,
        detail:
          context.extensionPath === null
            ? "missing --extension path for cost-baseline check"
            : `extension path does not exist for cost-baseline check: ${context.extensionPath}`,
      };
    }
    const scenarios: readonly CostScenarioName[] = context.short
      ? ["cost-images"]
      : ["cost-images", "cost-heavy", "cost-mixed"];
    const rounds = context.short ? 3 : 6;
    const results = [];
    const problems: string[] = [];

    for (const scenarioName of scenarios) {
      const result = await measureCostScenario({
        scenarioName,
        rounds,
        binaryPath: context.binaryPath,
        extensionPath: context.extensionPath,
        display: context.display,
        signal: context.signal,
      });
      context.log(formatCostSummary(result));
      results.push(result);
      if (result.errors > 0) {
        problems.push(
          `${scenarioName}: ${String(result.errors)} failed runs (${result.failures.map((f) => f.reason).join("; ")})`,
        );
      }
      const offCpu = result.arms.off.parentMainThreadMs;
      const extCpu = result.arms.extension.parentMainThreadMs;
      const panelCpu = result.arms.panel.parentMainThreadMs;
      if (offCpu !== null && extCpu !== null && panelCpu !== null) {
        // Short CI profile gets only 10 ms slack with 2 scored runs; full run uses exact budget.
        const slow = detectSlowArm({
          arm: "extension",
          observedMedianMs: extCpu.median,
          offMedianMs: offCpu.median,
          panelMedianMs: panelCpu.median,
          slackMs: context.short ? 10 : 0,
        });
        if (!slow.ok && slow.reason !== null) problems.push(`${scenarioName}: ${slow.reason}`);
      }
    }

    if (context.outDir !== null) {
      await NodeFSP.mkdir(context.outDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(context.outDir, "cost-baseline.json"),
        `${JSON.stringify(results, null, 2)}\n`,
        "utf8",
      );
    }

    return {
      name: "cost-baseline",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `measured ${scenarios.join(", ")} (${String(rounds)} rounds, round 0 dropped, 0 errors)`
          : problems.join("; "),
      data: results,
    };
  },
};

/** @discovered-check */
export default check;
