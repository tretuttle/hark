import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { launchBrowser, resolveBrowserSpawnCommand } from "./browser.ts";
import { requireIsolatedPidNamespace, runNamespacedSuites } from "./namespace-isolation.ts";
import { leaseDirectory } from "./orphan-lease.ts";
import { hostProcessIo, spawnOwned, stopOwnedTree, type OwnedChild } from "./owned-process.ts";
import { readHostProcessTable, readProcessIdentity } from "./process-table.ts";
import { adoptSpawnedChild, type Ownership } from "./signal-policy.ts";

requireIsolatedPidNamespace();

const directories: string[] = [];
const cleanup: OwnedChild[] = [];
const adopted: Ownership[] = [];

afterEach(async () => {
  for (const child of cleanup.splice(0)) await stopOwnedTree(hostProcessIo(), child.ownership);
  for (const owner of adopted.splice(0)) await stopOwnedTree(hostProcessIo(), owner);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const running = (pid: number): boolean => readHostProcessTable().has(pid);

// A POSIX shell script stands in for the browser.
describe("browser launch (real signals)", () => {
  it.each(["bidi", "marionette"] as const)(
    "asks for a headless %s browser and leaves no profile or process when it exits at startup",
    async (protocol) => {
      const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-fake-"));
      directories.push(scratch);
      const argsFile = NodePath.join(scratch, "args");
      const prefsFile = NodePath.join(scratch, "user.js");
      const binary = NodePath.join(scratch, "browser");
      await NodeFSP.writeFile(
        binary,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\necho "fake browser refused to start" >&2\nexit 3\n`,
        { mode: 0o755 },
      );
      await expect(
        launchBrowser({
          binaryPath: binary,
          extensionPath: null,
          display: "headless",
          protocol,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/browser exited with code 3[\s\S]*fake browser refused to start/);
      const args = (await NodeFSP.readFile(argsFile, "utf8")).trim().split("\n");
      const prefs = await NodeFSP.readFile(prefsFile, "utf8");
      expect(args[0]).toBe("-headless");
      expect(args).toContain("-no-remote");
      expect(args).not.toContain("-wait-for-browser");
      if (protocol === "bidi") {
        expect(args).toContain("--remote-debugging-port");
        expect(args).not.toContain("-marionette");
        expect(prefs).not.toContain("marionette.port");
      } else {
        expect(args).toContain("-marionette");
        expect(args).not.toContain("--remote-debugging-port");
        expect(prefs).toMatch(/user_pref\("marionette\.port", \d+\);/);
      }
      const profile = args[args.indexOf("-profile") + 1] ?? "";
      expect(profile.startsWith(NodeOS.tmpdir())).toBe(true);
      expect(NodeFS.existsSync(profile)).toBe(false);
    },
  );

  it("on dispose stops a process outside the browser's group that still names its profile", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-holder-"));
    directories.push(scratch);
    const pidFile = NodePath.join(scratch, "holder.pid");
    const binary = NodePath.join(scratch, "browser");
    // The holder leaves the browser's process group with setsid, so only its profile path ties it to the launch.
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh
while [ $# -gt 0 ] && [ "$1" != "-profile" ]; do shift; done
setsid '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);' '${pidFile}' "$2" &
exec '${process.execPath}' -e 'setInterval(() => {}, 1000)' -profile "$2"
`,
      { mode: 0o755 },
    );
    const session = await launchBrowser({
      binaryPath: binary,
      extensionPath: null,
      display: "headless",
      launchMode: "none",
      signal: new AbortController().signal,
    });
    const holderPid = await readPidFile(pidFile);
    const holder = readProcessIdentity(holderPid);
    if (holder !== undefined) {
      adopted.push(
        adoptSpawnedChild({
          pid: holderPid,
          startTime: holder.startTime,
          profileDir: session.profileDir,
        }),
      );
    }
    expect(holder?.pgrp).not.toBe(session.spawnedPid);
    await session[Symbol.asyncDispose]();
    expect(running(session.spawnedPid)).toBe(false);
    expect(running(holderPid)).toBe(false);
    expect(NodeFS.existsSync(session.profileDir)).toBe(false);
  });

  it("writes remote.prefs.recommended=false in real-defaults mode and omits remote flags/prefs in none mode", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-mode-"));
    directories.push(scratch);
    const argsFile = NodePath.join(scratch, "args");
    const prefsFile = NodePath.join(scratch, "user.js");
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\nexit 0\n`,
      { mode: 0o755 },
    );

    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "real-defaults",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/browser exited with code 0/);
    expect(await NodeFSP.readFile(prefsFile, "utf8")).toContain(
      'user_pref("remote.prefs.recommended", false);',
    );

    const session = await launchBrowser({
      binaryPath: binary,
      extensionPath: null,
      display: "headless",
      launchMode: "none",
      urls: ["file:///tmp/example.html"],
      signal: new AbortController().signal,
    });
    expect(await session.exited).toBe("code 0");
    const noneArgs = (await NodeFSP.readFile(argsFile, "utf8")).trim().split("\n");
    const nonePrefs = await NodeFSP.readFile(prefsFile, "utf8");
    expect(noneArgs).toContain("file:///tmp/example.html");
    expect(noneArgs).not.toContain("-marionette");
    expect(noneArgs).not.toContain("--remote-debugging-port");
    expect(noneArgs).not.toContain("-wait-for-browser");
    expect(nonePrefs).not.toContain("devtools.debugger.remote-enabled");
    expect(nonePrefs).not.toContain("remote.active-protocols");
    expect(nonePrefs).not.toContain("marionette.port");
    await session[Symbol.asyncDispose]();
  });

  it("enables HTTP cache prefs only when cache: true is requested", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-cache-"));
    directories.push(scratch);
    const prefsFile = NodePath.join(scratch, "user.js");
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\nexit 1\n`,
      { mode: 0o755 },
    );

    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        cache: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/browser exited with code 1/);
    const enabled = await NodeFSP.readFile(prefsFile, "utf8");
    expect(enabled).toContain('user_pref("network.http.use-cache", true);');
    expect(enabled).toContain('user_pref("browser.cache.disk.enable", true);');
    expect(enabled).toContain('user_pref("browser.cache.memory.enable", true);');
  });

  it("fails immediately on early exit with buffered stderr even when a descendant keeps stderr open", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-desc-stderr-"));
    directories.push(scratch);
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nsleep 30 &\necho "boom: browser crashed at startup" >&2\nexit 3\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      /browser exited with code 3 before remote control opened[\s\S]*boom: browser crashed at startup/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports exit signal and stderr when a connected browser dies mid-session, kills its tree on dispose, and reaps prior orphans on launch", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-fake-marionette-"));
    directories.push(scratch);

    // An orphan lease and its live process, which launchBrowser must reap on startup.
    const orphanProfile = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "hark-browser-orphan-"),
    );
    directories.push(orphanProfile);
    const orphan = spawnOwned(
      process.execPath,
      ["-e", `// ${orphanProfile}\nprocess.stdout.write("ready\\n"); setInterval(() => {}, 1000);`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    cleanup.push(orphan);
    // Until the child has exec'd, /proc/<pid>/cmdline can be empty and the process unreadable.
    await new Promise((resolve) => orphan.child.stdout?.once("data", resolve));
    const orphanIdentity = readProcessIdentity(orphan.pid);
    expect(orphanIdentity).toBeDefined();
    const orphanLeaseDir = leaseDirectory();
    await NodeFSP.mkdir(orphanLeaseDir, { recursive: true, mode: 0o700 });
    const orphanLease = NodePath.join(orphanLeaseDir, `test-orphan-${String(Date.now())}.json`);
    await NodeFSP.writeFile(
      orphanLease,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: orphan.pid,
        spawnedStartTime: orphanIdentity?.startTime,
        profileDir: orphanProfile,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const serverScript = NodePath.join(scratch, "fake-marionette.mjs");
    await NodeFSP.writeFile(
      serverScript,
      `import * as NodeFS from "node:fs";
       import * as NodeNet from "node:net";
       import * as NodePath from "node:path";
       const idx = process.argv.indexOf("-profile");
       const profile = process.argv[idx + 1];
       const userJs = NodeFS.readFileSync(NodePath.join(profile, "user.js"), "utf8");
       const port = Number(/user_pref\\("marionette\\.port", (\\d+)\\)/.exec(userJs)[1]);
       const server = NodeNet.createServer((socket) => {
         const send = (obj) => {
           const buf = Buffer.from(JSON.stringify(obj), "utf8");
           socket.write(buf.length + ":" + buf.toString("utf8"));
         };
         send({ applicationType: "gecko", marionetteProtocol: 3 });
         let buf = Buffer.alloc(0);
         socket.on("data", (chunk) => {
           buf = Buffer.concat([buf, chunk]);
           while (buf.length > 0) {
             const colon = buf.indexOf(0x3a);
             if (colon <= 0) return;
             const len = Number(buf.subarray(0, colon).toString("ascii"));
             if (buf.length < colon + 1 + len) return;
             const raw = buf.subarray(colon + 1, colon + 1 + len).toString("utf8");
             buf = buf.subarray(colon + 1 + len);
             const msg = JSON.parse(raw);
             if (!Array.isArray(msg)) continue;
             const [, id, cmd] = msg;
             if (cmd === "WebDriver:NewSession") {
               send([1, id, null, { sessionId: "1", capabilities: { "moz:processID": process.pid, browserName: "zen", browserVersion: "1.25t", "moz:buildID": "20261115114312", userAgent: "Fake/1.0" } }]);
             } else if (cmd === "WebDriver:GetWindowHandle") {
               send([1, id, null, { value: "win-1" }]);
             } else if (cmd === "WebDriver:NewWindow") {
               process.stderr.write("fatal mid-session stderr\\n");
               process.kill(process.pid, "SIGKILL");
             }
           }
         });
       });
       server.listen(port, "127.0.0.1");
       setInterval(() => {}, 1000);`,
      "utf8",
    );
    const fakeBin = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      fakeBin,
      `#!/bin/sh\nexec '${process.execPath}' '${serverScript}' "$@"\n`,
      { mode: 0o755 },
    );

    let spawnedPid = 0;
    {
      await using session = await launchBrowser({
        binaryPath: fakeBin,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      });
      spawnedPid = session.spawnedPid;
      expect(running(orphan.pid)).toBe(false);
      expect(NodeFS.existsSync(orphanLease)).toBe(false);
      await expect(session.openTab("about:blank")).rejects.toThrow(
        /Marionette socket closed \(browser exited with signal SIGKILL\)[\s\S]*fatal mid-session stderr/,
      );
    }

    // Verify normal dispose kills a hung connected browser tree too.
    const hangBin = NodePath.join(scratch, "browser-hang");
    const hangScript = NodePath.join(scratch, "fake-marionette-hang.mjs");
    await NodeFSP.writeFile(
      hangScript,
      `import * as NodeFS from "node:fs";
       import * as NodeNet from "node:net";
       import * as NodePath from "node:path";
       const idx = process.argv.indexOf("-profile");
       const profile = process.argv[idx + 1];
       const userJs = NodeFS.readFileSync(NodePath.join(profile, "user.js"), "utf8");
       const port = Number(/user_pref\\("marionette\\.port", (\\d+)\\)/.exec(userJs)[1]);
       const server = NodeNet.createServer((socket) => {
         const send = (obj) => {
           const buf = Buffer.from(JSON.stringify(obj), "utf8");
           socket.write(buf.length + ":" + buf.toString("utf8"));
         };
         send({ applicationType: "gecko", marionetteProtocol: 3 });
         let buf = Buffer.alloc(0);
         socket.on("data", (chunk) => {
           buf = Buffer.concat([buf, chunk]);
           while (buf.length > 0) {
             const colon = buf.indexOf(0x3a);
             if (colon <= 0) return;
             const len = Number(buf.subarray(0, colon).toString("ascii"));
             if (buf.length < colon + 1 + len) return;
             const raw = buf.subarray(colon + 1, colon + 1 + len).toString("utf8");
             buf = buf.subarray(colon + 1 + len);
             const msg = JSON.parse(raw);
             if (!Array.isArray(msg)) continue;
             const [, id, cmd] = msg;
             if (cmd === "WebDriver:NewSession") {
               send([1, id, null, { sessionId: "1", capabilities: { "moz:processID": process.pid, browserName: "zen", browserVersion: "1.25t", "moz:buildID": "20261115114312", userAgent: "Fake/1.0" } }]);
             } else if (cmd === "WebDriver:GetWindowHandle") {
               send([1, id, null, { value: "win-1" }]);
             }
           }
         });
       });
       server.listen(port, "127.0.0.1");
       setInterval(() => {}, 1000);`,
      "utf8",
    );
    await NodeFSP.writeFile(
      hangBin,
      `#!/bin/sh\nexec '${process.execPath}' '${hangScript}' "$@"\n`,
      { mode: 0o755 },
    );
    let hungPid = 0;
    {
      await using session = await launchBrowser({
        binaryPath: hangBin,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      });
      hungPid = session.spawnedPid;
      expect(running(hungPid)).toBe(true);
    }
    expect(running(hungPid)).toBe(false);
    void spawnedPid;
  });

  it("wraps Linux launches with prlimit --core=1:1 -- by default, verifies limits without aborting, and honors suppressCoreDumps: false", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-core-"));
    directories.push(scratch);
    const fakeBinDir = NodePath.join(scratch, "bin");
    const fakePrlimit = NodePath.join(fakeBinDir, "prlimit");
    const prlimitCallsFile = NodePath.join(scratch, "prlimit-calls");
    await NodeFSP.mkdir(fakeBinDir, { recursive: true });
    await NodeFSP.writeFile(
      fakePrlimit,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${prlimitCallsFile}'\nif [ "$1" = "--core=1:1" ] && [ "$2" = "--" ]; then shift 2; fi\nexec "$@"\n`,
      { mode: 0o755 },
    );

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
    ).toEqual({
      command: "/opt/zen/zen",
      args: ["-headless"],
    });
    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], {
        platform: "linux",
        env: { PATH: scratch },
      }),
    ).toEqual({
      command: "/opt/zen/zen",
      args: ["-headless"],
    });
    expect(
      resolveBrowserSpawnCommand("/opt/zen/zen", ["-headless"], { platform: "darwin" }),
    ).toEqual({ command: "/opt/zen/zen", args: ["-headless"] });
    expect(
      resolveBrowserSpawnCommand("C:\\zen\\zen.exe", ["-headless"], { platform: "win32" }),
    ).toEqual({ command: "C:\\zen\\zen.exe", args: ["-headless"] });

    if (process.platform === "linux") {
      // Prove prlimit --core=1:1 without calling SIGABRT/process.abort(), which emits kernel aborting-core logs.
      const ownSpawn = resolveBrowserSpawnCommand(
        process.execPath,
        [
          "-e",
          'const fs=require("node:fs");console.log(fs.readFileSync("/proc/self/limits","utf8").split("\\n").find((l)=>/core file/i.test(l))??"");setInterval(()=>{},1000);',
        ],
        { platform: "linux" },
      );
      const child = spawnOwned(ownSpawn.command, ownSpawn.args, {
        stdio: ["ignore", "pipe", "inherit"],
      });
      try {
        const firstLine = await new Promise<string>((resolve, reject) => {
          let out = "";
          child.child.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
            const nl = out.indexOf("\n");
            if (nl !== -1) resolve(out.slice(0, nl).trim());
          });
          child.child.once("close", (code) => reject(new Error(`child exited ${String(code)}`)));
        });
        expect(firstLine).toMatch(/Max core file size\s+1\s+1\s+bytes/);
        const livePrlimit = NodeChildProcess.execFileSync(
          "prlimit",
          ["--pid", String(child.pid), "--core"],
          { encoding: "utf8" },
        );
        expect(livePrlimit).toMatch(/\b1\s+1\b/);
      } finally {
        await stopOwnedTree(hostProcessIo(), child.ownership);
      }

      const pidFile = NodePath.join(scratch, "killed-pid");
      const signalBin = NodePath.join(scratch, "signal-browser");
      const signalScript = NodePath.join(scratch, "signal-browser.mjs");
      await NodeFSP.writeFile(
        signalScript,
        `import * as fs from "node:fs";
const limit = fs.readFileSync("/proc/self/limits", "utf8").split("\\n").find((l) => /core file/i.test(l)) ?? "";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.error("LIMIT:" + limit);
process.kill(process.pid, "SIGKILL");
`,
        "utf8",
      );
      await NodeFSP.writeFile(
        signalBin,
        `#!/bin/sh\nexec '${process.execPath}' '${signalScript}' "$@"\n`,
        { mode: 0o755 },
      );
      const beforeEpochSec = Math.floor(Date.now() / 1000) - 1;
      await expect(
        launchBrowser({
          binaryPath: signalBin,
          extensionPath: null,
          display: "headless",
          protocol: "marionette",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/SIGKILL[\s\S]*LIMIT:Max core file size\s+1\s+1\s+bytes/);
      const killedPid = Number(await NodeFSP.readFile(pidFile, "utf8"));
      expect(Number.isInteger(killedPid) && killedPid > 0).toBe(true);

      const coredumpCheck = NodeChildProcess.spawnSync(
        "coredumpctl",
        ["list", "--since", `@${String(beforeEpochSec)}`, "--json=short", "--no-pager"],
        { encoding: "utf8" },
      );
      if (coredumpCheck.error === undefined && coredumpCheck.status === 0) {
        const entries = JSON.parse(coredumpCheck.stdout) as readonly { readonly pid?: number }[];
        expect(entries.some((entry) => entry.pid === killedPid)).toBe(false);
      }
    }

    const probeBin = NodePath.join(scratch, "probe-browser");
    await NodeFSP.writeFile(probeBin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const previousEnv = { PATH: process.env.PATH };
    process.env.PATH = `${fakeBinDir}:${previousEnv.PATH ?? ""}`;
    try {
      await expect(
        launchBrowser({
          binaryPath: probeBin,
          extensionPath: null,
          display: "headless",
          protocol: "marionette",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/code 3/);
      await expect(
        launchBrowser({
          binaryPath: probeBin,
          extensionPath: null,
          display: "headless",
          protocol: "marionette",
          suppressCoreDumps: false,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/code 3/);
    } finally {
      restoreEnv(previousEnv);
    }
    const calls = (await NodeFSP.readFile(prlimitCallsFile, "utf8")).trim().split("\n");
    if (process.platform === "linux") {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`--core=1:1 -- ${probeBin}`);
    }
  });

  it("refuses nested runNamespacedSuites inside an active isolated namespace even if the run env var is cleared", async () => {
    const prev = process.env.HARK_NAMESPACE_RUN;
    try {
      delete process.env.HARK_NAMESPACE_RUN;
      const run = await runNamespacedSuites(NodePath.resolve(import.meta.dirname, ".."), null);
      expect(run).toEqual({
        outcome: "failed",
        detail: "refusing to start a nested namespaced run inside an isolated PID namespace",
      });
    } finally {
      if (prev === undefined) delete process.env.HARK_NAMESPACE_RUN;
      else process.env.HARK_NAMESPACE_RUN = prev;
    }
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readPidFile(file: string): Promise<number> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const text = await NodeFSP.readFile(file, "utf8").catch(() => "");
    if (/^\d+$/u.test(text)) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PID written to ${file}`);
}
