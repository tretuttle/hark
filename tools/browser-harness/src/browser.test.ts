import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertOutsideLiveProfiles,
  BROWSER_PLATFORMS,
  browserIsOwned,
  LAUNCH_PREFS,
  launchWithRetries,
  liveProfileRoots,
  prepareProfile,
  readExtensionId,
  renderUserJs,
  resolveBrowserSpawnCommand,
  spawnLeasedBrowser,
} from "./browser.ts";
import { createLaunchLease } from "./orphan-lease.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const LIVE_PROFILES = {
  linux: {
    home: "/home/u",
    env: {},
    refused: [
      "/home/u/.zen/abc.Default (release)",
      "/home/u/.mozilla/firefox/x.default-release",
      "/home/u/.librewolf/y.default-default",
      "/home/u/.floorp/z.default",
      "/home/u/.waterfox/w.default",
      "/home/u/.config/mozilla/firefox/p.default",
      "/home/u/.config/librewolf/p",
      "/home/u/.config/floorp/p",
      "/home/u/.config/waterfox/p",
      "/home/u/.cache/mozilla/firefox/p.default",
      "/home/u/.var/app/app.zen_browser.zen/.zen/p",
      "/home/u/.var/app/org.mozilla.firefox/.mozilla/firefox/p",
      "/home/u/snap/firefox/common/.mozilla/firefox/p",
    ],
    accepted: [
      "/tmp/hark-browser-abc",
      "/home/u/.zenith/p",
      "/home/u/.Mozilla/firefox/p",
      "/home/u/projects/.mozilla-notes",
    ],
  },
  darwin: {
    home: "/Users/u",
    env: {},
    refused: [
      "/Users/u/Library/Application Support/zen/Profiles/p.Default (release)",
      "/Users/u/Library/Application Support/Firefox/Profiles/p.default-release",
      "/Users/u/Library/Application Support/firefox/Profiles/p",
      "/Users/u/Library/Application Support/librewolf/Profiles/p",
      "/Users/u/Library/Caches/Firefox/Profiles/p",
      "/Users/u/Library/Caches/zen/Profiles/p",
    ],
    accepted: ["/var/folders/xy/T/hark-browser-abc", "/Users/u/Library/Application Support/Code"],
  },
  win32: {
    home: "C:\\Users\\u",
    env: {
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    },
    refused: [
      "C:\\Users\\u\\AppData\\Roaming\\zen\\Profiles\\p.Default (release)",
      "C:\\Users\\u\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\p.default-release",
      "C:\\Users\\u\\AppData\\Roaming\\mozilla\\Firefox\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\p.default-release",
      "C:\\Users\\u\\AppData\\Roaming\\librewolf\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Roaming\\Floorp\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Roaming\\Waterfox\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Local\\zen\\Profiles\\p",
    ],
    accepted: ["C:\\Users\\u\\AppData\\Local\\Temp\\hark-browser-abc"],
  },
} as const;

describe("browser profile", () => {
  it("writes the prefs that let an isolated browser load an experiment", async () => {
    const directory = await prepareProfile(null);
    directories.push(directory);
    const userJs = await NodeFSP.readFile(NodePath.join(directory, "user.js"), "utf8");
    expect(userJs).toBe(renderUserJs(LAUNCH_PREFS));
    expect(userJs).toContain('user_pref("extensions.experiments.enabled", true);');
    expect(userJs).toContain('user_pref("xpinstall.signatures.required", false);');
    expect(userJs).toContain('user_pref("remote.active-protocols", 1);');
  });

  it("treats the browser as owned only when it is the spawned process or its child", () => {
    expect(browserIsOwned(5, 5, null)).toBe(true);
    expect(browserIsOwned(6, 5, 5)).toBe(true);
    expect(browserIsOwned(6, 5, 4)).toBe(false);
  });

  it("never passes -wait-for-browser on Linux or macOS", () => {
    expect(BROWSER_PLATFORMS.linux.launcherArgs).toEqual([]);
    expect(BROWSER_PLATFORMS.darwin.launcherArgs).toEqual([]);
    expect(BROWSER_PLATFORMS.win32.launcherArgs).toEqual(["-wait-for-browser"]);
  });

  it.each(Object.entries(LIVE_PROFILES))(
    "on %s refuses every live Zen and Firefox family profile and nothing else",
    (platform, sample) => {
      const name = platform as keyof typeof LIVE_PROFILES;
      const roots = liveProfileRoots(name, sample.env, sample.home);
      const path = BROWSER_PLATFORMS[name].path;
      const caseFold = name !== "linux";
      for (const directory of sample.refused) {
        expect(
          () => assertOutsideLiveProfiles(directory, roots, path, caseFold),
          directory,
        ).toThrow(/inside the live profile root/);
      }
      for (const directory of sample.accepted) {
        expect(
          () => assertOutsideLiveProfiles(directory, roots, path, caseFold),
          directory,
        ).not.toThrow();
      }
    },
  );

  it("follows XDG_CONFIG_HOME and refuses when Windows cannot name its profile roots", () => {
    const roots = liveProfileRoots("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/u");
    expect(() =>
      assertOutsideLiveProfiles("/xdg/mozilla/firefox/p", roots, NodePath.posix),
    ).toThrow();
    expect(() => liveProfileRoots("win32", {}, "C:\\Users\\u")).toThrow(/APPDATA is not set/);
  });

  it("refuses a symlinked temporary directory that resolves inside a live profile before creating one", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-guard-"));
    directories.push(scratch);
    const home = NodePath.join(scratch, "home");
    const live = NodePath.join(home, ".mozilla");
    const link = NodePath.join(scratch, "tmp-link");
    await NodeFSP.mkdir(live, { recursive: true });
    await NodeFSP.symlink(live, link);
    await NodeFSP.chmod(live, 0o555);
    const previous = {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.HOME = home;
    process.env.TMPDIR = link;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      await expect(prepareProfile(null)).rejects.toThrow(/inside the live profile root/);
      expect(await NodeFSP.readdir(live)).toEqual([]);
    } finally {
      await NodeFSP.chmod(live, 0o755);
      restoreEnv(previous);
    }
  });

  it("sideloads an unpacked extension and an xpi by gecko id", async () => {
    const unpacked = await makeUnpacked("unpacked@hark");
    const unpackedProfile = await prepareProfile(unpacked);
    directories.push(unpackedProfile);
    const proxy = await NodeFSP.readFile(
      NodePath.join(unpackedProfile, "extensions", "unpacked@hark"),
      "utf8",
    );
    expect(proxy).toBe(unpacked);

    const xpi = await makeXpi("packed@hark");
    expect(await readExtensionId(unpacked)).toBe("unpacked@hark");
    expect(await readExtensionId(xpi)).toBe("packed@hark");
    const packedProfile = await prepareProfile(xpi);
    directories.push(packedProfile);
    const copied = await NodeFSP.stat(
      NodePath.join(packedProfile, "extensions", "packed@hark.xpi"),
    );
    expect(copied.isFile()).toBe(true);
  });

  it("wraps Linux commands with prlimit --core=1:1 -- when prlimit exists unless suppressCoreDumps is false", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-cmd-"));
    directories.push(scratch);
    const fakeBinDir = NodePath.join(scratch, "bin");
    const fakePrlimit = NodePath.join(fakeBinDir, "prlimit");
    await NodeFSP.mkdir(fakeBinDir, { recursive: true });
    await NodeFSP.writeFile(fakePrlimit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], {
        platform: "linux",
        env: { PATH: fakeBinDir },
      }),
    ).toEqual({
      command: fakePrlimit,
      args: ["--core=1:1", "--", "/opt/zen/zen", "-headless"],
    });
    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], {
        platform: "linux",
        suppressCoreDumps: false,
        env: { PATH: fakeBinDir },
      }),
    ).toEqual({ command: "/opt/zen/zen", args: ["-headless"] });
    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], {
        platform: "linux",
        env: { PATH: scratch },
      }),
    ).toEqual({ command: "/opt/zen/zen", args: ["-headless"] });
    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], { platform: "darwin" }),
    ).toEqual({ command: "/opt/zen/zen", args: ["-headless"] });
    expect(
      resolveBrowserSpawnCommand("C:\\zen\\zen.exe", ["-headless"], { platform: "win32" }),
    ).toEqual({ command: "C:\\zen\\zen.exe", args: ["-headless"] });
  });

  // A stand-in prlimit on the launch's own PATH records that it wrapped the command, then runs it.
  async function launchStandIn(suppressCoreDumps: boolean | undefined) {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-spawn-"));
    directories.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "hark-browser-"));
    const bin = NodePath.join(tmpdir, "bin");
    const marker = NodePath.join(tmpdir, "wrapped");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "prlimit"),
      `#!/bin/sh\necho wrapped > '${marker}'\nshift 2\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const lease = await createLaunchLease(profileDir, tmpdir);
    // Exits by itself, so nothing here has to stop it.
    const { spawned, watcher } = spawnLeasedBrowser(
      process.execPath,
      ["-e", "process.stderr.write(String(process.env.HARK_MARK))", profileDir],
      lease,
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PATH: bin, HARK_MARK: "set" },
        profileDir,
        suppressCoreDumps,
      },
    );
    const exit = await watcher.exited;
    const recorded: unknown = JSON.parse(NodeFS.readFileSync(lease.filePath, "utf8"));
    await lease.remove();
    return { spawned, exit, recorded, profileDir, wrapped: NodeFS.existsSync(marker) };
  }

  it("owns the launched browser with its profile directory, records it in the lease, and runs it with the launch's environment", async () => {
    const launch = await launchStandIn(false);
    expect(launch.spawned.ownership).toMatchObject({
      pid: launch.spawned.pid,
      profileDir: launch.profileDir,
    });
    expect(launch.recorded).toMatchObject({
      spawnedPid: launch.spawned.pid,
      spawnedStartTime: launch.spawned.ownership?.startTime,
    });
    expect(launch.exit.status).toBe("code 0");
    expect(launch.exit.stderr).toBe("set");
    expect(launch.wrapped).toBe(false);
  });

  it("wraps the launch with the prlimit found on the launch's own PATH unless core dumps are allowed", async () => {
    expect((await launchStandIn(undefined)).wrapped).toBe(true);
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function makeUnpacked(id: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-ext-"));
  directories.push(directory);
  await NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), manifest(id), "utf8");
  return directory;
}

async function makeXpi(id: string): Promise<string> {
  const directory = await makeUnpacked(id);
  const xpi = NodePath.join(directory, "addon.xpi");
  await NodeFSP.writeFile(xpi, storedZip("manifest.json", Buffer.from(manifest(id), "utf8")));
  return xpi;
}

function storedZip(name: string, payload: Buffer): Buffer {
  const crc = NodeZlib.crc32(payload);
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(30 + nameBytes.length + payload.length, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, eocd]);
}

function manifest(id: string): string {
  return `${JSON.stringify({
    manifest_version: 2,
    name: "probe",
    version: "1.0.0",
    browser_specific_settings: { gecko: { id } },
  })}\n`;
}

describe("launch retries", () => {
  const lost = (): Error =>
    new Error("timed out waiting for marionette\nBrowsing context has been discarded");

  const launching = (
    outcomes: readonly (Error | string)[],
    state: { readonly attached: boolean; readonly aborted: boolean } = {
      attached: false,
      aborted: false,
    },
  ) => {
    const lines: string[] = [];
    let starts = 0;
    const session = launchWithRetries({
      protocol: "marionette",
      start: async () => {
        const outcome = outcomes[starts];
        starts += 1;
        if (outcome === undefined) throw new Error("started more often than the test allows");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      attached: () => state.attached,
      aborted: () => state.aborted,
      report: (line) => lines.push(line),
    });
    return { session, lines, starts: () => starts };
  };

  it("starts again after a lost launch and reports each retry with its cause", async () => {
    const run = launching([lost(), lost(), "session"]);
    await expect(run.session).resolves.toBe("session");
    expect(run.starts()).toBe(3);
    expect(run.lines).toEqual([
      "retrying browser launch (retry 1 of 2) before marionette attached: timed out waiting for marionette | Browsing context has been discarded",
      "retrying browser launch (retry 2 of 2) before marionette attached: timed out waiting for marionette | Browsing context has been discarded",
    ]);
  });

  it("gives up with the last failure when a launch is lost three times", async () => {
    const run = launching([lost(), lost(), new Error("SB::LA::SpawnTarget (third)"), "session"]);
    await expect(run.session).rejects.toThrow("SB::LA::SpawnTarget (third)");
    expect(run.starts()).toBe(3);
  });

  it.each([
    ["any other failure", [new Error("browser exited with status 1")], undefined],
    ["a failure after remote control attached", [lost()], { attached: true, aborted: false }],
    ["a failure after the run was aborted", [lost()], { attached: false, aborted: true }],
  ] as const)("does not start again after %s", async (_name, outcomes, state) => {
    const run = launching(outcomes, state);
    await expect(run.session).rejects.toThrow(outcomes[0]?.message);
    expect(run.starts()).toBe(1);
    expect(run.lines).toEqual([]);
  });
});
