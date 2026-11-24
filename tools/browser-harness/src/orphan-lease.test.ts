import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createLaunchLease,
  leaseDirectory,
  parseLease,
  reapOrphanedLaunches,
} from "./orphan-lease.ts";
import type { ProcessIdentity } from "./signal-policy.ts";
import { HARNESS, processIdentity, simulateProcesses } from "./simulated-process-io.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await NodeFSP.chmod(dir, 0o755).catch(() => undefined);
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const DEAD_HARNESS = { harnessPid: 999_999, harnessStartTime: "1" };

async function makeLeaseDirs(): Promise<{ tmpdir: string; profileDir: string; leaseDir: string }> {
  const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-lease-"));
  cleanupDirs.push(tmpdir);
  const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "hark-browser-"));
  const leaseDir = leaseDirectory(tmpdir);
  await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  return { tmpdir, profileDir, leaseDir };
}

async function writeLease(
  leaseDir: string,
  name: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const file = NodePath.join(leaseDir, `${name}.json`);
  await NodeFSP.writeFile(
    file,
    JSON.stringify({
      version: 2,
      createdAt: new Date(0).toISOString(),
      ...DEAD_HARNESS,
      ...fields,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return file;
}

const orphanBrowser = (profileDir: string): ProcessIdentity =>
  processIdentity(5000, { args: ["/opt/zen/zen", "-profile", profileDir] });

describe("orphan launch leases", () => {
  it("stores lease directory as 0700 and lease files as 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const { tmpdir, profileDir } = await makeLeaseDirs();
    const lease = await createLaunchLease(profileDir, tmpdir);
    expect(NodeFS.lstatSync(leaseDirectory(tmpdir)).mode & 0o777).toBe(0o700);
    expect(NodeFS.lstatSync(lease.filePath).mode & 0o777).toBe(0o600);
    await lease.remove();
  });

  it("stops a dead harness's browser using only the lease, then removes its profile and lease", async () => {
    const { tmpdir, profileDir, leaseDir } = await makeLeaseDirs();
    const leaseFile = await writeLease(leaseDir, "orphan", {
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const world = simulateProcesses([orphanBrowser(profileDir)]);
    const reaped = await reapOrphanedLaunches(world.io, () => undefined, { tmpdir });
    expect(reaped).toBe(1);
    expect(world.sent).toEqual([{ rawTarget: -5000, signal: "SIGTERM", at: 0 }]);
    expect(world.running(5000)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
  });

  it("leaves a live harness's browser, profile and lease untouched", async () => {
    const { tmpdir, profileDir, leaseDir } = await makeLeaseDirs();
    const leaseFile = await writeLease(leaseDir, "live", {
      harnessPid: HARNESS.pid,
      harnessStartTime: "20000",
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const world = simulateProcesses([orphanBrowser(profileDir)]);
    expect(await reapOrphanedLaunches(world.io, () => undefined, { tmpdir })).toBe(0);
    expect(world.sent).toEqual([]);
    expect(NodeFS.existsSync(profileDir)).toBe(true);
    expect(NodeFS.existsSync(leaseFile)).toBe(true);
  });

  it.each([
    { name: "a reused PID (start time differs)", spawnedStartTime: "1", args: undefined },
    {
      name: "a process without the profile path",
      spawnedStartTime: "50000",
      args: ["/usr/bin/editor"],
    },
  ])(
    "never signals $name or a helper naming its profile, and clears the stale lease and profile",
    async (row) => {
      const { tmpdir, profileDir, leaseDir } = await makeLeaseDirs();
      const leaseFile = await writeLease(leaseDir, "stale", {
        spawnedPid: 5000,
        spawnedStartTime: row.spawnedStartTime,
        profileDir,
      });
      const world = simulateProcesses([
        processIdentity(5000, { args: row.args ?? ["/opt/zen/zen", "-profile", profileDir] }),
        processIdentity(5100, { args: ["/opt/zen/zen", "-profile", profileDir, "-helper"] }),
      ]);
      expect(await reapOrphanedLaunches(world.io, () => undefined, { tmpdir })).toBe(1);
      expect(world.sent).toEqual([]);
      expect([5000, 5100].map(world.running)).toEqual([true, true]);
      expect(NodeFS.existsSync(leaseFile)).toBe(false);
      expect(NodeFS.existsSync(profileDir)).toBe(false);
    },
  );

  it.each([
    { name: "a quoted profile path with a space", quoted: true, suffix: "", stopped: true },
    {
      name: "a path that only starts with the profile path",
      quoted: false,
      suffix: "-longer",
      stopped: false,
    },
  ])("matches the profile path as a whole argument: $name", async (row) => {
    const { tmpdir, leaseDir } = await makeLeaseDirs();
    const profileDir = NodePath.join(tmpdir, "Jane Doe", "hark-browser-q");
    await NodeFSP.mkdir(profileDir, { recursive: true });
    await writeLease(leaseDir, "path", { spawnedPid: 5000, spawnedStartTime: "50000", profileDir });
    const shown = row.quoted ? `"${profileDir}"` : `${profileDir}${row.suffix}`;
    const commandLine = `zen.exe -profile ${shown}`;
    const world = simulateProcesses([
      { ...processIdentity(5000), args: commandLine.split(/\s+/u), commandLine },
    ]);
    await reapOrphanedLaunches(world.io, () => undefined, { tmpdir });
    expect(world.sent).toEqual(row.stopped ? [{ rawTarget: -5000, signal: "SIGTERM", at: 0 }] : []);
  });

  it("ignores leases naming PID 1, unparseable leases and old versions without touching them", async () => {
    const { tmpdir, profileDir, leaseDir } = await makeLeaseDirs();
    const forged = await writeLease(leaseDir, "pid-1", {
      spawnedPid: 1,
      spawnedStartTime: "10",
      profileDir,
    });
    const corrupt = NodePath.join(leaseDir, "corrupt.json");
    await NodeFSP.writeFile(corrupt, "{not valid json", "utf8");
    const old = await writeLease(leaseDir, "v1", { version: 1, spawnedPid: 5000, profileDir });
    const forgedText = await NodeFSP.readFile(forged, "utf8");
    const world = simulateProcesses([
      processIdentity(1, { parentPid: 0, args: ["/sbin/init", "-profile", profileDir] }),
      orphanBrowser(profileDir),
    ]);
    const warnings: string[] = [];
    const options = { tmpdir, onWarning: (message: string) => warnings.push(message) };
    expect(await reapOrphanedLaunches(world.io, () => undefined, options)).toBe(0);
    expect(world.sent).toEqual([]);
    expect(warnings).toEqual([]);
    expect(await NodeFSP.readFile(forged, "utf8")).toBe(forgedText);
    expect([forged, corrupt, old, profileDir].map((path) => NodeFS.existsSync(path))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps the lease and records the failure when the browser cannot be stopped, then reaps it on the next launch", async () => {
    const { tmpdir, profileDir, leaseDir } = await makeLeaseDirs();
    const leaseFile = await writeLease(leaseDir, "stuck", {
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const stuck = simulateProcesses([orphanBrowser(profileDir)], {
      survives: { 5000: "everything" },
    });
    const warnings: string[] = [];
    const first = await reapOrphanedLaunches(stuck.io, () => undefined, {
      tmpdir,
      onWarning: (message) => warnings.push(message),
    });
    expect(first).toBe(0);
    expect(warnings).toEqual([
      expect.stringMatching(
        /attempt 1\); kept its lease to retry on the next launch: owned process still running: 5000/,
      ),
    ]);
    expect(JSON.parse(await NodeFSP.readFile(leaseFile, "utf8"))).toMatchObject({
      spawnedPid: 5000,
      reapFailures: 1,
      lastReapFailure: "owned process still running: 5000",
    });
    expect(NodeFS.existsSync(profileDir)).toBe(true);

    const next = simulateProcesses([orphanBrowser(profileDir)]);
    expect(await reapOrphanedLaunches(next.io, () => undefined, { tmpdir })).toBe(1);
    expect(next.sent).toEqual([{ rawTarget: -5000, signal: "SIGTERM", at: 0 }]);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
  });

  it("keeps the lease when removing the profile fails, and retries it once removal can succeed", async () => {
    if (process.platform === "win32") return;
    const { tmpdir, leaseDir } = await makeLeaseDirs();
    const parent = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "locked-parent-"));
    const profileDir = NodePath.join(parent, "hark-browser-stuck");
    await NodeFSP.mkdir(profileDir);
    await NodeFSP.writeFile(NodePath.join(profileDir, "lock"), "busy");
    await NodeFSP.chmod(parent, 0o555);
    const leaseFile = await writeLease(leaseDir, "stuck-rm", {
      spawnedPid: null,
      spawnedStartTime: null,
      profileDir,
    });
    const world = simulateProcesses([]);
    const warnings: string[] = [];
    const removeProfile = (directory: string) =>
      NodeFSP.rm(directory, { recursive: true, force: true });
    const options = { tmpdir, onWarning: (m: string) => warnings.push(m), removeProfile };
    try {
      expect(await reapOrphanedLaunches(world.io, () => undefined, options)).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(NodeFS.existsSync(leaseFile)).toBe(true);
    } finally {
      await NodeFSP.chmod(parent, 0o755);
    }

    expect(await reapOrphanedLaunches(world.io, () => undefined, options)).toBe(1);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
  });

  it("refuses to reap a profile directory outside safe bounds", async () => {
    const { tmpdir, leaseDir } = await makeLeaseDirs();
    await writeLease(leaseDir, "unsafe", {
      spawnedPid: null,
      spawnedStartTime: null,
      profileDir: "/home/u/.mozilla/hark-browser-bad",
    });
    await expect(
      reapOrphanedLaunches(
        simulateProcesses([]).io,
        (dir) => {
          if (dir.includes(".mozilla")) throw new Error("refusing live profile root");
        },
        { tmpdir },
      ),
    ).rejects.toThrow("refusing live profile root");
  });
});

const VALID_LEASE = {
  version: 2,
  harnessPid: 4242,
  harnessStartTime: "9",
  spawnedPid: 5000,
  spawnedStartTime: "50000",
  profileDir: "/tmp/hark-browser-abc",
  createdAt: "2026-11-16T00:00:00.000Z",
};
const leaseText = (fields: Record<string, unknown>, without: readonly string[] = []) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries({ ...VALID_LEASE, ...fields }).filter(([key]) => !without.includes(key)),
    ),
  );

describe("parsing a lease", () => {
  it.each([
    ["text that is not JSON", "{not valid json"],
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "5"],
    ["version 1", leaseText({ version: 1 })],
    ["version 3", leaseText({ version: 3 })],
    ["no version", leaseText({}, ["version"])],
    ["no harness PID", leaseText({}, ["harnessPid"])],
    ["a harness PID written as text", leaseText({ harnessPid: "4242" })],
    ["a fractional harness PID", leaseText({ harnessPid: 1.5 })],
    ["harness PID 0", leaseText({ harnessPid: 0 })],
    ["a negative harness PID", leaseText({ harnessPid: -1 })],
    ["no harness start time", leaseText({}, ["harnessStartTime"])],
    ["an empty harness start time", leaseText({ harnessStartTime: "" })],
    ["a harness start time written as a number", leaseText({ harnessStartTime: 9 })],
    ["a harness start time inside an array", leaseText({ harnessStartTime: ["9"] })],
    ["no profile directory", leaseText({}, ["profileDir"])],
    ["a profile directory that is not text", leaseText({ profileDir: 5 })],
    ["a relative profile directory", leaseText({ profileDir: "tmp/hark-browser-abc" })],
    ["a profile directory without the prefix", leaseText({ profileDir: "/tmp/other-abc" })],
    [
      "the prefix only on a parent directory",
      leaseText({ profileDir: "/tmp/hark-browser-abc/inner" }),
    ],
    ["browser PID 1", leaseText({ spawnedPid: 1 })],
    ["browser PID 0", leaseText({ spawnedPid: 0 })],
    ["a browser PID written as text", leaseText({ spawnedPid: "5000" })],
    ["a fractional browser PID", leaseText({ spawnedPid: 1.5 })],
    ["an empty browser start time", leaseText({ spawnedStartTime: "" })],
    ["a browser start time written as a number", leaseText({ spawnedStartTime: 50000 })],
    ["a browser start time without a PID", leaseText({ spawnedPid: null })],
    ["a browser PID without a start time", leaseText({ spawnedStartTime: null })],
    ["no browser fields at all", leaseText({}, ["spawnedPid", "spawnedStartTime"])],
  ])("ignores %s", (_name, text) => {
    expect(parseLease(text)).toBeNull();
  });

  it.each([
    ["a complete lease", {}, {}],
    ["harness PID 1", { harnessPid: 1 }, { harnessPid: 1 }],
    [
      "browser PID 2 with a one-digit start time",
      { spawnedPid: 2, spawnedStartTime: "1" },
      { spawnedPid: 2, spawnedStartTime: "1" },
    ],
    [
      "a launch that never recorded its browser",
      { spawnedPid: null, spawnedStartTime: null },
      { spawnedPid: null, spawnedStartTime: null },
    ],
    ["a creation time that is not text", { createdAt: 5 }, { createdAt: "" }],
    [
      "a failed reap's count and message",
      { reapFailures: 2, lastReapFailure: "boom" },
      { reapFailures: 2, lastReapFailure: "boom" },
    ],
    ["a zero failure count", { reapFailures: 0 }, {}],
    ["a failure count written as text", { reapFailures: "2" }, {}],
    ["a fractional failure count", { reapFailures: 1.5 }, {}],
    ["a failure message that is not text", { lastReapFailure: 5 }, {}],
  ])("reads %s", (_name, fields, expected) => {
    expect(parseLease(leaseText(fields))).toStrictEqual({ ...VALID_LEASE, ...expected });
  });

  it("drops a missing creation time to empty text", () => {
    expect(parseLease(leaseText({}, ["createdAt"]))).toStrictEqual({
      ...VALID_LEASE,
      createdAt: "",
    });
  });
});
