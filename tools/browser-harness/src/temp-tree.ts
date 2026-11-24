import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function assertInsideParent(targetPath: string, expectedParentDir: string): string {
  const resolvedParent = NodePath.resolve(expectedParentDir);
  const resolvedTarget = NodePath.resolve(targetPath);
  const rel = NodePath.relative(resolvedParent, resolvedTarget);
  if (
    rel.length === 0 ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(rel)
  ) {
    throw new Error(
      `refusing to clean up path outside temp root ${resolvedParent}: ${resolvedTarget}`,
    );
  }
  return resolvedTarget;
}

async function assertRealParentMatches(
  resolvedTarget: string,
  expectedParentDir: string,
): Promise<boolean> {
  let targetStat: NodeFS.Stats;
  try {
    targetStat = await NodeFSP.lstat(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(`refusing to walk symlink temp root: ${resolvedTarget}`);
  }
  const realParent = await NodeFSP.realpath(expectedParentDir);
  const realTargetParent = await NodeFSP.realpath(NodePath.dirname(resolvedTarget));
  if (
    realTargetParent !== realParent &&
    !realTargetParent.startsWith(`${realParent}${NodePath.sep}`)
  ) {
    throw new Error(
      `refusing to clean up path outside real temp root ${realParent}: ${realTargetParent}`,
    );
  }
  return true;
}

async function restoreOwnerWriteRecursive(dir: string, ownedRoot: string): Promise<void> {
  if (dir !== ownedRoot && !dir.startsWith(`${ownedRoot}${NodePath.sep}`)) {
    throw new Error(`refusing to chmod outside ${ownedRoot}: ${dir}`);
  }
  let st: NodeFS.Stats;
  try {
    st = await NodeFSP.lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  if (process.platform !== "win32") await NodeFSP.chmod(dir, st.mode | 0o700);
  const entries = await NodeFSP.readdir(dir);
  for (const name of entries) {
    const child = NodePath.join(dir, name);
    let childStat: NodeFS.Stats;
    try {
      childStat = await NodeFSP.lstat(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) {
      await restoreOwnerWriteRecursive(child, ownedRoot);
    } else if (process.platform !== "win32") {
      await NodeFSP.chmod(child, childStat.mode | 0o200);
    }
  }
}

/** Removes an owned `mkdtemp` directory after restoring owner write permissions, refusing symlinks or paths outside `expectedParentDir`. */
export async function removeOwnedTempTree(
  targetPath: string,
  expectedParentDir: string = NodeOS.tmpdir(),
): Promise<void> {
  const resolvedTarget = assertInsideParent(targetPath, expectedParentDir);
  if (!(await assertRealParentMatches(resolvedTarget, expectedParentDir))) return;
  await restoreOwnerWriteRecursive(resolvedTarget, resolvedTarget);
  await NodeFSP.rm(resolvedTarget, { recursive: true, force: true });
}
