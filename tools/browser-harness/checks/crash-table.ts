import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  CRASH_ROWS,
  killAtPoint,
  runCrashRow,
  runRow17bCorrupt,
  runRow17Corrupt,
} from "../src/kill-at-point.ts";

/**
 * Kills the browser at crash rows 1, 3, 6, 14, 16 (torn .summary.json.tmp) and 18, writes an unreadable summary
 * (row 17) and a valid but stale summary after a whole-line append (row 17b), and checks that every next start's
 * recovery plan and the archive after recovery match the table.
 */
const check: HarnessCheck = {
  name: "crash-table",
  description:
    "crash rows 1, 3, 6, 14, 16, 18 killed at point and rows 17, 17b stale summaries re-summarized",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null) {
      return { name: "crash-table", ok: false, durationMs: 0, detail: "needs --extension" };
    }
    const options = {
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      signal: context.signal,
      kill: killAtPoint,
    };
    const problems: string[] = [];
    const results: Array<{ readonly row: number | string; readonly steps: readonly string[] }> = [];
    for (const row of CRASH_ROWS) {
      const outcome = await runCrashRow(row, options);
      results.push({ row: row.row, steps: outcome.steps });
      problems.push(...outcome.problems);
    }
    const row17 = await runRow17Corrupt(options);
    results.push({ row: 17, steps: row17.steps });
    problems.push(...row17.problems);
    const row17b = await runRow17bCorrupt(options);
    results.push({ row: "17b", steps: row17b.steps });
    problems.push(...row17b.problems);

    return {
      name: "crash-table",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `rows 1,3,6,14,16,18 killed at point and rows 17,17b stale summaries re-summarized (${results.map((r) => `${String(r.row)}:[${r.steps.join(",")}]`).join(" ")})`
          : problems.join("; "),
      data: { results },
    };
  },
};

/** @discovered-check */
export default check;
