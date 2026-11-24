import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runExportCrashCase } from "./export-crash-case.ts";
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
  "an export killed mid-write on a real browser (named parts)",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each([
      { unjournaledLeftover: false, caught: false },
      { unjournaledLeftover: true, caught: true },
    ])(
      "named part: true; unjournaled leftover: $unjournaledLeftover; leftover reported: $caught",
      async ({ unjournaledLeftover, caught }) => {
        const result = await runExportCrashCase({
          binaryPath: binary,
          extensionPath,
          namedParts: true,
          unjournaledLeftover,
        });
        expect(result.writingKind).toBe("writing");
        expect(result.beforeRestartNamed).toEqual(["killed.har.part"]);
        expect(result.leftoverProblems.length > 0).toBe(caught);
      },
    );
  },
);
