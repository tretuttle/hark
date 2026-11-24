import { signalPerformer, type ProcessIo } from "./owned-process.ts";
import type { HarnessSelf, ProcessIdentity, StopSignal } from "./signal-policy.ts";

// A process table that tests drive with fixed data. Its `perform` is the host's performer with
// the system call swapped for a change to this table.

export const HARNESS: HarnessSelf = { pid: 2000, parentPid: 1800, pgrp: 1900 };

export function processIdentity(
  pid: number,
  fields: {
    readonly parentPid?: number;
    readonly pgrp?: number | null;
    readonly startTime?: string;
    readonly args?: readonly string[];
  } = {},
): ProcessIdentity {
  const args = fields.args ?? [`/opt/proc-${String(pid)}`];
  return {
    pid,
    parentPid: fields.parentPid ?? 1,
    pgrp: fields.pgrp === undefined ? pid : fields.pgrp,
    startTime: fields.startTime ?? String(pid * 10),
    args,
    commandLine: args.join(" "),
  };
}

const HOST_BACKGROUND: readonly ProcessIdentity[] = [
  processIdentity(1, { parentPid: 0, args: ["/sbin/init"] }),
  processIdentity(1800, { pgrp: 1800, args: ["/bin/sh"] }),
  processIdentity(2000, { parentPid: 1800, pgrp: 1900, args: ["node", "harness"] }),
];

export type SentSignal = {
  readonly rawTarget: number;
  readonly signal: StopSignal;
  readonly at: number;
};

export type SimulatedProcesses = {
  readonly io: ProcessIo;
  readonly sent: SentSignal[];
  readonly running: (pid: number) => boolean;
};

export function simulateProcesses(
  processes: readonly ProcessIdentity[],
  options: {
    readonly survives?: Readonly<Record<number, "SIGTERM" | "everything">>;
    readonly groupSignals?: boolean;
    readonly startAt?: number;
    // Changes the world after a signal lands, or after each sleep (for processes that exec,
    // start or exit while a stop is in progress).
    readonly onSignal?: (
      rawTarget: number,
      signal: StopSignal,
      live: Map<number, ProcessIdentity>,
    ) => void;
    readonly onSleep?: (now: number, live: Map<number, ProcessIdentity>) => void;
  } = {},
): SimulatedProcesses {
  const live = new Map<number, ProcessIdentity>();
  for (const identity of [...HOST_BACKGROUND, ...processes]) live.set(identity.pid, identity);
  const sent: SentSignal[] = [];
  let clock = options.startAt ?? 0;
  const io: ProcessIo = {
    groupSignals: options.groupSignals ?? true,
    self: () => HARNESS,
    table: () => new Map(live),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      options.onSleep?.(clock, live);
    },
    perform: signalPerformer((rawTarget, signal) => {
      sent.push({ rawTarget, signal, at: clock });
      const targets =
        rawTarget < 0
          ? [...live.values()].filter((identity) => identity.pgrp === -rawTarget)
          : [live.get(rawTarget)].filter((identity) => identity !== undefined);
      if (targets.length === 0)
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      for (const target of targets) {
        const survives = options.survives?.[target.pid];
        if (survives === "everything" || (survives === "SIGTERM" && signal === "SIGTERM")) continue;
        live.delete(target.pid);
      }
      options.onSignal?.(rawTarget, signal, live);
    }),
  };
  return { io, sent, running: (pid) => live.has(pid) };
}
