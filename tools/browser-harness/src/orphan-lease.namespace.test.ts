import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";
import { leaseDirectory, reapOrphanedLaunches } from "./orphan-lease.ts";
import { hostProcessIo, spawnOwned, stopOwnedTree, type OwnedChild } from "./owned-process.ts";
import { readHostProcessTable } from "./process-table.ts";

requireIsolatedPidNamespace();

const owned: OwnedChild[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const child of owned.splice(0)) await stopOwnedTree(hostProcessIo(), child.ownership);
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const running = (pid: number): boolean => readHostProcessTable().has(pid);

// A separate harness process launches a SIGTERM-ignoring stand-in browser through the real lease
// and spawn code, then dies. Only its lease connects this test process to that browser.
const HARNESS_SCRIPT = `
import { createLaunchLease } from ${JSON.stringify(NodePath.join(import.meta.dirname, "orphan-lease.ts"))};
import { spawnOwned } from ${JSON.stringify(NodePath.join(import.meta.dirname, "owned-process.ts"))};
const { PROFILE_DIR, LEASE_TMPDIR } = process.env;
const lease = await createLaunchLease(PROFILE_DIR, LEASE_TMPDIR);
const browser = spawnOwned(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', PROFILE_DIR], { profileDir: PROFILE_DIR });
lease.setSpawnedProcess(browser.pid, browser.ownership.startTime);
process.stdout.write(JSON.stringify({ browserPid: browser.pid }) + "\\n");
setInterval(() => {}, 1000);
`;

describe("orphan lease reaping (real signals)", () => {
  it("stops a browser whose harness process died, using only the lease that harness wrote", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "hark-browser-"));
    const script = NodePath.join(tmpdir, "harness.mjs");
    await NodeFSP.writeFile(script, HARNESS_SCRIPT, "utf8");

    const harness = spawnOwned(process.execPath, [script], {
      env: { ...process.env, PROFILE_DIR: profileDir, LEASE_TMPDIR: tmpdir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    owned.push(harness);
    const { browserPid } = JSON.parse(await firstLine(harness)) as { browserPid: number };
    await stopOwnedTree(hostProcessIo(), harness.ownership);
    expect(running(harness.pid)).toBe(false);
    expect(running(browserPid)).toBe(true);
    expect(await NodeFSP.readdir(leaseDirectory(tmpdir))).toHaveLength(1);

    const reaped = await reapOrphanedLaunches(hostProcessIo(), () => undefined, { tmpdir });
    expect(reaped).toBe(1);
    expect(running(browserPid)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
    expect(await NodeFSP.readdir(leaseDirectory(tmpdir))).toEqual([]);
  });

  it("leaves this namespace's PID 1 running when a forged lease names it with its real start time", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "hark-browser-"));
    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const init = readHostProcessTable().get(1);
    const forged = NodePath.join(leaseDir, "forged-pid-1.json");
    await NodeFSP.writeFile(
      forged,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999,
        harnessStartTime: "1",
        spawnedPid: 1,
        spawnedStartTime: init?.startTime,
        profileDir,
        createdAt: new Date(0).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    expect(await reapOrphanedLaunches(hostProcessIo(), () => undefined, { tmpdir })).toBe(0);
    expect(running(1)).toBe(true);
    expect(NodeFS.existsSync(forged)).toBe(true);
  });
});

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
