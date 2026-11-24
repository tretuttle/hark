import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { removeOwnedTempTree } from "./temp-tree.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("owned temp tree cleanup", () => {
  it("removes a read-only tree left by a killed run without following symlinks outside its root", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-temp-base-"));
    cleanupDirs.push(base);
    const owned = await NodeFSP.mkdtemp(NodePath.join(base, "hark-guard-mutation-"));
    const readonlyParent = await NodeFSP.mkdtemp(NodePath.join(owned, "hark-readonly-"));
    const locked = NodePath.join(readonlyParent, "locked");
    await NodeFSP.mkdir(locked);
    const lockedFile = NodePath.join(locked, "file");
    await NodeFSP.writeFile(lockedFile, "data");
    if (process.platform !== "win32") {
      await NodeFSP.chmod(lockedFile, 0o444);
      await NodeFSP.chmod(locked, 0o555);
      await NodeFSP.chmod(readonlyParent, 0o555);
    }

    const canaryDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-canary-"));
    cleanupDirs.push(canaryDir);
    const canaryFile = NodePath.join(canaryDir, "keep.txt");
    await NodeFSP.writeFile(canaryFile, "keep");
    if (process.platform !== "win32") await NodeFSP.chmod(canaryDir, 0o555);
    await NodeFSP.symlink(canaryDir, NodePath.join(owned, "outside-link"));

    await removeOwnedTempTree(owned, base);
    expect(NodeFS.existsSync(owned)).toBe(false);
    expect(NodeFS.readFileSync(canaryFile, "utf8")).toBe("keep");
    if (process.platform !== "win32") {
      expect(NodeFS.statSync(canaryDir).mode & 0o777).toBe(0o555);
      await NodeFSP.chmod(canaryDir, 0o755);
    }
  });

  it("refuses to touch paths equal to or outside its temp parent", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-temp-guard-"));
    cleanupDirs.push(base);
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-outside-"));
    cleanupDirs.push(outside);
    const marker = NodePath.join(outside, "marker.txt");
    await NodeFSP.writeFile(marker, "intact");

    await expect(removeOwnedTempTree(base, base)).rejects.toThrow(/outside temp root/);
    await expect(removeOwnedTempTree("/", base)).rejects.toThrow(/outside temp root/);
    await expect(removeOwnedTempTree(outside, base)).rejects.toThrow(/outside temp root/);

    const link = NodePath.join(base, "escape-link");
    await NodeFSP.symlink(outside, link);
    await expect(removeOwnedTempTree(link, base)).rejects.toThrow(/symlink/);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("intact");
  });
});
