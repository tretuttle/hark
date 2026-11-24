import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { removeDirectoryBounded, stopOwnedTree, type ProcessIo } from "./owned-process.ts";
import { readProcessIdentity } from "./process-table.ts";
import { decideLease } from "./signal-policy.ts";

const PROFILE_PREFIX = "hark-browser-";

export type LaunchLease = {
  readonly version: 2;
  readonly harnessPid: number;
  readonly harnessStartTime: string;
  readonly spawnedPid: number | null;
  readonly spawnedStartTime: string | null;
  readonly profileDir: string;
  readonly createdAt: string;
  // A failed reap keeps the lease so the next launch retries it.
  readonly reapFailures?: number;
  readonly lastReapFailure?: string;
};

export type ActiveLease = {
  readonly filePath: string;
  readonly setSpawnedProcess: (pid: number, startTime: string) => void;
  readonly remove: () => Promise<void>;
};

export function leaseDirectory(tmpdir: string = NodeOS.tmpdir()): string {
  const uidSuffix = typeof process.getuid === "function" ? `-${String(process.getuid())}` : "";
  return NodePath.join(tmpdir, `hark-leases${uidSuffix}`);
}

async function ensureSecureLeaseDir(dir: string): Promise<void> {
  try {
    const stat = await NodeFSP.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`lease path ${dir} is not a real directory`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`lease directory ${dir} is owned by uid ${String(stat.uid)}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
      await NodeFSP.chmod(dir, 0o700);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await NodeFSP.chmod(dir, 0o700);
  }
}

export async function createLaunchLease(
  profileDir: string,
  tmpdir: string = NodeOS.tmpdir(),
): Promise<ActiveLease> {
  const dir = leaseDirectory(tmpdir);
  await ensureSecureLeaseDir(dir);
  const harnessIdentity = readProcessIdentity(process.pid);
  if (harnessIdentity === undefined) {
    throw new Error(`could not read start time for harness pid ${String(process.pid)}`);
  }
  const filePath = NodePath.join(dir, `${String(process.pid)}-${NodeCrypto.randomUUID()}.json`);
  const record: LaunchLease = {
    version: 2,
    harnessPid: process.pid,
    harnessStartTime: harnessIdentity.startTime,
    spawnedPid: null,
    spawnedStartTime: null,
    profileDir,
    createdAt: new Date().toISOString(),
  };
  await NodeFSP.writeFile(filePath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await NodeFSP.chmod(filePath, 0o600);
  return {
    filePath,
    setSpawnedProcess: (spawnedPid: number, spawnedStartTime: string) => {
      const updated: LaunchLease = { ...record, spawnedPid, spawnedStartTime };
      try {
        NodeFS.writeFileSync(filePath, `${JSON.stringify(updated)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        if (process.platform !== "win32") NodeFS.chmodSync(filePath, 0o600);
      } catch {
        // Ignore if already removed by concurrent dispose.
      }
    },
    remove: async () => {
      await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}

export async function reapOrphanedLaunches(
  io: ProcessIo,
  assertSafeProfile: (directory: string) => void,
  options: {
    readonly tmpdir?: string;
    readonly onWarning?: (message: string) => void;
    readonly removeProfile?: (directory: string) => Promise<void>;
  } = {},
): Promise<number> {
  const dir = leaseDirectory(options.tmpdir);
  const onWarning =
    options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));
  const removeProfile =
    options.removeProfile ?? ((directory: string) => removeDirectoryBounded(io, directory));
  let entries: string[];
  try {
    await ensureExistingSecureLeaseDir(dir);
    entries = await NodeFSP.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }

  let reaped = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = NodePath.join(dir, entry);
    const stat = await NodeFSP.lstat(filePath).catch(() => null);
    if (stat === null || stat.isSymbolicLink() || !stat.isFile()) continue;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;

    const lease = await readLease(filePath);
    if (lease === null) continue;
    const verdict = decideLease(lease, io.table());
    if (verdict.action === "leave") continue;

    assertSafeProfile(lease.profileDir);
    try {
      if (verdict.action === "stop-and-clean") await stopOwnedTree(io, verdict.root);
      if (NodeFS.existsSync(lease.profileDir)) await removeProfile(lease.profileDir);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const attempts = (lease.reapFailures ?? 0) + 1;
      await writeLeaseFile(filePath, {
        ...lease,
        reapFailures: attempts,
        lastReapFailure: failure,
      });
      onWarning(
        `warning: failed to reap orphaned browser for ${lease.profileDir} (attempt ${String(attempts)}); kept its lease to retry on the next launch: ${failure}`,
      );
      continue;
    }
    await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    reaped += 1;
  }
  return reaped;
}

async function writeLeaseFile(filePath: string, lease: LaunchLease): Promise<void> {
  const staging = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(staging, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
  await NodeFSP.rename(staging, filePath);
}

async function ensureExistingSecureLeaseDir(dir: string): Promise<void> {
  const stat = await NodeFSP.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`lease path ${dir} is not a real directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`lease directory ${dir} is owned by uid ${String(stat.uid)}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    await NodeFSP.chmod(dir, 0o700);
  }
}

async function readLease(filePath: string): Promise<LaunchLease | null> {
  const text = await NodeFSP.readFile(filePath, "utf8").catch(() => null);
  return text === null ? null : parseLease(text);
}

const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// A lease this does not fully understand is ignored: never acted on, never deleted.
export function parseLease(text: string): LaunchLease | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = Object(parsed) as Record<string, unknown>;
  const { harnessPid, harnessStartTime, profileDir, spawnedPid, spawnedStartTime } = raw;
  if (raw.version !== 2 || !isPositiveInteger(harnessPid) || !isNonEmptyString(harnessStartTime)) {
    return null;
  }
  if (
    typeof profileDir !== "string" ||
    !NodePath.isAbsolute(profileDir) ||
    !NodePath.basename(profileDir).startsWith(PROFILE_PREFIX)
  ) {
    return null;
  }
  const spawned =
    spawnedPid === null && spawnedStartTime === null
      ? { spawnedPid: null, spawnedStartTime: null }
      : isPositiveInteger(spawnedPid) && spawnedPid > 1 && isNonEmptyString(spawnedStartTime)
        ? { spawnedPid, spawnedStartTime }
        : null;
  if (spawned === null) return null;
  return {
    version: 2,
    harnessPid,
    harnessStartTime,
    ...spawned,
    profileDir,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    ...(isPositiveInteger(raw.reapFailures) ? { reapFailures: raw.reapFailures } : {}),
    ...(typeof raw.lastReapFailure === "string" ? { lastReapFailure: raw.lastReapFailure } : {}),
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return null;
}
