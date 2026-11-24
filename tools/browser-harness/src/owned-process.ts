import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import {
  currentPlatformName,
  hostPlatform,
  readHarnessSelf,
  readHostProcessTable,
  readStartTime,
} from "./process-table.ts";
import {
  adoptSpawnedChild,
  nextStopStep,
  redeemOrder,
  START_STOP,
  type HarnessSelf,
  type Ownership,
  type ProcessTable,
  type SignalOrder,
  type StopSignal,
  type StopState,
} from "./signal-policy.ts";

// Everything a stop needs from the system. Decisions take this data; `perform` is the only effect.
export type ProcessIo = {
  readonly groupSignals: boolean;
  readonly self: () => HarnessSelf;
  readonly table: () => ProcessTable;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly perform: (order: SignalOrder) => boolean;
};

const HOST_PERFORMERS: Readonly<
  Record<"posix" | "win32", (rawTarget: number, signal: StopSignal) => void>
> = {
  posix: (rawTarget, signal) => process.kill(rawTarget, signal),
  // Running taskkill is not observed on Linux; its arguments are tested.
  win32: (rawTarget, signal) => runTaskkill(taskkillArgs(rawTarget, signal)),
};

// The whole tree (/T), closed gracefully for SIGTERM and forced (/F) only for SIGKILL.
export function taskkillArgs(rawTarget: number, signal: StopSignal): string[] {
  return ["/PID", String(rawTarget), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
}

// Every performer, the host's and the simulated one, redeems the order before sending anything.
// False means the target was already gone; any other failure is thrown.
export function signalPerformer(
  send: (rawTarget: number, signal: StopSignal) => void,
): (order: SignalOrder) => boolean {
  return (order) => {
    const { rawTarget, signal } = redeemOrder(order);
    try {
      send(rawTarget, signal);
      return true;
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false;
      throw error;
    }
  };
}

export function hostProcessIo(): ProcessIo {
  return {
    groupSignals: hostPlatform().groupSignals,
    self: readHarnessSelf,
    table: readHostProcessTable,
    now: Date.now,
    sleep: delay,
    perform: signalPerformer(
      HOST_PERFORMERS[currentPlatformName() === "win32" ? "win32" : "posix"],
    ),
  };
}

export const STDERR_DRAIN_GRACE_MS = 100;
const STOP_POLL_MS = 50;

export type OwnedChild = {
  readonly child: NodeChildProcess.ChildProcess;
  readonly pid: number;
  // Null when the child was gone before its start time could be read; there is nothing to stop.
  readonly ownership: Ownership | null;
};

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio?: NodeChildProcess.StdioOptions;
    readonly profileDir?: string | undefined;
  } = {},
): OwnedChild {
  const child = NodeChildProcess.spawn(command, args, {
    detached: hostPlatform().groupSignals,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  const startTime = readStartTime(child.pid);
  return {
    child,
    pid: child.pid,
    ownership:
      startTime === undefined
        ? null
        : adoptSpawnedChild({
            pid: child.pid,
            startTime,
            profileDir: options.profileDir ?? null,
          }),
  };
}

export async function stopOwnedTree(
  io: ProcessIo,
  root: Ownership | null,
  from: StopState = START_STOP,
): Promise<void> {
  if (root === null) return;
  const self = io.self();
  let state = from;
  for (;;) {
    const step = nextStopStep({
      root,
      state,
      table: io.table(),
      now: io.now(),
      self,
      groupSignals: io.groupSignals,
    });
    switch (step.kind) {
      case "done":
        return;
      case "fail":
        throw new Error(`owned process still running: ${step.running.join(", ")}`);
      case "refuse":
        throw new Error(step.reasons.join("; "));
      case "signal":
        for (const order of step.orders) io.perform(order);
        state = step.next;
        break;
      case "wait":
        await io.sleep(STOP_POLL_MS);
        state = step.next;
        break;
    }
  }
}

/**
 * A crash at a point the caller chose: the same stop, entered past its SIGTERM step, so the SIGKILL still comes from
 * decideSignal. Only namespace tests call it.
 */
export const killOwnedTree = (io: ProcessIo, root: Ownership | null): Promise<void> =>
  stopOwnedTree(io, root, { step: "terminating", since: Number.NEGATIVE_INFINITY, members: [] });

export type ChildExitResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly status: string;
  readonly stderr: string;
};

export type ChildExitWatcher = {
  readonly exited: Promise<ChildExitResult>;
  readonly status: () => string | null;
  readonly stderr: () => string;
};

function formatExitStatus(code: number | null, signal: NodeJS.Signals | string | null): string {
  if (code !== null) return `code ${String(code)}`;
  if (signal !== null) return `signal ${signal}`;
  return "code 0";
}

export function watchChildExit(
  child: NodeChildProcess.ChildProcess,
  options: { readonly stderrMaxBytes?: number } = {},
): ChildExitWatcher {
  const maxBytes = options.stderrMaxBytes ?? 4000;
  let stderrTail = "";
  let settledStatus: string | null = null;
  let streamClosed = child.stderr === null;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-maxBytes);
  });

  const exited = new Promise<ChildExitResult>((resolve) => {
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null; status: string } | null =
      null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = (): void => {
      if (done || exitInfo === null) return;
      done = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      settledStatus = exitInfo.status;
      child.stderr?.destroy?.();
      resolve({
        code: exitInfo.code,
        signal: exitInfo.signal,
        status: exitInfo.status,
        stderr: stderrTail,
      });
    };

    const markStreamDone = (): void => {
      streamClosed = true;
      finish();
    };
    child.stderr?.once("end", markStreamDone);
    child.once("close", markStreamDone);

    child.once("exit", (code, signal) => {
      exitInfo = { code, signal, status: formatExitStatus(code, signal) };
      if (streamClosed) {
        finish();
        return;
      }
      // Report on `exit` after a short bounded drain so descendants holding stderr cannot wedge failure reporting.
      graceTimer = setTimeout(finish, STDERR_DRAIN_GRACE_MS);
      graceTimer.unref();
    });
  });

  return {
    exited,
    status: () => settledStatus,
    stderr: () => stderrTail,
  };
}

const PROFILE_REMOVAL_MS = 15_000;
const REMOVAL_SCRIPT =
  'require("node:fs").rmSync(process.env.PROFILE_DIR,{recursive:true,force:true,maxRetries:50,retryDelay:100})';

export async function removeDirectoryBounded(io: ProcessIo, directory: string): Promise<void> {
  const worker = spawnOwned(process.execPath, ["-e", REMOVAL_SCRIPT], {
    env: { ...process.env, PROFILE_DIR: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const watcher = watchChildExit(worker.child, { stderrMaxBytes: 2000 });
  const exit = await Promise.race([
    watcher.exited,
    delay(PROFILE_REMOVAL_MS).then(() => "timeout" as const),
  ]);
  if (exit === "timeout") {
    await stopOwnedTree(io, worker.ownership);
    throw new Error(
      `profile removal timed out after ${String(PROFILE_REMOVAL_MS)} ms at ${directory}`,
    );
  }
  if (exit.code !== 0) {
    throw new Error(
      `profile removal exited ${String(exit.code ?? exit.signal ?? 1)} at ${directory}\n${exit.stderr.trim()}`,
    );
  }
  if (NodeFS.existsSync(directory)) throw new Error(`profile still present at ${directory}`);
}

export function isTaskkillGone(status: number | null, detail: string): boolean {
  return status === 128 || /not found|no running instance of the task/iu.test(detail);
}

export function isTaskkillForceRequired(args: readonly string[], detail: string): boolean {
  return !args.includes("/F") && /can only be terminated forcefully/iu.test(detail);
}

function runTaskkill(args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("taskkill.exe", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) return;
  const detail = `${result.stdout}${result.stderr}`;
  if (isTaskkillGone(result.status, detail) || isTaskkillForceRequired(args, detail)) return;
  throw new Error(`taskkill ${args.join(" ")} failed: ${detail.trim()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return null;
}
