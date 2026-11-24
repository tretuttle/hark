// Runs the real-browser checks from tools/browser-harness against the packed extension XPI.
// Usage: pnpm run verify:browser [--binary <path>] [--xpi <path>] [--check <names>] [--short] [--show-window]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { runDiscoveredChecks } from "../../../tools/browser-harness/src/checks.ts";
import { BINARY_ENV, GECKO_BINARY_ENV } from "../../../tools/browser-harness/src/cli.ts";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));

  const { values } = NodeUtil.parseArgs({
    args,
    strict: true,
    options: {
      binary: { type: "string" },
      xpi: { type: "string", default: xpiPath(builtManifest.version) },
      check: { type: "string", default: "environment,restart" },
      short: { type: "boolean", default: false },
      "out-dir": { type: "string" },
      "show-window": { type: "boolean", default: false },
    },
  });

  const binary = values.binary ?? process.env[GECKO_BINARY_ENV] ?? process.env[BINARY_ENV];
  if (binary === undefined || binary.length === 0) {
    process.stderr.write(
      `usage: verify-browser --binary <path> [--xpi <path>] [--check <names>] [--short] [--show-window]\na browser binary is required: pass --binary <path> or set ${GECKO_BINARY_ENV}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const binaryPath = NodePath.resolve(binary);
  NodeFS.accessSync(binaryPath, NodeFS.constants.X_OK);

  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`${signal}: stopping browser check\n`);
    controller.abort(new Error(`interrupted by ${signal}`));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const filter = values.check === "all" ? [] : values.check.split(",").filter(Boolean);
  const result = await runDiscoveredChecks({
    filter,
    context: {
      binaryPath,
      extensionPath: NodePath.resolve(values.xpi),
      display: values["show-window"] ? "window" : "headless",
      short: values.short,
      outDir: values["out-dir"] === undefined ? null : NodePath.resolve(values["out-dir"]),
      signal: controller.signal,
      log: (line) => console.log(line),
    },
  });

  if (controller.signal.aborted || !result.ok) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
