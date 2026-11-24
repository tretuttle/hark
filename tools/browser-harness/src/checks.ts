import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { BrowserDisplay } from "./browser.ts";

export type CheckContext = {
  readonly binaryPath: string;
  readonly extensionPath: string | null;
  readonly display: BrowserDisplay;
  readonly short: boolean;
  readonly outDir: string | null;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
};

export type CheckResult = {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly detail: string;
  readonly data?: unknown;
};

export type HarnessCheck = {
  readonly name: string;
  readonly description: string;
  readonly run: (context: CheckContext) => Promise<CheckResult>;
};

export type DiscoveredChecksRun = {
  readonly ok: boolean;
  readonly results: readonly CheckResult[];
};

function defaultChecksDir(): string {
  return NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "checks");
}

export async function discoverChecks(
  checksDir: string = defaultChecksDir(),
  readdir: (dir: string) => Promise<readonly string[]> = (dir) => NodeFSP.readdir(dir),
): Promise<readonly HarnessCheck[]> {
  const entries = (await readdir(checksDir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .sort((left, right) => left.localeCompare(right));
  const checks: HarnessCheck[] = [];
  for (const entry of entries) {
    const filePath = NodePath.join(checksDir, entry);
    const expectedName = entry.slice(0, -".ts".length);
    const loaded: unknown = await import(NodeURL.pathToFileURL(filePath).href);
    const check = extractCheck(loaded, filePath, expectedName);
    checks.push(check);
  }
  if (checks.length === 0) {
    throw new Error(`no check files discovered in ${checksDir}`);
  }
  return checks;
}

function formatCheckError(error: unknown, depth = 0): string {
  if (depth > 4) return "...";
  if (typeof SuppressedError === "function" && error instanceof SuppressedError) {
    return `${formatCheckError(error.error, depth + 1)}; suppressed during disposal: ${formatCheckError(error.suppressed, depth + 1)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runDiscoveredChecks(options: {
  readonly checksDir?: string;
  readonly filter?: readonly string[];
  /** Names left out; each must name a discovered check, so a renamed check cannot silently run in two jobs. */
  readonly skip?: readonly string[];
  readonly context: CheckContext;
}): Promise<DiscoveredChecksRun> {
  const discovered = await discoverChecks(options.checksDir);
  const filter = options.filter ?? [];
  const selected =
    filter.length === 0
      ? discovered
      : filter.map((name) => {
          const found = discovered.find((item) => item.name === name);
          if (found === undefined) {
            throw new Error(
              `unknown check ${name}; discovered: ${discovered.map((item) => item.name).join(", ")}`,
            );
          }
          return found;
        });

  const skip = options.skip ?? [];
  for (const name of skip)
    if (!discovered.some((item) => item.name === name))
      throw new Error(
        `unknown check ${name} in --skip; discovered: ${discovered.map((item) => item.name).join(", ")}`,
      );
  const results: CheckResult[] = [];
  for (const item of selected.filter((check) => !skip.includes(check.name))) {
    options.context.signal.throwIfAborted();
    options.context.log(`running check: ${item.name} (${item.description})`);
    const started = Date.now();
    let result: CheckResult;
    try {
      result = await item.run(options.context);
    } catch (error) {
      if (options.context.signal.aborted) throw error;
      result = {
        name: item.name,
        ok: false,
        durationMs: Date.now() - started,
        detail: formatCheckError(error),
      };
    }
    results.push(result);
    options.context.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.name} (${String(result.durationMs)} ms): ${result.detail}`,
    );
  }

  if (options.context.outDir !== null) {
    await NodeFSP.mkdir(options.context.outDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(options.context.outDir, "check-results.json"),
      `${JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

function extractCheck(loaded: unknown, filePath: string, expectedName: string): HarnessCheck {
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error(`check module ${filePath} is not an object`);
  }
  const candidate =
    "default" in loaded ? loaded.default : "check" in loaded ? loaded.check : undefined;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("name" in candidate) ||
    !("description" in candidate) ||
    !("run" in candidate) ||
    typeof candidate.name !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.run !== "function"
  ) {
    throw new Error(`check export in ${filePath} is invalid`);
  }
  if (candidate.name !== expectedName) {
    throw new Error(
      `check name ${candidate.name} in ${filePath} must match filename ${expectedName}`,
    );
  }
  return candidate as HarnessCheck;
}
