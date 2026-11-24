import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CRASH_ROWS, runCrashRow } from "./kill-at-point.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";

requireIsolatedPidNamespace();

const binary = process.env.BROWSER_HARNESS_BINARY ?? "";
const distDir = NodePath.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "extension",
  "dist",
);
const xpi = NodeFS.existsSync(distDir)
  ? (NodeFS.readdirSync(distDir).find((name) => /^hark-.*\.xpi$/.test(name)) ?? null)
  : null;

describe.runIf(binary !== "" && NodeFS.existsSync(binary) && xpi !== null)(
  "crash table on a real browser (early rows)",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each(CRASH_ROWS.slice(0, 3))(
      "row $row: killed during $diedDuring, the next start plans and reads as the table says",
      async (row) => {
        const result = await runCrashRow(row, {
          binaryPath: binary,
          extensionPath,
          display: "headless",
          signal: new AbortController().signal,
        });
        expect(result.steps).toEqual(row.plan);
        expect(result.problems).toEqual([]);
      },
    );
  },
);
