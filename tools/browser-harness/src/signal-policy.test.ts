import { describe, expect, it } from "vite-plus/test";
import {
  adoptSpawnedChild,
  decideLease,
  decideSignal,
  redeemOrder,
  type HarnessSelf,
  type LeaseRecord,
  type Ownership,
  type ProcessIdentity,
  type SignalOrder,
  type TargetKind,
} from "./signal-policy.ts";
import { HARNESS, processIdentity } from "./simulated-process-io.ts";

const PROFILE = "/tmp/hark-browser-abc";
const BROWSER = processIdentity(5000, {
  startTime: "50000",
  args: ["/opt/zen/zen", "-profile", PROFILE],
});

const table = (...rows: ProcessIdentity[]) => new Map(rows.map((row) => [row.pid, row]));

// A process at `id` that this run owns and that satisfies every rule except the ID floor.
const ownedAt = (id: number): { owner: Ownership; row: ProcessIdentity } => ({
  owner: adoptSpawnedChild({ pid: id, startTime: "50000", profileDir: PROFILE }),
  row: { ...BROWSER, pid: id, pgrp: id },
});

type Case = {
  readonly id: number;
  readonly kind?: TargetKind;
  readonly owner?: Ownership;
  readonly rows?: readonly ProcessIdentity[];
  readonly self?: HarnessSelf;
  readonly groupSignals?: boolean;
};

const decide = (c: Case) =>
  decideSignal({
    target: { id: c.id, kind: c.kind ?? "group" },
    signal: "SIGTERM",
    owner: c.owner ?? adoptSpawnedChild({ pid: 5000, startTime: "50000", profileDir: PROFILE }),
    self: c.self ?? HARNESS,
    table: table(...(c.rows ?? [BROWSER])),
    groupSignals: c.groupSignals ?? true,
  });

const browserWith = (args: readonly string[], commandLine = args.join(" ")): ProcessIdentity => ({
  ...BROWSER,
  args,
  commandLine,
});

describe("decideSignal", () => {
  it.each([
    { name: "a group it leads", kind: "group" as const, rawTarget: -5000 },
    { name: "the process itself", kind: "process" as const, rawTarget: 5000 },
  ])("issues an order for an owned browser: $name", ({ kind, rawTarget }) => {
    const decision = decide({ id: 5000, kind });
    if (decision.verdict !== "send") throw new Error(decision.reason);
    expect(redeemOrder(decision.order)).toEqual({ rawTarget, signal: "SIGTERM" });
  });

  it("allows the lowest ID above 1", () => {
    const { owner, row } = ownedAt(2);
    const decision = decide({ id: 2, kind: "process", owner, rows: [row] });
    if (decision.verdict !== "send") throw new Error(decision.reason);
    expect(redeemOrder(decision.order)).toEqual({ rawTarget: 2, signal: "SIGTERM" });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 1, 0, -1, -5000])(
    "refuses target ID %s even when every other rule holds",
    (id) => {
      const { owner, row } = ownedAt(id);
      expect(decide({ id, kind: "process", owner, rows: [row] })).toEqual({
        verdict: "refuse",
        reason: `refusing SIGTERM to process ${String(id)}: target ID must be an integer greater than 1`,
      });
    },
  );

  // Each row breaks exactly one rule, so deleting that rule turns the row into a send.
  it.each([
    {
      name: "the harness itself",
      c: { id: 2000, kind: "process" as const, ...harnessOwned(2000, "20000") },
      reason: "target matches harness pid",
    },
    {
      name: "the harness's parent",
      c: { id: 1800, kind: "process" as const, ...harnessOwned(1800, "18000") },
      reason: "target matches harness parent pid",
    },
    {
      name: "the harness's process group",
      c: { id: 1900, kind: "process" as const, ...harnessOwned(1900, "19000") },
      reason: "target matches harness process group",
    },
    {
      name: "a group on a platform without process groups",
      c: { id: 5000, groupSignals: false },
      reason: "this platform has no process groups",
    },
    {
      name: "a group when the harness's own group is unknown",
      c: { id: 5000, self: { ...HARNESS, pgrp: null } },
      reason: "could not determine harness process group",
    },
    {
      name: "a forged ownership record",
      c: { id: 5000, owner: { pid: 5000, startTime: "50000", profileDir: PROFILE } as Ownership },
      reason: "target was not spawned in this run or recorded in a valid lease",
    },
    {
      name: "a record for another process",
      c: { id: 5100, kind: "process" as const, rows: [{ ...BROWSER, pid: 5100 }] },
      reason: "ownership record is for 5000",
    },
    {
      name: "a process that is not running",
      c: { id: 5000, rows: [] },
      reason: "target is not running",
    },
    {
      name: "a reused PID (start time differs)",
      c: {
        id: 5000,
        owner: adoptSpawnedChild({ pid: 5000, startTime: "49999", profileDir: PROFILE }),
      },
      reason: "start time 50000 does not match expected 49999",
    },
    {
      name: "a process without the profile path",
      c: { id: 5000, rows: [browserWith(["/usr/bin/editor"])] },
      reason: `profile path ${PROFILE} missing from command line`,
    },
    {
      name: "a process naming a longer path that ends with the profile path",
      c: { id: 5000, rows: [browserWith(["/opt/zen/zen", "-profile", `/other${PROFILE}`])] },
      reason: `profile path ${PROFILE} missing from command line`,
    },
    {
      name: "a process naming a longer path that starts with the profile path",
      c: { id: 5000, rows: [browserWith(["/opt/zen/zen", "-profile", `${PROFILE}-longer`])] },
      reason: `profile path ${PROFILE} missing from command line`,
    },
    {
      name: "a group the target does not lead",
      c: { id: 5000, rows: [{ ...BROWSER, pgrp: 4999 }] },
      reason: "process group 4999 is not led by 5000",
    },
  ])("refuses $name", ({ c, reason }) => {
    const kind = "kind" in c ? c.kind : "group";
    expect(decide(c)).toEqual({
      verdict: "refuse",
      reason: `refusing SIGTERM to ${kind} ${String(c.id)}: ${reason}`,
    });
  });

  it("issues a process order on Windows, where the harness has no process group", () => {
    const decision = decide({
      id: 5000,
      kind: "process",
      self: { ...HARNESS, pgrp: null },
      groupSignals: false,
    });
    expect(decision.verdict).toBe("send");
  });

  it("issues an order for an owned process recorded without a profile directory", () => {
    const owner = adoptSpawnedChild({ pid: 5000, startTime: "50000", profileDir: null });
    const rows = [browserWith(["/usr/bin/editor"])];
    expect(decide({ id: 5000, owner, rows }).verdict).toBe("send");
  });

  it.each([
    { name: "--profile=<path>", row: browserWith(["/opt/zen/zen", `--profile=${PROFILE}`]) },
    {
      name: "a quoted Windows path",
      row: browserWith(["zen.exe", "-profile", `"${PROFILE}"`], `zen.exe -profile "${PROFILE}"`),
    },
  ])("finds the profile path written as $name", ({ row }) => {
    expect(decide({ id: 5000, rows: [row] }).verdict).toBe("send");
  });
});

function harnessOwned(pid: number, startTime: string) {
  return {
    owner: adoptSpawnedChild({ pid, startTime, profileDir: null }),
    rows: [processIdentity(pid, { startTime, pgrp: pid })],
  };
}

describe("signal orders and ownership records", () => {
  const issue = (): SignalOrder => {
    const decision = decide({ id: 5000 });
    if (decision.verdict !== "send") throw new Error(decision.reason);
    return decision.order;
  };

  it("cannot be pointed at another target after they are issued", () => {
    const order = issue();
    expect(() => {
      (order as { rawTarget: number }).rawTarget = 1800;
    }).toThrow(TypeError);
    const owner = adoptSpawnedChild({ pid: 5000, startTime: "50000", profileDir: PROFILE });
    expect(() => {
      (owner as { pid: number }).pid = 1800;
    }).toThrow(TypeError);
    expect(redeemOrder(order)).toEqual({ rawTarget: -5000, signal: "SIGTERM" });
  });

  it("are redeemed once, and only when decideSignal issued them", () => {
    const order = issue();
    expect(redeemOrder(order)).toEqual({ rawTarget: -5000, signal: "SIGTERM" });
    const refusal = /did not issue or that was already used/;
    expect(() => redeemOrder(order)).toThrow(refusal);
    const unspent = issue();
    for (const forged of [
      { rawTarget: -5000, signal: "SIGTERM" },
      { ...unspent },
      Object.create(unspent) as object,
    ]) {
      expect(() => redeemOrder(forged as SignalOrder)).toThrow(refusal);
    }
  });
});

const LEASE: LeaseRecord = {
  harnessPid: 999_999,
  harnessStartTime: "1",
  spawnedPid: 5000,
  spawnedStartTime: "50000",
  profileDir: PROFILE,
};

describe("decideLease", () => {
  it("stops the dead harness's browser when the lease still names that exact process", () => {
    const verdict = decideLease(LEASE, table(BROWSER));
    expect(verdict).toEqual({
      action: "stop-and-clean",
      root: { pid: 5000, startTime: "50000", profileDir: PROFILE },
    });
    const root = verdict.action === "stop-and-clean" ? verdict.root : null;
    expect(root === null ? null : decide({ id: 5000, owner: root }).verdict).toBe("send");
  });

  it.each([
    {
      name: "the harness is still running",
      lease: { ...LEASE, harnessPid: 2000, harnessStartTime: "20000" },
      rows: [processIdentity(2000, { startTime: "20000" }), BROWSER],
      action: "leave",
    },
    {
      name: "the harness PID now names another process",
      lease: { ...LEASE, harnessPid: 2000, harnessStartTime: "1" },
      rows: [processIdentity(2000, { startTime: "20000" }), BROWSER],
      action: "stop-and-clean",
    },
    {
      name: "the browser was never recorded",
      lease: { ...LEASE, spawnedPid: null, spawnedStartTime: null },
      rows: [BROWSER],
      action: "clean",
    },
    { name: "the browser is gone", lease: LEASE, rows: [], action: "clean" },
    {
      name: "the browser's PID was reused (start time differs)",
      lease: { ...LEASE, spawnedStartTime: "49999" },
      rows: [BROWSER],
      action: "clean",
    },
    {
      name: "the process no longer names the profile",
      lease: LEASE,
      rows: [browserWith(["/usr/bin/editor"])],
      action: "clean",
    },
    {
      name: "the process names a longer path ending with the profile",
      lease: LEASE,
      rows: [browserWith(["/opt/zen/zen", "-profile", `/other${PROFILE}`])],
      action: "clean",
    },
  ])("decides $action when $name", ({ lease, rows, action }) => {
    expect(decideLease(lease, table(...rows)).action).toBe(action);
  });
});
