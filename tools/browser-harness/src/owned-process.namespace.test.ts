import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";
import {
  hostProcessIo,
  removeDirectoryBounded,
  spawnOwned,
  STDERR_DRAIN_GRACE_MS,
  stopOwnedTree,
  watchChildExit,
  type OwnedChild,
} from "./owned-process.ts";
import {
  currentPlatformName,
  PROCESS_PLATFORMS,
  readHostProcessTable,
  readProcessIdentity,
} from "./process-table.ts";
import { adoptSpawnedChild, decideSignal, type SignalOrder } from "./signal-policy.ts";

requireIsolatedPidNamespace();

const owned: OwnedChild[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of owned.splice(0)) await stopOwnedTree(hostProcessIo(), child.ownership);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const running = (pid: number): boolean => readHostProcessTable().has(pid);
const READY_AND_WAIT = 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
const IGNORES_SIGTERM = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';

const ALLOCATED_BYTES = 200 * 1024 * 1024;
const PROBE_TITLE = "a) b (c) d";
const PROBE = `
process.title = ${JSON.stringify(PROBE_TITLE)};
const held = Buffer.alloc(${String(ALLOCATED_BYTES)}, 7);
const start = process.cpuUsage();
while (true) { const used = process.cpuUsage(start); if (used.user + used.system >= 300000) break; }
const cpu = process.cpuUsage();
process.stdout.write(JSON.stringify({ ppid: process.ppid, rss: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000, held: held.length }) + "\\n");
setInterval(() => {}, 1000);
`;

describe("owned process trees (real signals)", () => {
  it("reads what a live process reports about itself", async () => {
    const probe = spawn(process.execPath, ["-e", PROBE], { stdio: ["ignore", "pipe", "ignore"] });
    const reported = JSON.parse(await firstLine(probe)) as {
      ppid: number;
      rss: number;
      cpuMs: number;
    };
    expect(NodeFS.readFileSync(`/proc/${String(probe.pid)}/stat`, "utf8")).toContain(
      `(${PROBE_TITLE})`,
    );
    expect(readProcessIdentity(probe.pid)).toMatchObject({
      pgrp: probe.pid,
      parentPid: process.pid,
    });
    const snapshot = PROCESS_PLATFORMS[currentPlatformName()].snapshot(probe.pid);
    expect(snapshot.parentPid).toBe(process.pid);
    expect(reported.ppid).toBe(process.pid);
    expect(snapshot.workingSetBytes).toBeGreaterThanOrEqual(ALLOCATED_BYTES);
    expect(snapshot.workingSetBytes).toBeLessThanOrEqual(reported.rss * 1.25);
    expect(snapshot.cpuTimeMs).toBeGreaterThanOrEqual(reported.cpuMs - 20);
    expect(snapshot.cpuTimeMs).toBeLessThanOrEqual(reported.cpuMs + 1000);
  });

  it("stops the spawned tree and leaves an unrelated process running", async () => {
    const tree = await spawnTree(null);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await stopOwnedTree(hostProcessIo(), tree.leader.ownership);
    expect(running(tree.leader.pid)).toBe(false);
    expect(running(tree.descendantPid)).toBe(false);
    expect(running(unrelated.pid)).toBe(true);
  });

  it("stops a descendant that outlived its leader when it names the profile directory, escalating past an ignored SIGTERM", async () => {
    const profileDir = await scratch("hark-browser-");
    const tree = await spawnTree(profileDir);
    await new Promise((resolve) => tree.leader.child.once("exit", resolve));
    expect(running(tree.descendantPid)).toBe(true);
    await stopOwnedTree(hostProcessIo(), tree.leader.ownership);
    expect(running(tree.descendantPid)).toBe(false);
  });

  it("removes a profile directory once the process holding a file in it is stopped", async () => {
    const directory = await scratch("hark-profile-");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        'const fs = require("node:fs"); fs.writeSync(fs.openSync(process.argv[1], "w"), "lock"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        NodePath.join(directory, "parent.lock"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(await firstLine(holder)).toBe("ready");
    await stopOwnedTree(hostProcessIo(), holder.ownership);
    await removeDirectoryBounded(hostProcessIo(), directory);
    expect(NodeFS.existsSync(directory)).toBe(false);
  });

  it("reports exit with buffered stderr without waiting on a descendant holding stderr open", async () => {
    const child = spawn(
      "/bin/sh",
      ["-c", "sleep 30 &\necho 'descendant pipe crash' >&2\nexit 3\n"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const watcher = watchChildExit(child.child);
    const started = Date.now();
    const result = await watcher.exited;
    const elapsed = Date.now() - started;
    expect(result.status).toBe("code 3");
    expect(result.stderr).toContain("descendant pipe crash");
    expect(elapsed).toBeGreaterThanOrEqual(STDERR_DRAIN_GRACE_MS - 20);
    expect(elapsed).toBeLessThan(2000);
  });

  it("sends SIGTERM first and SIGKILL only when the process ignores it", async () => {
    const log = NodePath.join(await scratch("hark-signals-"), "signals.log");
    const stub = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
         process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(log)}, "SIGTERM\\n"));
         process.stdout.write("ready\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(await firstLine(stub)).toBe("ready");
    await stopOwnedTree(hostProcessIo(), stub.ownership);
    expect(running(stub.pid)).toBe(false);
    expect(await NodeFSP.readFile(log, "utf8")).toBe("SIGTERM\n");
  });

  it("runs under a 1-byte core limit with a private TMPDIR", () => {
    expect(NodeFS.readFileSync("/proc/self/limits", "utf8")).toMatch(
      /^Max core file size\s+1\s+1\s+bytes\s*$/mu,
    );
    expect(NodePath.basename(NodeOS.tmpdir())).toMatch(/^hark-ns-tmp-\w{6}$/u);
  });

  it("signals process groups on Linux", () => {
    expect(hostProcessIo().groupSignals).toBe(true);
  });

  it("the host performer refuses a forged order, sends an issued one once, and refuses it again", async () => {
    const target = spawn(process.execPath, ["-e", READY_AND_WAIT], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(await firstLine(target)).toBe("ready");
    const io = hostProcessIo();
    const forged = { rawTarget: target.pid, signal: "SIGTERM" } as unknown as SignalOrder;
    expect(() => io.perform(forged)).toThrow(/did not issue or that was already used/);
    expect(running(target.pid)).toBe(true);
    const decision =
      target.ownership === null
        ? null
        : decideSignal({
            target: { id: target.pid, kind: "process" },
            signal: "SIGTERM",
            owner: target.ownership,
            self: io.self(),
            table: io.table(),
            groupSignals: io.groupSignals,
          });
    if (decision?.verdict !== "send") throw new Error("expected an order for the spawned child");
    const exited = new Promise((resolve) => target.child.once("exit", resolve));
    expect(io.perform(decision.order)).toBe(true);
    await exited;
    expect(() => io.perform(decision.order)).toThrow(/already used/);
  });

  it("the host performer refuses this namespace's PID 1 and the harness itself, and both keep running", async () => {
    for (const pid of [1, process.pid]) {
      const startTime = readProcessIdentity(pid)?.startTime ?? "";
      await expect(
        stopOwnedTree(hostProcessIo(), adoptSpawnedChild({ pid, startTime, profileDir: null })),
      ).rejects.toThrow(/integer greater than 1|harness pid/);
      expect(running(pid)).toBe(true);
    }
  });
});

function spawn(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawnOwned>[2] = {},
): OwnedChild {
  const child = spawnOwned(command, args, options);
  owned.push(child);
  return child;
}

async function scratch(prefix: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

// A leader in its own group that starts one SIGTERM-ignoring descendant in the same group. With a
// profile directory, the leader is owned with it and the descendant names it, then the leader exits.
async function spawnTree(
  profileDir: string | null,
): Promise<{ leader: OwnedChild; descendantPid: number }> {
  const descendantArgs = ["-e", IGNORES_SIGTERM, ...(profileDir === null ? [] : [profileDir])];
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, ${JSON.stringify(descendantArgs)}, { stdio: "ignore" });
       process.stdout.write(String(child.pid) + "\\n");
       ${profileDir === null ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 100);"}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], profileDir: profileDir ?? undefined },
  );
  const descendantPid = Number(await firstLine(leader));
  return { leader, descendantPid };
}

function firstLine(owner: OwnedChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    owner.child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end !== -1) resolve(text.slice(0, end).trim());
    });
    owner.child.once("close", (code) =>
      reject(new Error(`child exited ${String(code)} before a line`)),
    );
  });
}
