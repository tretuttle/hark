import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BodyLocation, SettledExchange } from "@hark/recording/exchange";
import {
  ARCHIVE_KEY_FILE,
  bodyFilePath,
  LAYOUT,
  packPath,
  parseArchiveKey,
} from "@hark/recording/layout";
import { decodeLine } from "@hark/recording/log";

/** The archive a launch wrote, found the way the extension finds it: the key in the profile, under XDG_DATA_HOME. */
export type ArchiveLocation = {
  readonly key: string;
  readonly appFolder: string;
  readonly root: string;
};

export type ArchiveEntry = {
  /** Relative to the app folder, `/`-separated. */
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: number;
};

export type ArchiveLine = {
  readonly siteDir: string;
  readonly segment: string;
  readonly exchange: SettledExchange;
};

export function locateArchive(dataHome: string, profileDir: string): ArchiveLocation | null {
  const keyFile = NodePath.join(profileDir, ARCHIVE_KEY_FILE);
  if (!NodeFS.existsSync(keyFile)) return null;
  const key = parseArchiveKey(NodeFS.readFileSync(keyFile, "utf8"));
  if (key === null) return null;
  const appFolder = NodePath.join(dataHome, "hark");
  return { key, appFolder, root: NodePath.join(appFolder, key) };
}

export function listArchive(appFolder: string): readonly ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const walk = (directory: string): void => {
    for (const name of NodeFS.readdirSync(directory).sort()) {
      const full = NodePath.join(directory, name);
      const stat = NodeFS.statSync(full);
      const path = NodePath.relative(appFolder, full).split(NodePath.sep).join("/");
      const kind = stat.isDirectory() ? "directory" : "file";
      entries.push({ path, kind, mode: stat.mode & 0o777, size: stat.size });
      if (kind === "directory") walk(full);
    }
  };
  if (NodeFS.existsSync(appFolder)) {
    entries.push({
      path: ".",
      kind: "directory",
      mode: NodeFS.statSync(appFolder).mode & 0o777,
      size: 0,
    });
    walk(appFolder);
  }
  return entries;
}

/** Every whole line of every segment. A torn tail is left out, as the extension's readers leave it out. */
export function readLines(root: string): readonly ArchiveLine[] {
  const sites = NodePath.join(root, LAYOUT.sitesDir);
  if (!NodeFS.existsSync(sites)) return [];
  const lines: ArchiveLine[] = [];
  for (const siteDir of NodeFS.readdirSync(sites).sort()) {
    const logDir = NodePath.join(sites, siteDir, LAYOUT.logDir);
    if (!NodeFS.existsSync(logDir)) continue;
    for (const segment of NodeFS.readdirSync(logDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()) {
      const text = NodeFS.readFileSync(NodePath.join(logDir, segment), "utf8");
      for (const raw of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
        const line = raw === "" ? null : decodeLine(raw);
        if (line !== null) lines.push({ siteDir, segment, exchange: line.exchange });
      }
    }
  }
  return lines;
}

/** The stored wire bytes at a location, or null when the file is gone or shorter than the range. */
export function readStoredBytes(root: string, at: BodyLocation): Buffer | null {
  const file = NodePath.join(
    root,
    ...(at.kind === "pack" ? packPath(at.pack) : bodyFilePath(at.site, at.id)),
  );
  if (!NodeFS.existsSync(file)) return null;
  const bytes = NodeFS.readFileSync(file);
  if (at.kind === "file") return bytes;
  return bytes.length < at.offset + at.length
    ? null
    : bytes.subarray(at.offset, at.offset + at.length);
}
