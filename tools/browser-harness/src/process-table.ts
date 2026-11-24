import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type { HarnessSelf, ProcessIdentity, ProcessTable } from "./signal-policy.ts";

export type ProcessSnapshot = {
  readonly parentPid: number;
  readonly workingSetBytes: number;
  readonly cpuTimeMs: number;
};

export type ProcessPlatformName = "win32" | "linux" | "darwin";

type ProcessPlatform = {
  // POSIX children become process group leaders, so one signal to the group reaches every
  // descendant that did not leave the group, even after the leader died.
  readonly groupSignals: boolean;
  readonly table: () => ProcessTable;
  readonly identity: (pid: number) => ProcessIdentity | undefined;
  readonly snapshot: (pid: number) => ProcessSnapshot;
  readonly parseSnapshot: (text: string, pid: number) => ProcessSnapshot;
};

const WIN32_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToUniversalTime().Ticks)`t$($_.CommandLine)" }';

export const PROCESS_PLATFORMS: Readonly<Record<ProcessPlatformName, ProcessPlatform>> = {
  win32: {
    groupSignals: false,
    // Win32_Process creation ticks stand in for a start time (not observed on Linux).
    table: () =>
      parseWin32ProcessTable(
        run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32_TABLE_SCRIPT]),
      ),
    identity: (pid) => PROCESS_PLATFORMS.win32.table().get(pid),
    snapshot: (pid) =>
      PROCESS_PLATFORMS.win32.parseSnapshot(
        run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($null -eq $p) { exit 3 }; "$($p.ParentProcessId) $($p.WorkingSetSize) $($p.UserModeTime + $p.KernelModeTime)"`,
        ]),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const [parent, workingSet, hundredNanoseconds] = threeNumbers(text, pid);
      return {
        parentPid: parent,
        workingSetBytes: workingSet,
        cpuTimeMs: hundredNanoseconds / 1e4,
      };
    },
  },
  linux: {
    groupSignals: true,
    table: readLinuxTable,
    identity: readLinuxIdentity,
    snapshot: (pid) =>
      PROCESS_PLATFORMS.linux.parseSnapshot(
        NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const fields = parseLinuxStatFields(text, pid);
      const field = (number: number): number => {
        const value = Number(fields[number - 3]);
        if (!Number.isFinite(value))
          throw new Error(`/proc/${String(pid)}/stat field ${String(number)}`);
        return value;
      };
      const { pageBytes, ticksPerSecond } = linuxUnits();
      return {
        parentPid: field(4),
        workingSetBytes: field(24) * pageBytes,
        cpuTimeMs: ((field(14) + field(15)) * 1000) / ticksPerSecond,
      };
    },
  },
  darwin: {
    groupSignals: true,
    // `ps -o lstart=` has one-second resolution (not observed on Linux).
    table: () =>
      parseDarwinProcessTable(
        run("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,state=,lstart=,args="]),
      ),
    identity: (pid) => PROCESS_PLATFORMS.darwin.table().get(pid),
    snapshot: (pid) =>
      PROCESS_PLATFORMS.darwin.parseSnapshot(
        run("ps", ["-o", "ppid=,rss=,time=", "-p", String(pid)]),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const [parent, rssKilobytes, time] = text.trim().split(/\s+/u);
      return {
        parentPid: positive(Number(parent), "parent", pid),
        workingSetBytes: positive(Number(rssKilobytes), "rss", pid) * 1024,
        cpuTimeMs: cpuTimeText(time ?? "", pid),
      };
    },
  },
};

export function currentPlatformName(platform: string = process.platform): ProcessPlatformName {
  if (platform === "win32" || platform === "linux" || platform === "darwin") return platform;
  throw new Error(`unsupported platform ${platform}; supported: win32, linux, darwin`);
}

export function hostPlatform(): ProcessPlatform {
  return PROCESS_PLATFORMS[currentPlatformName()];
}

export function readHostProcessTable(): ProcessTable {
  return hostPlatform().table();
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  assertReadablePid(pid);
  return hostPlatform().identity(pid);
}

// Start time alone, readable even before a fresh child has exec'd and shows a command line.
export function readStartTime(pid: number): string | undefined {
  assertReadablePid(pid);
  if (currentPlatformName() !== "linux") return hostPlatform().identity(pid)?.startTime;
  try {
    const fields = parseLinuxStatFields(
      NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
      pid,
    );
    const startTime = fields[19] ?? "";
    return fields[0] === "Z" || fields[0] === "X" || !/^\d+$/u.test(startTime)
      ? undefined
      : startTime;
  } catch {
    return undefined;
  }
}

export function readProcessSnapshot(pid: number): ProcessSnapshot {
  assertReadablePid(pid);
  return hostPlatform().snapshot(pid);
}

export function readHarnessSelf(): HarnessSelf {
  const platform = currentPlatformName();
  return {
    pid: process.pid,
    parentPid: process.ppid,
    pgrp: platform === "win32" ? null : (hostPlatform().identity(process.pid)?.pgrp ?? null),
  };
}

export function parseWin32ProcessTable(text: string): ProcessTable {
  const table = new Map<number, ProcessIdentity>();
  for (const line of text.split(/\r?\n/u)) {
    const [pidText, parentText, ticks, ...rest] = line.split("\t");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || ticks === undefined || !/^\d+$/u.test(ticks)) {
      continue;
    }
    const commandLine = rest.join("\t").trim();
    if (commandLine.length === 0) continue;
    table.set(pid, {
      pid,
      parentPid: Number.isInteger(Number(parentText)) ? Number(parentText) : null,
      pgrp: null,
      startTime: ticks,
      args: commandLine.split(/\s+/u).filter(Boolean),
      commandLine,
    });
  }
  return table;
}

// `ps -o pid=,ppid=,pgid=,state=,lstart=,args=`: zombies (`Z`), exiting (`E`), and kernel-masked
// `(proc)` entries have lost their argv and are no longer running; lstart is five tokens.
export function parseDarwinProcessTable(text: string): ProcessTable {
  const table = new Map<number, ProcessIdentity>();
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/u);
    const [pidText, parentText, pgidText, state = "", ...rest] = tokens;
    const lstart = rest.slice(0, 5);
    const args = rest.slice(5);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || lstart.length < 5 || args.length === 0) continue;
    if (state.startsWith("Z") || state.includes("E")) continue;
    if (args.length === 1 && /^\([^)]+\)$/u.test(args[0] ?? "")) continue;
    table.set(pid, {
      pid,
      parentPid: Number.isInteger(Number(parentText)) ? Number(parentText) : null,
      pgrp: Number.isInteger(Number(pgidText)) ? Number(pgidText) : null,
      startTime: lstart.join(" "),
      args,
      commandLine: args.join(" "),
    });
  }
  return table;
}

// `/proc/<pid>/stat` and `/proc/<pid>/cmdline` text to an identity. Zombies, dead and exiting
// processes (empty command line) are not running and return undefined.
export function parseLinuxProcess(
  pid: number,
  statText: string,
  cmdlineText: string,
): ProcessIdentity | undefined {
  const fields = parseLinuxStatFields(statText, pid);
  const state = fields[0] ?? "";
  if (state === "Z" || state === "X") return undefined;
  const number = (text: string | undefined): number | null =>
    text !== undefined && /^\d+$/u.test(text) ? Number(text) : null;
  // After the command name: index 1 is field 4 (ppid), 2 is field 5 (pgrp), 19 is field 22 (starttime).
  const startTime = fields[19] ?? "";
  if (!/^\d+$/u.test(startTime)) return undefined;
  const args = cmdlineText.split("\0").filter((part) => part.length > 0);
  if (args.length === 0) return undefined;
  return {
    pid,
    parentPid: number(fields[1]),
    pgrp: number(fields[2]),
    startTime,
    args,
    commandLine: args.join(" "),
  };
}

function readLinuxIdentity(pid: number): ProcessIdentity | undefined {
  try {
    return parseLinuxProcess(
      pid,
      NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
      NodeFS.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8"),
    );
  } catch {
    return undefined;
  }
}

function readLinuxTable(): ProcessTable {
  const table = new Map<number, ProcessIdentity>();
  for (const entry of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const identity = readLinuxIdentity(Number(entry));
    if (identity !== undefined) table.set(identity.pid, identity);
  }
  return table;
}

function parseLinuxStatFields(text: string, pid: number): readonly string[] {
  // The command name is wrapped in parentheses and may itself hold spaces and ")".
  const close = text.lastIndexOf(")");
  if (close === -1) throw new Error(`/proc/${String(pid)}/stat has no command name`);
  return text
    .slice(close + 2)
    .trim()
    .split(" ");
}

let cachedLinuxUnits: { pageBytes: number; ticksPerSecond: number } | null = null;

function linuxUnits(): { pageBytes: number; ticksPerSecond: number } {
  cachedLinuxUnits ??= {
    pageBytes: positive(Number(run("getconf", ["PAGESIZE"]).trim()), "PAGESIZE", process.pid),
    ticksPerSecond: positive(Number(run("getconf", ["CLK_TCK"]).trim()), "CLK_TCK", process.pid),
  };
  return cachedLinuxUnits;
}

function cpuTimeText(text: string, pid: number): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text);
  if (match === null) throw new Error(`cpu time for ${String(pid)} was ${text}`);
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total * 1000;
}

function threeNumbers(text: string, pid: number): readonly [number, number, number] {
  const [first, second, third, ...rest] = text.trim().split(/\s+/u).map(Number);
  const values = [first, second, third].filter(
    (value): value is number => value !== undefined && Number.isFinite(value) && value >= 0,
  );
  const [a, b, c] = values;
  if (a === undefined || b === undefined || c === undefined || rest.length > 0) {
    throw new Error(`process snapshot for ${String(pid)} was ${text.trim()}`);
  }
  return [a, b, c];
}

function positive(value: number, label: string, pid: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} for ${String(pid)} was ${String(value)}`);
  }
  return value;
}

function run(command: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`${command} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function assertReadablePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`);
}
