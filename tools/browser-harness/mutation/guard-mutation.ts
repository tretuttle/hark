import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  collectOutput,
  currentIsolation,
  launcherCommand,
  namespaceUnavailableReason,
  requireIsolatedPidNamespace,
  spawnIsolated,
} from "../src/namespace-isolation.ts";
import { removeOwnedTempTree } from "../src/temp-tree.ts";
import { applyMutant, generateMutants, type Mutant, type Scope } from "./operators.ts";

// Mutation testing for the guard: every mutant of the signal decisions, the performer and the
// namespace launcher must fail a test, or be listed in equivalent-mutants.json with its reason.
// It runs only inside a PID and user namespace, and each test run gets a nested one of its own.

const PACKAGE_DIR = NodePath.resolve(import.meta.dirname, "..");
const REPO_ROOT = NodePath.resolve(PACKAGE_DIR, "..", "..");
const PACKAGE_PATH = NodePath.relative(REPO_ROOT, PACKAGE_DIR);
const EQUIVALENT_FILE = NodePath.join(import.meta.dirname, "equivalent-mutants.json");
const RELAUNCHED_ENV = "HARK_GUARD_MUTATION_RELAUNCHED";

const GUARD_SCOPE: readonly Scope[] = [
  { file: "src/signal-policy.ts", names: "all" },
  {
    file: "src/owned-process.ts",
    names: [
      "HOST_PERFORMERS",
      "taskkillArgs",
      "signalPerformer",
      "hostProcessIo",
      "spawnOwned",
      "stopOwnedTree",
    ],
  },
  {
    file: "src/namespace-isolation.ts",
    names: "all",
    except: ["findRepoRoot", "collectOutput", "summarizeRun"],
  },
  { file: "src/browser.ts", names: ["spawnLeasedBrowser"] },
  { file: "src/orphan-lease.ts", names: ["isPositiveInteger", "isNonEmptyString", "parseLease"] },
];

// The guard's own fixed-data tests; the namespaced suites run only for mutants these miss.
const FIXED_DATA_ARGS = [
  "src/signal-policy.test.ts",
  "src/owned-process.test.ts",
  "src/orphan-lease.test.ts",
  "src/namespace-isolation.test.ts",
  "src/browser.test.ts",
  "--testTimeout",
  "15000",
];
const NAMESPACED_ARGS = ["src/namespace-suites.test.ts"];
// Seconds before coreutils `timeout` ends a run inside its namespace; the namespace's teardown
// then ends whatever that run left behind. A mutant that loops forever counts as killed.
const FIXED_DATA_TIMEOUT_S = 30;
const NAMESPACED_TIMEOUT_S = 180;
const TIMED_OUT_EXITS = new Set([124, 137]);
// Root files Vite needs to load the config, and the package itself.
const COPIED_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "vite.config.ts",
  "tsconfig.base.json",
];
const UNSHARED_CACHE_DIRS = new Set([".vitest-cache", ".vite", ".cache"]);

// "error" is a failed run that names no failing test: a broken run, never counted as a kill.
type RunStatus = "passed" | "failed" | "timeout" | "error";
type Outcome = {
  readonly mutant: Mutant;
  readonly status: "killed" | "timeout" | "survived" | "error";
  readonly phase: "fixed-data" | "namespaced" | null;
  readonly failing: readonly string[];
};

function parseArgs(argv: readonly string[]) {
  const only: string[] = [];
  let workers = Math.min(NodeOS.availableParallelism(), 8);
  let report: string | null = null;
  let fixedDataOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--fixed-data-only") {
      fixedDataOnly = true;
      continue;
    }
    if (flag === "--only" && value !== undefined) only.push(value);
    else if (flag === "--workers" && value !== undefined) workers = Math.max(1, Number(value));
    else if (flag === "--report" && value !== undefined) report = NodePath.resolve(value);
    else throw new Error(`unknown argument ${String(flag)}`);
    index += 1;
  }
  return { only, workers, report, fixedDataOnly };
}

async function relaunchIsolated(): Promise<number> {
  const unavailable = namespaceUnavailableReason();
  if (unavailable !== null) {
    throw new Error(
      `guard mutation testing runs only inside a PID and user namespace, and this machine refused one: ${unavailable}`,
    );
  }
  const child = spawnIsolated(
    launcherCommand([process.execPath, import.meta.filename, ...process.argv.slice(2)]),
    { cwd: PACKAGE_DIR, env: { ...process.env, [RELAUNCHED_ENV]: "1" } },
  );
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function makeWorkerCopy(root: string, index: number): Promise<string> {
  const copy = NodePath.join(root, `w${String(index)}`);
  for (const file of COPIED_ROOT_FILES) {
    await NodeFSP.cp(NodePath.join(REPO_ROOT, file), NodePath.join(copy, file));
  }
  await NodeFSP.cp(PACKAGE_DIR, NodePath.join(copy, PACKAGE_PATH), {
    recursive: true,
    filter: (source) => !source.split(NodePath.sep).includes("node_modules"),
  });
  // Dependencies are shared by symlink; each copy keeps its own test caches.
  for (const dir of [REPO_ROOT, PACKAGE_DIR]) {
    const target = NodePath.join(copy, NodePath.relative(REPO_ROOT, dir), "node_modules");
    await NodeFSP.mkdir(target, { recursive: true });
    for (const entry of await NodeFSP.readdir(NodePath.join(dir, "node_modules"))) {
      if (UNSHARED_CACHE_DIRS.has(entry)) continue;
      await NodeFSP.symlink(
        NodePath.join(dir, "node_modules", entry),
        NodePath.join(target, entry),
      );
    }
  }
  await NodeFSP.mkdir(NodePath.join(copy, "tmp"));
  return copy;
}

async function runTests(
  copy: string,
  extraArgs: readonly string[],
  timeoutSeconds: number,
): Promise<{
  readonly status: RunStatus;
  readonly failing: readonly string[];
  readonly output: string;
}> {
  const packageDir = NodePath.join(copy, PACKAGE_PATH);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    TMPDIR: NodePath.join(copy, "tmp"),
  };
  // The run is not a namespaced suite: it names no host sentinel, so the tests prove their own.
  delete env.HARK_NAMESPACE_RUN;
  delete env.HARK_HOST_SENTINEL;
  delete env[RELAUNCHED_ENV];
  const launch = launcherCommand([
    "timeout",
    "--kill-after=10",
    String(timeoutSeconds),
    NodePath.join(copy, "node_modules", ".bin", "vp"),
    "test",
    "run",
    "--config",
    NodePath.join(copy, "vite.config.ts"),
    "--dir",
    packageDir,
    ...extraArgs,
  ]);
  const child = NodeChildProcess.spawn(launch.command, launch.args, { cwd: packageDir, env });
  const { code, output: colored } = await collectOutput(child);
  const output = colored.replaceAll(/\u001b\[[0-9;]*m/gu, "");
  // Failing tests, and errors Vitest caught outside any test (it fails the run for those too).
  const unhandled = /^\s*Errors\s+\d+ errors?/mu.test(output)
    ? [`unhandled: ${/^\w*Error: .*$/mu.exec(output)?.[0] ?? "error"}`]
    : [];
  const failing = [
    ...new Set([...output.matchAll(/^\s*FAIL\s+(.+)$/gmu)].map((m) => m[1]?.trim() ?? "")),
    ...unhandled,
  ];
  const status: RunStatus =
    code === 0
      ? "passed"
      : code !== null && TIMED_OUT_EXITS.has(code)
        ? "timeout"
        : failing.length > 0
          ? "failed"
          : "error";
  return { status, failing: status === "error" ? [output.trim().slice(-2000)] : failing, output };
}

async function pool<T, R>(
  items: readonly T[],
  workers: number,
  work: (item: T, worker: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async (_unused, worker) => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index] as T, worker);
      }
    }),
  );
  return results;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!currentIsolation().isolated) {
    if (process.env[RELAUNCHED_ENV] === "1") requireIsolatedPidNamespace();
    return relaunchIsolated();
  }
  requireIsolatedPidNamespace();

  const sources = new Map(
    GUARD_SCOPE.map((scope) => [
      scope.file,
      NodeFS.readFileSync(NodePath.join(PACKAGE_DIR, scope.file), "utf8"),
    ]),
  );
  const generated = GUARD_SCOPE.flatMap((scope) =>
    generateMutants(scope, sources.get(scope.file) ?? ""),
  );
  const mutants =
    options.only.length === 0
      ? generated
      : generated.filter((m) => options.only.some((part) => m.key.includes(part)));
  const equivalent = JSON.parse(NodeFS.readFileSync(EQUIVALENT_FILE, "utf8")) as Record<
    string,
    string
  >;
  const started = Date.now();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-guard-mutation-"));
  try {
    const copies = await Promise.all(
      Array.from({ length: options.workers }, (_unused, index) => makeWorkerCopy(root, index)),
    );
    const firstCopy = copies[0] ?? "";
    for (const [phase, args, timeout] of [
      ["fixed-data", FIXED_DATA_ARGS, FIXED_DATA_TIMEOUT_S],
      ["namespaced", NAMESPACED_ARGS, NAMESPACED_TIMEOUT_S],
    ] as const) {
      const baseline = await runTests(firstCopy, args, timeout);
      if (baseline.status !== "passed") {
        process.stderr.write(
          `${baseline.output}\nthe unmutated ${phase} tests did not pass (${baseline.status}); no mutant was run\n`,
        );
        return 1;
      }
    }
    process.stdout.write(
      `guard mutation: ${String(mutants.length)} mutants, ${String(options.workers)} workers\n`,
    );

    const tryMutant = async (mutant: Mutant, copy: string, phase: "fixed-data" | "namespaced") => {
      const target = NodePath.join(copy, PACKAGE_PATH, mutant.file);
      const pristine = sources.get(mutant.file) ?? "";
      await NodeFSP.writeFile(target, applyMutant(pristine, mutant));
      const once = () =>
        phase === "fixed-data"
          ? runTests(copy, FIXED_DATA_ARGS, FIXED_DATA_TIMEOUT_S)
          : runTests(copy, NAMESPACED_ARGS, NAMESPACED_TIMEOUT_S);
      try {
        const first = await once();
        // A broken run is retried, and so is a kill of a listed equivalent, which only a flaky
        // test could cause; the second run decides.
        const listed = equivalent[mutant.key] !== undefined;
        return first.status === "error" || (listed && first.status !== "passed")
          ? await once()
          : first;
      } finally {
        await NodeFSP.writeFile(target, pristine);
      }
    };
    const record = (
      mutant: Mutant,
      phase: "fixed-data" | "namespaced",
      run: Awaited<ReturnType<typeof runTests>>,
    ): Outcome => {
      const outcome: Outcome = {
        mutant,
        status: (
          { passed: "survived", timeout: "timeout", failed: "killed", error: "error" } as const
        )[run.status],
        phase: run.status === "passed" ? null : phase,
        failing: run.failing,
      };
      if (outcome.status !== "survived") {
        process.stdout.write(`  ${outcome.status} (${phase}) ${mutant.key}\n`);
      }
      return outcome;
    };

    const fixed = await pool(mutants, copies.length, async (mutant, worker) =>
      record(
        mutant,
        "fixed-data",
        await tryMutant(mutant, copies[worker] ?? firstCopy, "fixed-data"),
      ),
    );
    const missed = (options.fixedDataOnly ? [] : fixed)
      .filter((outcome) => outcome.status === "survived")
      .map((outcome) => outcome.mutant);
    // The namespaced suites time real signals, so they run at most two at a time.
    const namespaced = await pool(missed, Math.min(2, copies.length), async (mutant, worker) =>
      record(
        mutant,
        "namespaced",
        await tryMutant(mutant, copies[worker] ?? firstCopy, "namespaced"),
      ),
    );
    const outcomes = options.fixedDataOnly
      ? fixed
      : [...fixed.filter((outcome) => outcome.status !== "survived"), ...namespaced];

    const survivors = outcomes.filter((outcome) => outcome.status === "survived");
    const unlisted = survivors.filter((outcome) => equivalent[outcome.mutant.key] === undefined);
    const listedButKilled = outcomes.filter(
      (outcome) =>
        (outcome.status === "killed" || outcome.status === "timeout") &&
        equivalent[outcome.mutant.key] !== undefined,
    );
    const broken = outcomes.filter((outcome) => outcome.status === "error");
    const generatedKeys = new Set(generated.map((mutant) => mutant.key));
    const stale =
      options.only.length === 0
        ? Object.keys(equivalent).filter((key) => !generatedKeys.has(key))
        : [];
    const count = (predicate: (outcome: Outcome) => boolean) =>
      String(outcomes.filter(predicate).length);
    const summary = [
      `guard mutation: ${String(mutants.length)} mutants of ${String(GUARD_SCOPE.length)} files in ${String(Math.round((Date.now() - started) / 1000))} s`,
      `  killed by fixed-data tests:      ${count((o) => o.status === "killed" && o.phase === "fixed-data")}`,
      `  killed only by namespaced suites: ${count((o) => o.status === "killed" && o.phase === "namespaced")}`,
      `  killed by timeout:                ${count((o) => o.status === "timeout")}`,
      `  equivalent (listed):              ${String(survivors.length - unlisted.length)}`,
      `  survived, not listed:             ${String(unlisted.length)}`,
      `  broken runs:                      ${count((o) => o.status === "error")}`,
      ...outcomes
        .filter((o) => o.status === "error")
        .map((o) => `    BROKEN RUN ${o.mutant.key}\n${o.failing.join("\n")}`),
      ...unlisted.map((o) => `    SURVIVED ${o.mutant.key} (line ${String(o.mutant.line)})`),
      ...listedButKilled.map((o) => `    KILLED BUT LISTED AS EQUIVALENT ${o.mutant.key}`),
      ...stale.map((key) => `    LISTED BUT NOT GENERATED ${key}`),
    ].join("\n");
    process.stdout.write(`${summary}\n`);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      await NodeFSP.appendFile(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${summary}\n\`\`\`\n`);
    }
    if (options.report !== null) {
      await NodeFSP.writeFile(
        options.report,
        `${JSON.stringify(
          outcomes.map((o) => ({
            key: o.mutant.key,
            line: o.mutant.line,
            status: o.status,
            phase: o.phase,
            failing: o.failing,
          })),
          null,
          1,
        )}\n`,
      );
    }
    return unlisted.length + listedButKilled.length + stale.length + broken.length === 0 ? 0 : 1;
  } finally {
    await removeOwnedTempTree(root, NodeOS.tmpdir());
  }
}

process.exitCode = await main();
