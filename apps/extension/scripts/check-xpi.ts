// Fails if anything in a packed XPI is not production output; the rules are the tables in xpi-rules.ts. Fails closed:
// xpi-check-child.ts reads the files in a child process, and a file it cannot decode, parse or minify, a rule that throws,
// or a child that crashes or runs out of time on it prints a cannot-check line naming the file.
// Usage: pnpm run check:xpi [path to xpi] [--timeout-ms <ms per child run>]
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";
import type { CheckEvent, Measurement, Violation } from "./xpi-check-child.ts";

/** The rule a file fails when the check cannot inspect it, for any reason. */
export const CANNOT_CHECK = "cannot-check";

const childScript = NodePath.join(import.meta.dirname, "xpi-check-child.ts");

interface Report {
  readonly measurements: ReadonlyArray<readonly [string, Measurement]>;
  readonly violations: readonly Violation[];
}

const parseEvent = (line: string): CheckEvent | undefined => {
  try {
    return JSON.parse(line) as CheckEvent;
  } catch {
    // A torn line is a child that did not finish; the file it was on is reported below.
    return undefined;
  }
};

const whyStopped = (run: NodeChildProcess.SpawnSyncReturns<string>, timeoutMs: number): string => {
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    return `the child process ran past ${timeoutMs} ms`;
  if (run.signal !== null) return `the child process was killed by ${run.signal}`;
  const stderr = (run.stderr ?? "").trim().split("\n").at(-1) ?? "";
  return `the child process exited with code ${String(run.status)}${stderr === "" ? "" : ` (${stderr.slice(0, 200)})`}`;
};

export const checkXpi = (xpi: string, timeoutMs: number): Report => {
  const measurements: Array<readonly [string, Measurement]> = [];
  const violations: Violation[] = [];
  let after = -1;
  for (;;) {
    const run = NodeChildProcess.spawnSync(
      process.execPath,
      [...process.execArgv, childScript, xpi, String(after)],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1 << 30,
      },
    );
    let current: { readonly index: number; readonly path: string } | undefined;
    let finished = false;
    for (const event of (run.stdout ?? "").split("\n").filter(Boolean).map(parseEvent)) {
      if (event?.event === "start") current = event;
      else if (event?.event === "done") {
        violations.push(...event.violations);
        if (event.measurement !== undefined) measurements.push([event.path, event.measurement]);
        after = event.index;
        current = undefined;
      } else if (event?.event === "end") finished = true;
    }
    if (finished && run.status === 0) break;
    if (current === undefined) {
      violations.push({
        path: NodePath.basename(xpi),
        rule: CANNOT_CHECK,
        detail: `${whyStopped(run, timeoutMs)} without checking the next file`,
      });
      break;
    }
    violations.push({
      path: current.path,
      rule: CANNOT_CHECK,
      detail: `${whyStopped(run, timeoutMs)} while checking this file`,
    });
    after = current.index;
  }
  return { measurements, violations };
};

if (import.meta.main) {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { "timeout-ms": { type: "string", default: "120000" } },
  });
  const xpi = NodePath.resolve(
    positionals[0] ?? xpiPath(readManifest(NodePath.join(buildDir, "manifest.json")).version),
  );
  const { measurements, violations } = checkXpi(xpi, Number(values["timeout-ms"]));
  for (const [path, { bytes, saved, margin }] of measurements)
    console.log(
      `${path.padEnd(32)} ${String(bytes).padStart(7)} B  re-minify saves ${String(saved).padStart(5)} B (margin ${margin})`,
    );
  for (const { path, rule, detail } of violations)
    console.error(`FAIL ${path}: ${rule}: ${detail}`);
  console.log(
    `${violations.length === 0 ? "PASS" : "FAIL"} ${NodePath.basename(xpi)}: ${violations.length} violations`,
  );
  process.exitCode = violations.length === 0 ? 0 : 1;
}
