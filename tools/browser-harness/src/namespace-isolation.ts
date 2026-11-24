import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readHostProcessTable, readProcessIdentity } from "./process-table.ts";
import type { ProcessTable } from "./signal-policy.ts";
import { removeOwnedTempTree } from "./temp-tree.ts";

// Real-signal suites live in `*.namespace.test.ts` files. The root Vite config runs them only when
// this variable is set, and each of those files proves its isolation before defining a test.
const NAMESPACE_RUN_ENV = "HARK_NAMESPACE_RUN";
const HOST_SENTINEL_ENV = "HARK_HOST_SENTINEL";
export const LAUNCHER_MARKER = "hark-pid-namespace-launcher";
const LAUNCHER_REFUSED_EXIT = 97;

export type IsolationVerdict =
  | { readonly isolated: true }
  | { readonly isolated: false; readonly reason: string };

type Sentinel = { readonly pid: number; readonly startTime: string };
type IsolationCase = { readonly table: ProcessTable; readonly sentinel: Sentinel };

const ISOLATION_RULES: readonly ((c: IsolationCase) => string | null)[] = [
  (c) => {
    const init = c.table.get(1);
    return init?.args.includes(LAUNCHER_MARKER) === true
      ? null
      : `PID 1 is not the namespace launcher (${init?.commandLine ?? "absent"})`;
  },
  (c) =>
    c.table.get(c.sentinel.pid)?.startTime === c.sentinel.startTime
      ? `host process ${String(c.sentinel.pid)} is visible, so this /proc is the host's`
      : null,
  (c) => {
    for (const identity of c.table.values()) {
      if (!descendsFromInit(identity.pid, c.table)) {
        return `process ${String(identity.pid)} (${identity.commandLine}) does not descend from the launcher`;
      }
    }
    return null;
  },
];

// Isolated means: PID 1 is our launcher, a host process we named is invisible, and every visible
// process descends from the launcher.
export function checkIsolation(input: {
  readonly table: ProcessTable;
  readonly sentinel: string | undefined;
}): IsolationVerdict {
  const sentinel = parseSentinel(input.sentinel);
  if (sentinel === null) {
    return { isolated: false, reason: `no host process was named in ${HOST_SENTINEL_ENV}` };
  }
  for (const rule of ISOLATION_RULES) {
    const reason = rule({ table: input.table, sentinel });
    if (reason !== null) return { isolated: false, reason };
  }
  return { isolated: true };
}

function parseSentinel(text: string | undefined): Sentinel | null {
  const match = /^(\d+):(\d+)$/u.exec(text ?? "");
  if (match === null) return null;
  return { pid: Number(match[1]), startTime: match[2] ?? "" };
}

// Follows parent links up to PID 1. A missing parent or a loop in the links ends the walk.
function descendsFromInit(pid: number, table: ProcessTable): boolean {
  const visited = new Set<number>();
  let current = table.get(pid);
  while (current !== undefined) {
    if (current.pid === 1) return true;
    if (visited.has(current.pid)) return false;
    visited.add(current.pid);
    current = current.parentPid === null ? undefined : table.get(current.parentPid);
  }
  return false;
}

// Checks the namespace this process runs in, from its own /proc.
export function currentIsolation(platform: NodeJS.Platform = process.platform): IsolationVerdict {
  return platform === "linux"
    ? checkIsolation({ table: readHostProcessTable(), sentinel: process.env[HOST_SENTINEL_ENV] })
    : { isolated: false, reason: `PID namespaces are Linux-only (${platform})` };
}

export function requireIsolatedPidNamespace(): void {
  const verdict = currentIsolation();
  if (!verdict.isolated) {
    throw new Error(
      `refusing to run real-signal tests outside an isolated PID namespace: ${verdict.reason}`,
    );
  }
}

export type NamespaceRun =
  | { readonly outcome: "passed"; readonly summary: string }
  | { readonly outcome: "unavailable"; readonly reason: string }
  | { readonly outcome: "failed"; readonly detail: string };

const LAUNCHER_SCRIPT = `[ "$$" = 1 ] || { echo "namespace launcher is PID $$, not 1" >&2; exit ${String(LAUNCHER_REFUSED_EXIT)}; }
"$@"
exit $?`;

const CORE_LIMIT = ["prlimit", "--core=1:1", "--"];

// `--kill-child` ends the namespace, and everything in it, when the unshare process is stopped.
export function launcherCommand(command: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: "unshare",
    args: [
      "--user",
      "--map-current-user",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child",
      "--",
      "sh",
      "-c",
      LAUNCHER_SCRIPT,
      LAUNCHER_MARKER,
      ...CORE_LIMIT,
      ...command,
    ],
  };
}

export function namespacedSuitesCommand(repoRoot: string, packageDir: string): Launch {
  return launcherCommand([
    NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
    "test",
    "run",
    "--config",
    NodePath.join(repoRoot, "vite.config.ts"),
    "--dir",
    packageDir,
  ]);
}

// Asks only whether this machine grants an unprivileged user namespace, and shares no flags with
// the launcher, so a mistake in the launcher's flags fails the run instead of reading as a refusal.
export function namespaceUnavailableReason(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "linux") return `PID namespaces are Linux-only (${platform})`;
  return probeRefusal(
    NodeChildProcess.spawnSync("unshare", ["--user", "--map-current-user", "true"], {
      encoding: "utf8",
    }),
  );
}

export function probeRefusal(probe: {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): string | null {
  if (probe.error !== undefined) return probe.error.message;
  if (probe.status === 0) return null;
  return `${probe.stderr}${probe.stdout}`.trim() || `unshare exited ${String(probe.status)}`;
}

export type Launch = ReturnType<typeof launcherCommand>;

// Starts a launch, naming this process as the host sentinel that must stay invisible inside.
export function spawnIsolated(
  launch: Launch,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
): NodeChildProcess.ChildProcess {
  const sentinel = readProcessIdentity(process.pid);
  if (sentinel === undefined) throw new Error("could not read this process's start time");
  return NodeChildProcess.spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: { ...options.env, [HOST_SENTINEL_ENV]: `${String(process.pid)}:${sentinel.startTime}` },
  });
}

// Runs every `*.namespace.test.ts` file of one package inside a fresh PID and user namespace,
// under a 1-byte core limit and a private TMPDIR so lease files never meet the host's.
export async function runNamespacedSuites(
  packageDir: string,
  unavailable: string | null = namespaceUnavailableReason(),
  isolation: IsolationVerdict = currentIsolation(),
): Promise<NamespaceRun> {
  if (isolation.isolated) {
    return {
      outcome: "failed",
      detail: "refusing to start a nested namespaced run inside an isolated PID namespace",
    };
  }
  if (unavailable !== null) return { outcome: "unavailable", reason: unavailable };
  const repoRoot = findRepoRoot(packageDir);
  const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-ns-tmp-"));
  try {
    const child = spawnIsolated(namespacedSuitesCommand(repoRoot, packageDir), {
      cwd: packageDir,
      env: { ...process.env, [NAMESPACE_RUN_ENV]: "1", TMPDIR: tmpdir },
    });
    const result = await collectOutput(child);
    return namespacedOutcome(result.code, result.output);
  } finally {
    await removeOwnedTempTree(tmpdir);
  }
}

function findRepoRoot(startDir: string): string {
  let current = NodePath.resolve(startDir);
  while (!NodeFS.existsSync(NodePath.join(current, "pnpm-workspace.yaml"))) {
    const parent = NodePath.dirname(current);
    if (parent === current) throw new Error(`could not locate repo root from ${startDir}`);
    current = parent;
  }
  return current;
}

export function collectOutput(
  child: NodeChildProcess.ChildProcess,
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

export function namespacedOutcome(code: number | null, output: string): NamespaceRun {
  return code === 0
    ? { outcome: "passed", summary: summarizeRun(output) }
    : { outcome: "failed", detail: `exit ${String(code)}\n${output.trim()}` };
}

function summarizeRun(output: string): string {
  return output
    .replaceAll(/\u001b\[[0-9;]*m/gu, "")
    .split("\n")
    .filter((line) => /^\s*(Test Files|Tests)\s/u.test(line))
    .join("\n");
}
