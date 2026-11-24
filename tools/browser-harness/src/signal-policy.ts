// Every decision about sending a signal lives here as a pure function over data: process tables,
// ownership records, leases and clock readings. Nothing in this module reads the system or sends
// anything. The one function that performs a signal accepts only a `SignalOrder`, and only
// `decideSignal` issues those.

export type ProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number | null;
  readonly pgrp: number | null;
  readonly startTime: string;
  readonly args: readonly string[];
  readonly commandLine: string;
};

// Running processes keyed by PID. Zombies and exiting processes are not running and are absent.
export type ProcessTable = ReadonlyMap<number, ProcessIdentity>;

export type HarnessSelf = {
  readonly pid: number;
  readonly parentPid: number;
  readonly pgrp: number | null;
};

export type StopSignal = "SIGTERM" | "SIGKILL";
export type TargetKind = "process" | "group";

declare const OWNERSHIP: unique symbol;
// A process this harness started, or one a lease proves a dead harness started.
export type Ownership = {
  readonly pid: number;
  readonly startTime: string;
  readonly profileDir: string | null;
  readonly [OWNERSHIP]: true;
};

declare const ORDER: unique symbol;
export type SignalOrder = {
  readonly rawTarget: number;
  readonly signal: StopSignal;
  readonly [ORDER]: true;
};

export type SignalDecision =
  | { readonly verdict: "send"; readonly order: SignalOrder }
  | { readonly verdict: "refuse"; readonly reason: string };

const MINTED_OWNERSHIP = new WeakSet<Ownership>();
const UNSPENT_ORDERS = new WeakSet<SignalOrder>();

// Minted values are frozen, so a record checked once cannot be pointed at another process later.
function mintOwnership(pid: number, startTime: string, profileDir: string | null): Ownership {
  const ownership = Object.freeze({ pid, startTime, profileDir }) as Ownership;
  MINTED_OWNERSHIP.add(ownership);
  return ownership;
}

export function adoptSpawnedChild(spawned: {
  readonly pid: number;
  readonly startTime: string;
  readonly profileDir: string | null;
}): Ownership {
  return mintOwnership(spawned.pid, spawned.startTime, spawned.profileDir);
}

// The path must stand as a whole argument: bounded by the line's ends, whitespace, NUL, `=` before
// it (`--profile=<path>`), or a quote, since Windows quotes a path that holds spaces.
function commandLineHasPath(identity: ProcessIdentity, targetPath: string): boolean {
  const escaped = targetPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const boundary = new RegExp(`(?:^|[\\s\\0="])${escaped}(?:$|[\\s\\0"])`, "u");
  return boundary.test(identity.commandLine);
}

function isRunning(owner: Ownership, table: ProcessTable): boolean {
  return table.get(owner.pid)?.startTime === owner.startTime;
}

type SignalCase = {
  readonly id: number;
  readonly kind: TargetKind;
  readonly owner: Ownership;
  readonly self: HarnessSelf;
  readonly groupSignals: boolean;
};

type LiveCase = SignalCase & { readonly live: ProcessIdentity };

// PID 0 and 1, -1 and non-integers are never a target, as a process or as a group's leader.
function isSignalableId(id: number): boolean {
  return Number.isInteger(id) && id > 1;
}

// Checked in order; the first rule that returns a reason refuses the signal. These need no
// process table; the live rules below run only once the target is known to be running.
const SIGNAL_RULES: readonly ((c: SignalCase) => string | null)[] = [
  (c) => (isSignalableId(c.id) ? null : "target ID must be an integer greater than 1"),
  (c) => (c.id === c.self.pid ? "target matches harness pid" : null),
  (c) => (c.id === c.self.parentPid ? "target matches harness parent pid" : null),
  (c) => (c.id === c.self.pgrp ? "target matches harness process group" : null),
  (c) => (c.kind === "group" && !c.groupSignals ? "this platform has no process groups" : null),
  (c) =>
    c.kind === "group" && c.self.pgrp === null ? "could not determine harness process group" : null,
  (c) =>
    MINTED_OWNERSHIP.has(c.owner)
      ? null
      : "target was not spawned in this run or recorded in a valid lease",
  (c) => (c.owner.pid === c.id ? null : `ownership record is for ${String(c.owner.pid)}`),
];

const LIVE_RULES: readonly ((c: LiveCase) => string | null)[] = [
  (c) =>
    c.live.startTime === c.owner.startTime
      ? null
      : `start time ${c.live.startTime} does not match expected ${c.owner.startTime}`,
  (c) =>
    c.owner.profileDir !== null && !commandLineHasPath(c.live, c.owner.profileDir)
      ? `profile path ${c.owner.profileDir} missing from command line`
      : null,
  (c) =>
    c.kind === "group" && c.live.pgrp !== c.id
      ? `process group ${String(c.live.pgrp)} is not led by ${String(c.id)}`
      : null,
];

function firstReason<C>(rules: readonly ((c: C) => string | null)[], c: C): string | null {
  for (const rule of rules) {
    const reason = rule(c);
    if (reason !== null) return reason;
  }
  return null;
}

export function decideSignal(input: {
  readonly target: { readonly id: number; readonly kind: TargetKind };
  readonly signal: StopSignal;
  readonly owner: Ownership;
  readonly self: HarnessSelf;
  readonly table: ProcessTable;
  readonly groupSignals: boolean;
}): SignalDecision {
  const { id, kind } = input.target;
  const signalCase: SignalCase = {
    id,
    kind,
    owner: input.owner,
    self: input.self,
    groupSignals: input.groupSignals,
  };
  const live = input.table.get(id);
  const reason =
    firstReason(SIGNAL_RULES, signalCase) ??
    (live === undefined
      ? "target is not running"
      : firstReason(LIVE_RULES, { ...signalCase, live }));
  if (reason !== null) {
    return {
      verdict: "refuse",
      reason: `refusing ${input.signal} to ${kind} ${String(id)}: ${reason}`,
    };
  }
  const order = Object.freeze({
    rawTarget: kind === "group" ? -id : id,
    signal: input.signal,
  }) as SignalOrder;
  UNSPENT_ORDERS.add(order);
  return { verdict: "send", order };
}

// The performer calls this first: an order works once, and only if `decideSignal` issued it.
export function redeemOrder(order: SignalOrder): {
  readonly rawTarget: number;
  readonly signal: StopSignal;
} {
  if (!UNSPENT_ORDERS.delete(order)) {
    throw new Error(
      "refusing a signal order that decideSignal did not issue or that was already used",
    );
  }
  // Repeats decideSignal's first rule at the last step before the system call.
  if (!isSignalableId(Math.abs(order.rawTarget))) {
    throw new Error(`refusing signal target ${String(order.rawTarget)}`);
  }
  return { rawTarget: order.rawTarget, signal: order.signal };
}

// Members are the root's process group (only while the root itself still runs, so a reused PID
// cannot lend its group) and any other process naming the root's profile directory. PID 1 and the
// harness, its parent and its group leader are never members, whatever their command lines say.
function selectTreeMembers(root: Ownership, table: ProcessTable, self: HarnessSelf): Ownership[] {
  const groupTrusted = isRunning(root, table);
  const excluded = new Set<number | null>([1, self.pid, self.parentPid, self.pgrp]);
  const members: Ownership[] = [];
  for (const identity of table.values()) {
    const isRoot = identity.pid === root.pid && identity.startTime === root.startTime;
    if (isRoot || excluded.has(identity.pid)) continue;
    const sameGroup = groupTrusted && identity.pgrp === root.pid;
    const sameProfile = root.profileDir !== null && commandLineHasPath(identity, root.profileDir);
    if (!sameGroup && !sameProfile) continue;
    members.push(
      mintOwnership(identity.pid, identity.startTime, sameProfile ? root.profileDir : null),
    );
  }
  return members;
}

const SIGTERM_GRACE_MS = 1_500;
const STOP_DEADLINE_MS = 5_000;

export type StopState =
  | { readonly step: "start"; readonly members: readonly Ownership[] }
  | {
      readonly step: "terminating" | "killing";
      readonly since: number;
      readonly members: readonly Ownership[];
    };

export const START_STOP: StopState = { step: "start", members: [] };

export type StopStep =
  | { readonly kind: "done" }
  | { readonly kind: "wait"; readonly next: StopState }
  | { readonly kind: "signal"; readonly orders: readonly SignalOrder[]; readonly next: StopState }
  | { readonly kind: "refuse"; readonly reasons: readonly string[] }
  | { readonly kind: "fail"; readonly running: readonly number[] };

// Sends only when every decision in the step is a send; one refusal stops the whole stop.
function signalStep(decisions: readonly SignalDecision[], next: StopState): StopStep {
  const orders: SignalOrder[] = [];
  const reasons: string[] = [];
  for (const decision of decisions) {
    if (decision.verdict === "send") orders.push(decision.order);
    else reasons.push(decision.reason);
  }
  return reasons.length === 0 ? { kind: "signal", orders, next } : { kind: "refuse", reasons };
}

// SIGTERM to the tree, SIGKILL after the grace period, give up at the deadline. Never any other signal.
export function nextStopStep(input: {
  readonly root: Ownership;
  readonly state: StopState;
  readonly table: ProcessTable;
  readonly now: number;
  readonly self: HarnessSelf;
  readonly groupSignals: boolean;
}): StopStep {
  const { root, state, table, now, self, groupSignals } = input;
  const members = mergeMembers(state.members, selectTreeMembers(root, table, self));
  const rootRunning = isRunning(root, table);
  const runningMembers = members.filter((member) => isRunning(member, table));
  const running = [...(rootRunning ? [root.pid] : []), ...runningMembers.map((m) => m.pid)];
  if (running.length === 0) return { kind: "done" };

  const decide = (owner: Ownership, kind: TargetKind, signal: StopSignal): SignalDecision =>
    decideSignal({ target: { id: owner.pid, kind }, signal, owner, self, table, groupSignals });
  // Only a group signal to a running root covers its group's members; otherwise each is signalled.
  const groupCovers = (member: Ownership): boolean =>
    groupSignals && rootRunning && table.get(member.pid)?.pgrp === root.pid;
  const treeSignal = (signal: StopSignal): SignalDecision[] => [
    ...(rootRunning ? [decide(root, groupSignals ? "group" : "process", signal)] : []),
    ...runningMembers
      .filter((member) => !groupCovers(member))
      .map((member) => decide(member, "process", signal)),
  ];

  switch (state.step) {
    case "start":
      return signalStep(treeSignal("SIGTERM"), { step: "terminating", since: now, members });
    case "terminating":
      if (now - state.since < SIGTERM_GRACE_MS) {
        return { kind: "wait", next: { ...state, members } };
      }
      return signalStep(treeSignal("SIGKILL"), { step: "killing", since: now, members });
    case "killing":
      // Nothing is signalled after SIGKILL, so there is no member left to remember.
      if (now - state.since < STOP_DEADLINE_MS - SIGTERM_GRACE_MS)
        return { kind: "wait", next: state };
      return { kind: "fail", running };
  }
}

function mergeMembers(known: readonly Ownership[], found: readonly Ownership[]): Ownership[] {
  const merged = [...known];
  for (const member of found) {
    const sameProcess = (other: Ownership) =>
      other.pid === member.pid && other.startTime === member.startTime;
    if (!merged.some(sameProcess)) merged.push(member);
  }
  return merged;
}

export type LeaseRecord = {
  readonly harnessPid: number;
  readonly harnessStartTime: string;
  readonly spawnedPid: number | null;
  readonly spawnedStartTime: string | null;
  readonly profileDir: string;
};

export type LeaseVerdict =
  | { readonly action: "leave" }
  | { readonly action: "clean" }
  | { readonly action: "stop-and-clean"; readonly root: Ownership };

// A lease belongs to a dead harness when its PID is gone or now names a different process.
// Only then may its browser be stopped, and only if that browser is still the same process.
export function decideLease(lease: LeaseRecord, table: ProcessTable): LeaseVerdict {
  if (table.get(lease.harnessPid)?.startTime === lease.harnessStartTime) return { action: "leave" };
  const live = lease.spawnedPid === null ? undefined : table.get(lease.spawnedPid);
  if (
    live === undefined ||
    live.startTime !== lease.spawnedStartTime ||
    !commandLineHasPath(live, lease.profileDir)
  ) {
    return { action: "clean" };
  }
  return {
    action: "stop-and-clean",
    root: mintOwnership(live.pid, live.startTime, lease.profileDir),
  };
}
