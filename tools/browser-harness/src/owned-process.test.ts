import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  isTaskkillForceRequired,
  isTaskkillGone,
  removeDirectoryBounded,
  signalPerformer,
  spawnOwned,
  killOwnedTree,
  stopOwnedTree,
  taskkillArgs,
  watchChildExit,
} from "./owned-process.ts";
import {
  currentPlatformName,
  parseDarwinProcessTable,
  parseLinuxProcess,
  parseWin32ProcessTable,
  PROCESS_PLATFORMS,
  readProcessIdentity,
} from "./process-table.ts";
import {
  adoptSpawnedChild,
  decideSignal,
  type Ownership,
  type SignalOrder,
  type StopSignal,
} from "./signal-policy.ts";
import { HARNESS, processIdentity, simulateProcesses } from "./simulated-process-io.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("process tables", () => {
  it.each(
    [
      {
        row: "linux" as const,
        text: "4242 (Web Content) (x) S 4100 4100 4100 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 30 0 99 1000 2560 18446744073709551615\n",
        parentPid: 4100,
      },
      { row: "win32" as const, text: "4100 104857600 52000000\r\n", parentPid: 4100 },
      { row: "darwin" as const, text: " 4100  2048   0:03.00\n", parentPid: 4100 },
    ].filter((sample) => sample.row !== "linux" || process.platform === "linux"),
  )("the $row row parses documented sample output", ({ row, text, parentPid }) => {
    const snapshot = PROCESS_PLATFORMS[row].parseSnapshot(text, 4242);
    expect(snapshot.parentPid).toBe(parentPid);
    expect(snapshot.cpuTimeMs).toBeCloseTo(row === "win32" ? 5200 : 3000, 6);
    if (row === "win32") expect(snapshot.workingSetBytes).toBe(104_857_600);
    if (row === "darwin") expect(snapshot.workingSetBytes).toBe(2048 * 1024);
  });

  it("parses BSD and procps cumulative CPU time with hours and days", () => {
    const cpu = (time: string): number =>
      PROCESS_PLATFORMS.darwin.parseSnapshot(`1 1 ${time}`, 1).cpuTimeMs;
    expect(cpu("61:02.50")).toBeCloseTo(3_662_500, 6);
    expect(cpu("01:01:02")).toBeCloseTo(3_662_000, 6);
    expect(cpu("2-00:00:01")).toBeCloseTo(172_801_000, 6);
  });

  it("reads parent, group, start time and arguments from /proc text, and drops zombies and exiting processes", () => {
    const stat = (state: string) =>
      `4242 (a) b (c) d) ${state} 4100 4200 4200 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 30 0 987654 1000 2560\n`;
    expect(parseLinuxProcess(4242, stat("S"), "/opt/zen/zen\0-profile\0/tmp/p\0")).toEqual({
      pid: 4242,
      parentPid: 4100,
      pgrp: 4200,
      startTime: "987654",
      args: ["/opt/zen/zen", "-profile", "/tmp/p"],
      commandLine: "/opt/zen/zen -profile /tmp/p",
    });
    expect(parseLinuxProcess(4242, stat("Z"), "/opt/zen/zen\0")).toBeUndefined();
    expect(parseLinuxProcess(4242, stat("S"), "")).toBeUndefined();
  });

  it("parses whole-table listings from ps on macOS and Win32_Process on Windows", () => {
    const darwin = parseDarwinProcessTable(
      [
        "  501   1  501 S   Mon Nov 16 12:00:00 2026     /Applications/Zen.app/zen -profile /tmp/hark-browser-a",
        "  502   1  502 Z   Mon Nov 16 12:00:00 2026     (zen)",
        "  503   1  503 SE  Mon Nov 16 12:00:00 2026     /Applications/Zen.app/zen",
        "  504   1  504 S   Mon Nov 16 12:00:00 2026     (zen)",
      ].join("\n"),
    );
    expect(darwin.get(501)).toMatchObject({
      parentPid: 1,
      pgrp: 501,
      startTime: "Mon Nov 16 12:00:00 2026",
      args: ["/Applications/Zen.app/zen", "-profile", "/tmp/hark-browser-a"],
    });
    expect(darwin.has(502)).toBe(false);
    expect(darwin.has(503)).toBe(false);
    expect(darwin.has(504)).toBe(false);
    const win32 = parseWin32ProcessTable(
      "4100\t900\t638990000000000000\tC:\\zen\\zen.exe -profile C:\\T\\hark-browser-a\r\n12\t4\t1\t\r\n",
    );
    expect(win32.get(4100)).toMatchObject({
      parentPid: 900,
      pgrp: null,
      startTime: "638990000000000000",
    });
    expect(win32.has(12)).toBe(false);
  });

  it("refuses a platform outside the table", () => {
    expect(() => currentPlatformName("aix")).toThrow(/unsupported platform aix/);
  });
});

const PROFILE = "/tmp/hark-browser-abc";

// A browser leading group 5000, a content process in its group, a helper that left the group but
// names the profile, and two bystanders: one in its own group and one in the harness's group.
function browserTree() {
  return [
    processIdentity(5000, { args: ["/opt/zen/zen", "-profile", PROFILE] }),
    processIdentity(5001, { parentPid: 5000, pgrp: 5000, args: ["/opt/zen/zen", "-contentproc"] }),
    processIdentity(5100, {
      parentPid: 5000,
      args: ["/opt/zen/zen", "-profile", PROFILE, "-helper"],
    }),
    processIdentity(7000, { args: ["/usr/bin/editor"] }),
    processIdentity(7001, { parentPid: 2000, pgrp: 1900, args: ["/usr/bin/sibling"] }),
  ];
}

const browserRoot = (startTime = "50000", profileDir: string | null = PROFILE): Ownership =>
  adoptSpawnedChild({ pid: 5000, startTime, profileDir });

describe("stopping an owned tree", () => {
  it("sends SIGTERM to the browser's group and to profile holders outside it, and nothing else", async () => {
    const world = simulateProcesses(browserTree());
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGTERM", at: 0 },
      { rawTarget: 5100, signal: "SIGTERM", at: 0 },
    ]);
    expect([5000, 5001, 5100].map(world.running)).toEqual([false, false, false]);
    expect([7000, 7001, 2000, 1800, 1].map(world.running)).toEqual([true, true, true, true, true]);
  });

  it("kills at a chosen point with SIGKILL to the same members at once, never SIGTERM first", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5000: "SIGTERM", 5001: "SIGTERM", 5100: "SIGTERM" },
    });
    await killOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGKILL", at: 0 },
      { rawTarget: 5100, signal: "SIGKILL", at: 0 },
    ]);
    expect([5000, 5001, 5100].map(world.running)).toEqual([false, false, false]);
    expect([7000, 7001, 2000, 1800, 1].map(world.running)).toEqual([true, true, true, true, true]);
  });

  it("escalates to SIGKILL for the whole tree at 1500 ms when SIGTERM is ignored", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5000: "SIGTERM", 5001: "SIGTERM", 5100: "SIGTERM" },
    });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGTERM", at: 0 },
      { rawTarget: 5100, signal: "SIGTERM", at: 0 },
      { rawTarget: -5000, signal: "SIGKILL", at: 1500 },
      { rawTarget: 5100, signal: "SIGKILL", at: 1500 },
    ]);
    expect([5000, 5001, 5100, 7000].map(world.running)).toEqual([false, false, false, true]);
  });

  it("gives up at the 5000 ms deadline when a process survives SIGKILL, without other signals", async () => {
    const world = simulateProcesses(browserTree(), { survives: { 5000: "everything" } });
    await expect(stopOwnedTree(world.io, browserRoot())).rejects.toThrow(
      /owned process still running: 5000$/,
    );
    expect(world.sent.map((s) => `${String(s.rawTarget)} ${s.signal} @${String(s.at)}`)).toEqual([
      "-5000 SIGTERM @0",
      "5100 SIGTERM @0",
      "-5000 SIGKILL @1500",
    ]);
    expect(world.io.now()).toBe(5000);
  });

  it("after the root exited, stops only processes naming its profile, never members of a group a reused PID could lead", async () => {
    const tree = browserTree().filter((identity) => identity.pid !== 5000);
    const world = simulateProcesses(tree);
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([{ rawTarget: 5100, signal: "SIGTERM", at: 0 }]);
    expect(world.running(5001)).toBe(true);
  });

  it("leaves a process alone when its PID now has another start time", async () => {
    const world = simulateProcesses([processIdentity(5000, { args: ["/usr/bin/other"] })]);
    await stopOwnedTree(world.io, browserRoot("49999"));
    expect(world.sent).toEqual([]);
    expect(world.running(5000)).toBe(true);
  });

  it("starts the grace period and the deadline from the clock's reading, not from zero", async () => {
    const world = simulateProcesses(browserTree(), {
      startAt: 10_000,
      survives: { 5000: "everything" },
    });
    await expect(stopOwnedTree(world.io, browserRoot())).rejects.toThrow(/still running: 5000$/);
    expect(world.sent.map((s) => `${String(s.rawTarget)} ${s.signal} @${String(s.at)}`)).toEqual([
      "-5000 SIGTERM @10000",
      "5100 SIGTERM @10000",
      "-5000 SIGKILL @11500",
    ]);
    expect(world.io.now()).toBe(15_000);
  });

  it("never takes PID 1, the harness, its parent or its group leader as members, even when they name the profile", async () => {
    const naming = (pid: number, parentPid: number, pgrp: number) =>
      processIdentity(pid, { parentPid, pgrp, args: ["/bin/sh", "-c", `rm -rf ${PROFILE}`] });
    const world = simulateProcesses([
      ...browserTree(),
      naming(1, 0, 1),
      naming(1800, 1, 1800),
      naming(1900, 1800, 1900),
      naming(2000, 1800, 1900),
      naming(2, 1, 2),
    ]);
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent.map((s) => s.rawTarget).sort((a, b) => a - b)).toEqual([-5000, 2, 5100]);
    expect([1, 1800, 1900, 2000].map(world.running)).toEqual([true, true, true, true]);
  });

  it("keeps stopping members of the root's group after the root exits", async () => {
    const world = simulateProcesses(browserTree(), { survives: { 5001: "SIGTERM" } });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGTERM", at: 0 },
      { rawTarget: 5100, signal: "SIGTERM", at: 0 },
      { rawTarget: 5001, signal: "SIGKILL", at: 1500 },
    ]);
    expect(world.running(5001)).toBe(false);
  });

  it("remembers a group member that started during the grace period, after the root exits", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5000: "SIGTERM", 5002: "SIGTERM" },
      onSleep: (now, live) => {
        if (now === 500) live.set(5002, processIdentity(5002, { parentPid: 5000, pgrp: 5000 }));
        if (now === 1000) live.delete(5000);
      },
    });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent.filter((s) => s.at === 1500)).toEqual([
      { rawTarget: 5002, signal: "SIGKILL", at: 1500 },
    ]);
    expect(world.running(5002)).toBe(false);
  });

  it("refuses to escalate against a member that exec'd into a process no longer naming the profile", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5100: "SIGTERM" },
      onSignal: (rawTarget, signal, live) => {
        if (rawTarget === 5100 && signal === "SIGTERM") {
          live.set(5100, processIdentity(5100, { parentPid: 5000, args: ["/usr/bin/other"] }));
        }
      },
    });
    await expect(stopOwnedTree(world.io, browserRoot())).rejects.toThrow(
      /refusing SIGKILL to process 5100: profile path .* missing from command line/,
    );
    expect(world.sent.filter((s) => s.signal === "SIGKILL")).toEqual([]);
  });

  it("stops each profile holder even when two share the root's start time", async () => {
    const holder = (pid: number) =>
      processIdentity(pid, { startTime: "50000", args: ["/opt/zen/zen", "-profile", PROFILE] });
    const world = simulateProcesses([
      ...browserTree().filter((p) => p.pid !== 5100),
      holder(5100),
      holder(5101),
    ]);
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent.map((s) => s.rawTarget)).toEqual([-5000, 5100, 5101]);
  });

  it("stops a profile holder that took a stopped member's PID during the grace period", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5000: "SIGTERM", 5100: "SIGTERM" },
      onSleep: (now, live) => {
        if (now !== 500) return;
        live.set(
          5100,
          processIdentity(5100, {
            startTime: "99999",
            args: ["/opt/zen/zen", "-profile", PROFILE],
          }),
        );
      },
    });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent.filter((s) => s.signal === "SIGKILL").map((s) => s.rawTarget)).toEqual([
      -5000, 5100,
    ]);
    expect(world.running(5100)).toBe(false);
  });

  it("stops a process that reuses the root's PID when it names the profile", async () => {
    const world = simulateProcesses([
      processIdentity(5000, { args: ["/opt/zen/zen", "-profile", PROFILE] }),
    ]);
    await stopOwnedTree(world.io, browserRoot("49999"));
    expect(world.sent).toEqual([{ rawTarget: 5000, signal: "SIGTERM", at: 0 }]);
  });

  it("signals each member itself on a platform that cannot signal a group", async () => {
    const world = simulateProcesses(browserTree(), { groupSignals: false });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent.map((s) => s.rawTarget)).toEqual([5000, 5001, 5100]);
  });

  it("on Windows signals the root process itself, since there are no process groups", async () => {
    const world = simulateProcesses(
      [processIdentity(5000, { pgrp: null, args: ["zen.exe", "-profile", PROFILE] })],
      { groupSignals: false },
    );
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([{ rawTarget: 5000, signal: "SIGTERM", at: 0 }]);
  });

  const forged = { pid: 5000, startTime: "50000", profileDir: PROFILE } as unknown as Ownership;
  it.each([
    { name: "a forged ownership record", root: forged, refusal: /not spawned in this run/ },
    {
      name: "PID 1",
      root: adoptSpawnedChild({ pid: 1, startTime: "10", profileDir: null }),
      refusal: /integer greater than 1/,
    },
    {
      name: "the harness itself",
      root: adoptSpawnedChild({ pid: HARNESS.pid, startTime: "20000", profileDir: null }),
      refusal: /harness pid/,
    },
    {
      name: "the harness's parent",
      root: adoptSpawnedChild({ pid: HARNESS.parentPid, startTime: "18000", profileDir: null }),
      refusal: /harness parent pid/,
    },
    {
      name: "the harness's process group",
      root: adoptSpawnedChild({ pid: 1900, startTime: "19000", profileDir: null }),
      refusal: /harness process group/,
    },
    {
      name: "a root that does not lead its group",
      root: adoptSpawnedChild({ pid: 5500, startTime: "55000", profileDir: null }),
      refusal: /process group 5000 is not led by 5500/,
    },
    {
      name: "a root whose command line lacks the profile path",
      root: adoptSpawnedChild({ pid: 7000, startTime: "70000", profileDir: PROFILE }),
      refusal: /profile path .* missing from command line/,
    },
  ])(
    "refuses $name and never reaches the performer, for a stop and a kill",
    async ({ root, refusal }) => {
      for (const end of [stopOwnedTree, killOwnedTree]) {
        const world = simulateProcesses([
          ...browserTree(),
          processIdentity(1900, { parentPid: 1800, pgrp: 1900, args: ["/bin/sh", "-c", "make"] }),
          processIdentity(5500, { parentPid: 5000, pgrp: 5000, args: ["/opt/zen/zen", "-gpu"] }),
        ]);
        await expect(end(world.io, root)).rejects.toThrow(refusal);
        expect(world.sent).toEqual([]);
      }
    },
  );
});

describe("the performer", () => {
  const issue = (): SignalOrder => {
    const decision = decideSignal({
      target: { id: 5000, kind: "group" },
      signal: "SIGTERM",
      owner: browserRoot(),
      self: HARNESS,
      table: simulateProcesses(browserTree()).io.table(),
      groupSignals: true,
    });
    if (decision.verdict !== "send") throw new Error(decision.reason);
    return decision.order;
  };
  const recording = (fail?: string) => {
    const sent: string[] = [];
    const perform = signalPerformer((rawTarget: number, signal: StopSignal) => {
      sent.push(`${String(rawTarget)} ${signal}`);
      if (fail !== undefined) throw Object.assign(new Error(fail), { code: fail });
    });
    return { sent, perform };
  };

  it("sends an issued order once, and never a forged or spent one", () => {
    const { sent, perform } = recording();
    const order = issue();
    expect(perform(order)).toBe(true);
    const refusal = /did not issue or that was already used/;
    expect(() => perform(order)).toThrow(refusal);
    const forged = { rawTarget: -5000, signal: "SIGTERM" } as unknown as SignalOrder;
    expect(() => perform(forged)).toThrow(refusal);
    expect(sent).toEqual(["-5000 SIGTERM"]);
  });

  it("on Windows closes the whole tree, forcing it only for SIGKILL", () => {
    expect(taskkillArgs(5000, "SIGTERM")).toEqual(["/PID", "5000", "/T"]);
    expect(taskkillArgs(5000, "SIGKILL")).toEqual(["/PID", "5000", "/T", "/F"]);
    expect(isTaskkillGone(128, "")).toBe(true);
    expect(isTaskkillGone(1, 'ERROR: The process "1" not found.')).toBe(true);
    expect(
      isTaskkillGone(
        1,
        "ERROR: The process with PID 6060 (child process of PID 8668) could not be terminated.\r\nReason: There is no running instance of the task.",
      ),
    ).toBe(true);
    expect(isTaskkillGone(1, "ERROR: Access is denied.")).toBe(false);
    expect(
      isTaskkillForceRequired(
        ["/PID", "5892", "/T"],
        "Reason: This process can only be terminated forcefully (with /F option).",
      ),
    ).toBe(true);
    expect(
      isTaskkillForceRequired(
        ["/PID", "5892", "/T", "/F"],
        "Reason: This process can only be terminated forcefully (with /F option).",
      ),
    ).toBe(false);
    expect(isTaskkillForceRequired(["/PID", "5892", "/T"], "ERROR: Access is denied.")).toBe(false);
  });

  it("does nothing for a child whose start time could not be read", async () => {
    const world = simulateProcesses(browserTree());
    await stopOwnedTree(world.io, null);
    expect(world.sent).toEqual([]);
  });

  it("reports a target that is already gone, and throws every other failure", () => {
    expect(recording("ESRCH").perform(issue())).toBe(false);
    expect(() => recording("EPERM").perform(issue())).toThrow("EPERM");
  });
});

describe("spawning an owned child", () => {
  it("opens no pipes unless asked", async () => {
    const owned = spawnOwned(process.execPath, ["-e", ""]);
    const exited = new Promise((resolve) => owned.child.once("exit", resolve));
    expect([owned.child.stdin, owned.child.stdout, owned.child.stderr]).toEqual([null, null, null]);
    await exited;
  });

  it("throws, without an unhandled error event, when the command cannot start", async () => {
    expect(() => spawnOwned("/nonexistent/hark-binary", [])).toThrow(
      "could not start /nonexistent/hark-binary",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("records the child's PID, start time and profile directory in a record the guard accepts", async () => {
    const owned = spawnOwned(
      process.execPath,
      ["-e", 'process.stdout.write("ready\\n"); process.stdin.resume();', PROFILE],
      { stdio: ["pipe", "pipe", "ignore"], profileDir: PROFILE },
    );
    const exited = new Promise((resolve) => owned.child.once("exit", resolve));
    try {
      await new Promise((resolve) => owned.child.stdout?.once("data", resolve));
      const identity = readProcessIdentity(owned.pid);
      expect(owned.ownership).toEqual({
        pid: owned.pid,
        startTime: identity?.startTime,
        profileDir: PROFILE,
      });
      const live = identity === undefined ? [] : [identity];
      const decision =
        owned.ownership === null
          ? null
          : decideSignal({
              target: { id: owned.pid, kind: "process" },
              signal: "SIGTERM",
              owner: owned.ownership,
              self: HARNESS,
              table: new Map(live.map((row) => [row.pid, row])),
              groupSignals: true,
            });
      expect(decision?.verdict).toBe("send");
    } finally {
      owned.child.stdin?.end();
      await exited;
    }
  });
});

describe("profile directory removal", () => {
  it.runIf(currentPlatformName() !== "win32")(
    "includes stderr when profile directory removal fails and exits immediately",
    async () => {
      const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-readonly-"));
      directories.push(parent);
      const locked = NodePath.join(parent, "locked");
      await NodeFSP.mkdir(locked);
      await NodeFSP.writeFile(NodePath.join(locked, "file"), "data");
      await NodeFSP.chmod(locked, 0o555);
      await NodeFSP.chmod(parent, 0o555);
      try {
        await expect(removeDirectoryBounded(simulateProcesses([]).io, locked)).rejects.toThrow(
          /profile removal exited 1[\s\S]*EACCES/,
        );
      } finally {
        await NodeFSP.chmod(parent, 0o755);
        await NodeFSP.chmod(locked, 0o755);
      }
    },
  );
});

describe("child exit stderr cleanup", () => {
  it("destroys child.stderr once the exit watcher settles even if a descendant holds stderr open", async () => {
    const owned = spawnOwned(
      process.execPath,
      [
        "-e",
        'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: ["ignore", "ignore", 2], detached: true }).unref(); process.stderr.write("gone");',
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const watcher = watchChildExit(owned.child);
    const result = await watcher.exited;
    expect(result.stderr).toBe("gone");
    expect(owned.child.stderr?.destroyed).toBe(true);
  });
});
