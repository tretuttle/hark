import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DEFAULT_USER_SETTINGS } from "@hark/recording/settings";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "../src/browser.ts";
import {
  type FileRead,
  checkNextStart,
  checkRow,
  type RowObservation,
  type RowOutcome,
} from "../src/export-verify.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { checkEntries, formatHarCheck, parseHarEntries } from "../src/har.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { SCENARIOS } from "../src/scenarios.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-failures";
const MIB = 1_048_576;
/** What a row's own file holds, and where a row's own link points. */
const THEIRS = "theirs";
const NOWHERE = "/nonexistent";
/** host.ts reads it only in a harness profile: exports name a `.har.part`, as where no folder can be held. */
const NAMED_PARTS_PREF = "extensions.hark.harness.namedParts";

type Place = { readonly base: string; readonly folder: string; readonly profile: string };
/**
 * What a row acts on mid-export: the part's path (named parts only), the browser's own process, `maskProcFd`, which
 * hides that process's /proc/<pid>/fd inside its own mount namespace, and `fill`, which fills the file system holding a
 * folder there until `bytes` are free (both mask-proc-fd.c).
 */
type During = Place & {
  readonly part: string;
  readonly name: string;
  readonly pid: number;
  readonly session: BrowserSession;
  readonly serverOrigin: string;
  readonly maskProcFd: () => void;
  readonly fill: (folder: string, bytes: number) => void;
};

type Row = {
  readonly cause: string;
  readonly fileName: string;
  /** The folder settings.json names, made in the state this cause needs. */
  readonly folder: (base: string, profile: string) => string;
  /** Optional lower body cap in bytes to test retention eviction concurrently with an export. */
  readonly retentionCapBytes?: number;
  /** The page whose tab is exported; the fixtures page by default. */
  readonly page?: string;
  /** A tmpfs mounted inside the browser's mount namespace, over the folder or one above it. */
  readonly mount?: { readonly options: string; readonly at?: (base: string) => string };
  /** Done just before the export starts. */
  readonly atStart?: (at: During) => void;
  /** Done once the export has written its first MiB. */
  readonly during?: (at: During) => void;
  /**
   * An errno the export's next worker call of `op` answers instead of running, armed through the harness topic before
   * the export starts: for the errnos no file system here produces on demand.
   */
  readonly fault?: {
    readonly op:
      | "hold-folder"
      | "create"
      | "create-part"
      | "write"
      | "link"
      | "rename-part"
      | "discard-part";
    readonly errno: string;
  };
  readonly after?: (at: Place) => void;
  /** What the row itself put in the folder, before or during the export: not the export's, each left as it was. */
  readonly theirs?: readonly string[];
  /** An export held at a pause through the harness topic (armed before the export starts). */
  readonly pause?: Hold & {
    readonly at: "before-bodies" | "before-link" | "before-rename" | "after-link";
  };
  /** The export names a `.har.part` and renames it, as where no unnamed file is made (the harness-only pref). */
  readonly named?: true;
  readonly expect: (fileName: string) => RowOutcome;
};

type Hold = {
  /** Changes the files while the call is held, and returns whether the change is in place, checked before the release. */
  readonly act?: (at: During) => () => boolean;
  /** Async action while paused (e.g., recording extra traffic and invoking retention): returns any problems found. */
  readonly actAsync?: (at: During) => Promise<readonly string[]>;
  /** Cancel while the call is held, and let it go once the export has ended. */
  readonly cancel?: true;
  /** Let the call go only once the export has ended. */
  readonly keep?: true;
  /** How long the export may take to end: from the release, or from the cancel or the hold when it is kept. */
  readonly withinMs: number;
};

const failed = (failure: string) => (): RowOutcome => ({ kind: "write-failed", failure });
/** A failure found after the link named the export's file: no name is proven, so none is given. */
const failedUnconfirmed = (failure: string) => (): RowOutcome => ({
  kind: "write-failed",
  failure,
  unconfirmed: true,
});
const cancelled = (): RowOutcome => ({ kind: "cancelled" });
/** The product's time limit for one export file call (EXPORT_STEP_MS in host.ts). */
const STEP_MS = 15_000;
/** How long an export may take to end once nothing holds it. */
const PROMPTLY_MS = 5_000;
const doneAs =
  (suffix: string) =>
  (fileName: string): RowOutcome => ({ kind: "done", fileName: `${fileName}${suffix}.har` });
/** Done as `<name>.har` on the named route, for the reason the parent keeps. */
const doneNamed =
  (because: string) =>
  (fileName: string): RowOutcome => ({
    kind: "done",
    fileName: `${fileName}.har`,
    route: "named",
    because,
  });
/** How long a row's export may take once let go when it copies the whole file to a named part. */
const COPY_MS = 30_000;
const dir = (path: string): string => {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
};
const locked = (path: string): string => {
  dir(path);
  if (process.platform === "win32") {
    const deny = NodeChildProcess.spawnSync("icacls", [path, "/deny", "*S-1-1-0:(W,WD,AD)"], {
      encoding: "utf8",
    });
    if (deny.status !== 0) throw new Error(`icacls deny ${path}: ${deny.stderr || deny.stdout}`);
  } else {
    NodeFS.chmodSync(path, 0o500);
  }
  return path;
};
const unlock = (path: string): void => {
  if (process.platform === "win32") {
    NodeChildProcess.spawnSync("icacls", [path, "/remove:d", "*S-1-1-0"], { encoding: "utf8" });
  } else {
    NodeFS.chmodSync(path, 0o700);
  }
};
const symlinkFile = (target: string, path: string): void =>
  NodeFS.symlinkSync(target, path, process.platform === "win32" ? "file" : undefined);
const symlinkDir = (target: string, path: string): void =>
  NodeFS.symlinkSync(target, path, process.platform === "win32" ? "junction" : undefined);
const displaceFile = (base: string, path: string): void => {
  const displaced = NodePath.join(
    base,
    `displaced-${NodeCrypto.randomUUID().slice(0, 8)}-${NodePath.basename(path)}`,
  );
  NodeFS.renameSync(path, displaced);
  // Mark delete-pending outside the held folder so NTFS drops it as soon as the open handle closes.
  NodeFS.rmSync(displaced, { force: true });
};

const removeFolder = (base: string, folder: string): void => {
  if (process.platform === "win32" && NodeFS.existsSync(folder)) {
    for (const entry of NodeFS.readdirSync(folder)) {
      displaceFile(base, NodePath.join(folder, entry));
    }
  }
  NodeFS.rmSync(folder, { recursive: true, force: true });
};

const replace = (base: string, part: string, make: (path: string) => void): void => {
  if (process.platform === "win32") {
    // On Windows an open FILE_SHARE_DELETE handle keeps a deleted name delete-pending, so move it aside first.
    displaceFile(base, part);
  } else {
    NodeFS.rmSync(part);
  }
  make(part);
};
const lstat = (path: string): NodeFS.Stats | undefined =>
  NodeFS.lstatSync(path, { throwIfNoEntry: false });
const absent = (path: string) => (): boolean => {
  try {
    return lstat(path) === undefined;
  } catch (error) {
    return process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const isFifo = (path: string) => (): boolean => lstat(path)?.isFIFO() === true;
const moveFolder = (base: string, from: string, to: string): void => {
  if (process.platform !== "win32") {
    NodeFS.renameSync(from, to);
    return;
  }
  // Windows refuses directory rename while a child file handle is open, so stage entries across the rename.
  const staged = dir(NodePath.join(base, `staged-${NodeCrypto.randomUUID().slice(0, 8)}`));
  const entries = NodeFS.readdirSync(from);
  for (const entry of entries) {
    NodeFS.renameSync(NodePath.join(from, entry), NodePath.join(staged, entry));
  }
  NodeFS.renameSync(from, to);
  for (const entry of entries) {
    NodeFS.renameSync(NodePath.join(staged, entry), NodePath.join(to, entry));
  }
  NodeFS.rmSync(staged, { recursive: true, force: true });
};
/** The folder moved to `<base>/<moved>` and a link to the profile put in its place. */
const folderToProfile = ({ base, folder, profile }: Place, moved: string): string => {
  const dest = NodePath.join(base, moved);
  moveFolder(base, folder, dest);
  symlinkDir(profile, folder);
  return dest;
};
/** The folder moved to `<base>/<moved>`, a link to the profile put in its place, then the folder put back. */
const folderSwappedAndBack = (at: Place, moved: string): void => {
  const dest = folderToProfile(at, moved);
  if (process.platform === "win32") NodeFS.rmSync(at.folder, { recursive: true, force: true });
  else NodeFS.unlinkSync(at.folder);
  moveFolder(at.base, dest, at.folder);
};
/** The descriptors of the browser's unnamed files in `folder`: what /proc names `<folder>/#<inode> (deleted)`. */
const unnamedIn = (pid: number, folder: string): readonly string[] =>
  NodeFS.readdirSync(`/proc/${String(pid)}/fd`)
    .map((fd) => `/proc/${String(pid)}/fd/${fd}`)
    .filter((path) => {
      try {
        const target = NodeFS.readlinkSync(path);
        return target.startsWith(`${folder}/#`) && target.endsWith(" (deleted)");
      } catch {
        return false;
      }
    });
const mkfifo = (path: string): void => {
  const made = NodeChildProcess.spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`mkfifo: ${made.stderr}`);
};

/**
 * The same causes where the export names a `.har.part` (Windows, macOS, a Linux file system with no unnamed files),
 * forced by the harness-only pref. Every name in FS_ERROR_KINDS is produced by a row in one of the two tables; `other`
 * is the kind for an error the table does not name, and no row may end as it.
 */
const NAMED_ROWS: readonly Row[] = [
  {
    cause: "read-only mount",
    fileName: "ro-mount",
    folder: (b) => dir(NodePath.join(b, "ro")),
    mount: { options: "ro,size=1m" },
    expect: failed("read-only"),
  },
  {
    cause: "folder to create on a read-only mount",
    fileName: "ro-create",
    folder: (b) => NodePath.join(dir(NodePath.join(b, "ro-parent")), "below"),
    mount: { options: "ro,size=1m", at: (b) => NodePath.join(b, "ro-parent") },
    expect: failed("read-only"),
  },
  {
    cause: "folder is a file",
    fileName: "is-file",
    folder: (b) => {
      NodeFS.writeFileSync(NodePath.join(b, "afile"), "not a folder");
      return NodePath.join(b, "afile");
    },
    expect: failed("not-a-folder"),
  },
  {
    cause: "folder missing at start",
    fileName: "missing",
    folder: (b) => NodePath.join(b, "missing", "below"),
    expect: doneAs(""),
  },
  {
    cause: "folder deleted mid-export",
    fileName: "deleted",
    folder: (b) => dir(NodePath.join(b, "deleted")),
    during: ({ base, folder }) => removeFolder(base, folder),
    expect: failed("folder-missing"),
  },
  {
    cause: "no permission",
    fileName: "no-permission",
    folder: (b) => locked(NodePath.join(b, "no-permission")),
    after: ({ folder }) => unlock(folder),
    expect: failed("access-denied"),
  },
  {
    cause: "folder to create where this user may not write",
    fileName: "no-permission-create",
    folder: (b) => NodePath.join(locked(NodePath.join(b, "locked-parent")), "below"),
    after: ({ base }) => unlock(NodePath.join(base, "locked-parent")),
    expect: failed("access-denied"),
  },
  {
    cause: "part made read-only mid-export (its open handle keeps writing)",
    fileName: "part-read-only",
    folder: (b) => dir(NodePath.join(b, "part-read-only")),
    during: ({ part }) => NodeFS.chmodSync(part, 0o400),
    after: ({ folder }) => {
      if (process.platform === "win32") {
        for (const candidate of ["part-read-only.har", "part-read-only.har.part"]) {
          const target = NodePath.join(folder, candidate);
          if (NodeFS.existsSync(target)) NodeFS.chmodSync(target, 0o600);
        }
      }
    },
    expect: doneAs(""),
  },
  {
    cause: "full disk",
    fileName: "full",
    folder: (b) => dir(NodePath.join(b, "full")),
    mount: { options: "size=8m" },
    expect: failed("disk-full"),
  },
  {
    cause: "part names taken by a stale part and a dangling link",
    fileName: "part-taken",
    folder: (b) => {
      const folder = dir(NodePath.join(b, "part-taken"));
      NodeFS.writeFileSync(NodePath.join(folder, "part-taken.har.part"), THEIRS);
      symlinkFile(NOWHERE, NodePath.join(folder, "part-taken (2).har.part"));
      return folder;
    },
    theirs: ["part-taken.har.part", "part-taken (2).har.part"],
    expect: doneAs(""),
  },
  {
    cause: "name collision at the rename",
    fileName: "collision",
    folder: (b) => dir(NodePath.join(b, "collision")),
    during: ({ folder }) => NodeFS.writeFileSync(NodePath.join(folder, "collision.har"), THEIRS),
    theirs: ["collision.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "folder is a link to the profile",
    fileName: "linked-folder",
    folder: (b, profile) => {
      symlinkDir(profile, NodePath.join(b, "linked"));
      return NodePath.join(b, "linked");
    },
    expect: failed("folder-refused"),
  },
  {
    cause: "part replaced by a link to prefs.js",
    fileName: "part-link",
    folder: (b) => dir(NodePath.join(b, "part-link")),
    during: ({ base, part, profile }) =>
      replace(base, part, (p) => symlinkFile(NodePath.join(profile, "prefs.js"), p)),
    theirs: ["part-link.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a regular file",
    fileName: "part-file",
    folder: (b) => dir(NodePath.join(b, "part-file")),
    during: ({ base, part }) =>
      replace(base, part, (p) => NodeFS.writeFileSync(p, "the attacker's own file")),
    theirs: ["part-file.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a hard link to prefs.js",
    fileName: "part-hard-link",
    folder: (b) => dir(NodePath.join(b, "part-hard-link")),
    during: ({ base, part, profile }) =>
      replace(base, part, (p) => NodeFS.linkSync(NodePath.join(profile, "prefs.js"), p)),
    theirs: ["part-hard-link.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause:
      "part replaced by a regular file with its first 4 KiB (the export's id) and another size",
    fileName: "part-same-head",
    folder: (b) => dir(NodePath.join(b, "part-same-head")),
    during: ({ base, part }) => {
      const head = NodeFS.readFileSync(part).subarray(0, 4096);
      replace(base, part, (p) => NodeFS.writeFileSync(p, head));
    },
    theirs: ["part-same-head.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part's first bytes overwritten in place (same file, same size)",
    fileName: "part-overwritten",
    folder: (b) => dir(NodePath.join(b, "part-overwritten")),
    during: ({ part }) => {
      const fd = NodeFS.openSync(part, "r+");
      try {
        NodeFS.writeSync(fd, Buffer.from(" ".repeat(32)), 0, 32, 0);
      } finally {
        NodeFS.closeSync(fd);
      }
    },
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a folder",
    fileName: "part-folder",
    folder: (b) => dir(NodePath.join(b, "part-folder")),
    during: ({ base, part }) => replace(base, part, (p) => NodeFS.mkdirSync(p)),
    theirs: ["part-folder.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a FIFO (never opened)",
    fileName: "part-fifo",
    folder: (b) => dir(NodePath.join(b, "part-fifo")),
    during: ({ base, part }) => replace(base, part, mkfifo),
    theirs: ["part-fifo.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "a FIFO takes the part's name while the rename waits (put back, never opened)",
    fileName: "held-fifo",
    folder: (b) => dir(NodePath.join(b, "held-fifo")),
    pause: {
      at: "before-link",
      act: ({ base, part }) => {
        replace(base, part, mkfifo);
        return isFifo(part);
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-fifo.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "cancel while the rename waits, a replacement at the part's name",
    fileName: "held-cancel",
    folder: (b) => dir(NodePath.join(b, "held-cancel")),
    pause: {
      at: "before-link",
      act: ({ base, part }) => {
        if (process.platform === "win32") {
          replace(base, part, (p) => NodeFS.writeFileSync(p, THEIRS));
          return () => lstat(part)?.size === THEIRS.length;
        }
        replace(base, part, mkfifo);
        return isFifo(part);
      },
      cancel: true,
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-cancel.har.part"],
    expect: cancelled,
  },
  {
    cause: "the rename still waiting at the step limit (the late rename cleaned up)",
    fileName: "held-late",
    folder: (b) => dir(NodePath.join(b, "held-late")),
    pause: {
      at: "before-link",
      act: () => () => true,
      keep: true,
      withinMs: STEP_MS + PROMPTLY_MS,
    },
    expect: failed("timed-out"),
  },
  {
    cause:
      "a copy of the part, its size and bytes at another inode, takes its name while the rename waits (put back)",
    fileName: "held-copy",
    folder: (b) => dir(NodePath.join(b, "held-copy")),
    pause: {
      at: "before-link",
      act: ({ base, part }) => {
        const own = lstat(part)?.ino;
        NodeFS.copyFileSync(part, NodePath.join(base, "held-copy.tmp"));
        replace(base, part, (p) => NodeFS.renameSync(NodePath.join(base, "held-copy.tmp"), p));
        return () => lstat(part)?.isFile() === true && lstat(part)?.ino !== own;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-copy.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "folder replaced by a link to the profile while the rename waits",
    fileName: "held-folder-link",
    folder: (b) => dir(NodePath.join(b, "held-folder-link")),
    pause: {
      at: "before-link",
      act: (at) => {
        folderToProfile(at, "held-folder-moved");
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-refused"),
  },
  {
    cause:
      "folder replaced by a link to the profile while the rename waits, the part hard-linked there under its name",
    fileName: "held-folder-hard-link",
    folder: (b) => dir(NodePath.join(b, "held-folder-hard-link")),
    pause: {
      at: "before-link",
      act: (at) => {
        const moved = folderToProfile(at, "held-hard-link-moved");
        const name = NodePath.basename(at.part);
        NodeFS.linkSync(NodePath.join(moved, `${name}`), NodePath.join(at.profile, `${name}`));
        return () =>
          lstat(at.folder)?.isSymbolicLink() === true &&
          lstat(NodePath.join(at.profile, `${name}`))?.ino ===
            lstat(NodePath.join(moved, `${name}`))?.ino;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-folder-hard-link.har.part"],
    expect: failed("folder-refused"),
  },
  {
    cause: "folder deleted while the rename waits",
    fileName: "held-folder-gone",
    folder: (b) => dir(NodePath.join(b, "held-folder-gone")),
    pause: {
      at: "before-link",
      act: ({ base, folder }) => {
        removeFolder(base, folder);
        return absent(folder);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-missing"),
  },
  {
    cause: "part deleted while the rename waits",
    fileName: "held-part-gone",
    folder: (b) => dir(NodePath.join(b, "held-part-gone")),
    pause: {
      at: "before-link",
      act: ({ base, part }) => {
        if (process.platform === "win32") displaceFile(base, part);
        else NodeFS.rmSync(part);
        return absent(part);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("file-replaced"),
  },
  {
    cause: "folder replaced by a link to the profile between the folder check and the rename",
    fileName: "swap-before-rename",
    folder: (b) => dir(NodePath.join(b, "swap-before-rename")),
    pause: {
      at: "before-rename",
      act: (at) => {
        folderToProfile(at, "swap-before-rename-moved");
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-refused"),
  },
  {
    cause:
      "part cannot be stat'd relative to the held folder before cancel; handle delete removes it",
    fileName: "discard-locked",
    folder: (b) => dir(NodePath.join(b, "discard-locked")),
    pause: {
      at: "before-link",
      act: ({ folder, part }) => {
        if (process.platform === "win32") {
          for (const [target, perms] of [
            [folder, "*S-1-1-0:(RD,RA,REA,X)"],
            [part, "*S-1-1-0:(R,RA,REA,W,WD,AD,WEA,WA,X)"],
          ] as const) {
            const deny = NodeChildProcess.spawnSync("icacls", [target, "/deny", perms], {
              encoding: "utf8",
            });
            if (deny.status !== 0)
              throw new Error(`icacls deny ${target}: ${deny.stderr || deny.stdout}`);
          }
          return () => {
            try {
              NodeFS.lstatSync(part);
              return false;
            } catch {
              return true;
            }
          };
        }
        NodeFS.chmodSync(part, 0o000);
        return () => true;
      },
      cancel: true,
      withinMs: PROMPTLY_MS,
    },
    after: ({ folder }) => {
      if (process.platform === "win32") {
        const part = NodePath.join(folder, "discard-locked.har.part");
        for (const args of [
          [folder, "/remove:d", "*S-1-1-0"],
          [part, "/remove:d", "*S-1-1-0"],
          [folder, "/remove:d", "*S-1-1-0", "/T"],
        ]) {
          NodeChildProcess.spawnSync("icacls", args, { encoding: "utf8" });
        }
      }
    },
    expect: cancelled,
  },
  {
    cause: "name too long",
    fileName: "n".repeat(300),
    folder: (b) => dir(NodePath.join(b, "long")),
    expect: failed("name-too-long"),
  },
];

/** Puts a file of the row's own at `path`, holding THEIRS so its bytes can be told from the export's. */
const putTheirs = (path: string): void => NodeFS.writeFileSync(path, THEIRS);
/** Writes `text` over the start of every unnamed export file in `folder`, through the browser's own descriptors. */
const overwriteUnnamed = (pid: number, folder: string): void => {
  const found = unnamedIn(pid, folder);
  if (found.length === 0) throw new Error(`no unnamed file of the browser in ${folder}`);
  for (const path of found) {
    const fd = NodeFS.openSync(path, "r+");
    try {
      NodeFS.writeSync(fd, Buffer.from(" ".repeat(32)), 0, 32, 0);
    } finally {
      NodeFS.closeSync(fd);
    }
  }
};

/**
 * Linux: the export holds its folder open and its file is unnamed until one link names it, which never replaces. Each
 * row makes its cause happen for real; the racing rows act while the export waits at a pause, before or after the
 * link. Nothing the row put anywhere may change, and no export byte may land outside the folder the export holds.
 */
const UNNAMED_ROWS: readonly Row[] = [
  {
    cause: "read-only mount",
    fileName: "ro-mount",
    folder: (b) => dir(NodePath.join(b, "ro")),
    mount: { options: "ro,size=1m" },
    expect: failed("read-only"),
  },
  {
    cause: "folder to create on a read-only mount",
    fileName: "ro-create",
    folder: (b) => NodePath.join(dir(NodePath.join(b, "ro-parent")), "below"),
    mount: { options: "ro,size=1m", at: (b) => NodePath.join(b, "ro-parent") },
    expect: failed("read-only"),
  },
  {
    cause: "folder is a file",
    fileName: "is-file",
    folder: (b) => {
      NodeFS.writeFileSync(NodePath.join(b, "afile"), "not a folder");
      return NodePath.join(b, "afile");
    },
    expect: failed("not-a-folder"),
  },
  {
    cause: "folder missing at start",
    fileName: "missing",
    folder: (b) => NodePath.join(b, "missing", "below"),
    expect: doneAs(""),
  },
  {
    cause: "folder deleted mid-export",
    fileName: "deleted",
    folder: (b) => dir(NodePath.join(b, "deleted")),
    during: ({ base, folder }) => removeFolder(base, folder),
    expect: failed("folder-missing"),
  },
  {
    cause: "no permission",
    fileName: "no-permission",
    folder: (b) => locked(NodePath.join(b, "no-permission")),
    after: ({ folder }) => unlock(folder),
    expect: failed("access-denied"),
  },
  {
    cause: "folder to create where this user may not write",
    fileName: "no-permission-create",
    folder: (b) => NodePath.join(locked(NodePath.join(b, "locked-parent")), "below"),
    after: ({ base }) => unlock(NodePath.join(base, "locked-parent")),
    expect: failed("access-denied"),
  },
  {
    cause: "full disk",
    fileName: "full",
    folder: (b) => dir(NodePath.join(b, "full")),
    mount: { options: "size=8m" },
    expect: failed("disk-full"),
  },
  {
    cause: "a stale part and a dangling link at the part names (never used)",
    fileName: "part-taken",
    folder: (b) => {
      const folder = dir(NodePath.join(b, "part-taken"));
      NodeFS.writeFileSync(NodePath.join(folder, "part-taken.har.part"), THEIRS);
      symlinkFile(NOWHERE, NodePath.join(folder, "part-taken (2).har.part"));
      return folder;
    },
    theirs: ["part-taken.har.part", "part-taken (2).har.part"],
    expect: doneAs(""),
  },
  {
    cause: "name collision mid-export",
    fileName: "collision",
    folder: (b) => dir(NodePath.join(b, "collision")),
    during: ({ name }) => putTheirs(name),
    theirs: ["collision.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "folder is a link to the profile",
    fileName: "linked-folder",
    folder: (b, profile) => {
      symlinkDir(profile, NodePath.join(b, "linked"));
      return NodePath.join(b, "linked");
    },
    expect: failed("folder-refused"),
  },
  {
    cause: "the unnamed file's first bytes overwritten through the browser's own descriptor",
    fileName: "overwritten",
    folder: (b) => dir(NodePath.join(b, "overwritten")),
    during: ({ pid, folder }) => overwriteUnnamed(pid, folder),
    expect: failed("file-replaced"),
  },
  {
    cause: "a foreign file written at the finished name while the link waits",
    fileName: "raced-finish",
    folder: (b) => dir(NodePath.join(b, "raced-finish")),
    pause: {
      at: "before-link",
      act: ({ name }) => {
        putTheirs(name);
        return () => lstat(name)?.isFile() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-finish.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a link to prefs.js put at the finished name while the link waits",
    fileName: "raced-link",
    folder: (b) => dir(NodePath.join(b, "raced-link")),
    pause: {
      at: "before-link",
      act: ({ name, profile }) => {
        symlinkFile(NodePath.join(profile, "prefs.js"), name);
        return () => lstat(name)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-link.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a FIFO put at the finished name while the link waits (never opened)",
    fileName: "raced-fifo",
    folder: (b) => dir(NodePath.join(b, "raced-fifo")),
    pause: {
      at: "before-link",
      act: ({ name }) => {
        mkfifo(name);
        return isFifo(name);
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-fifo.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a file put at the part's name while the link waits (never touched)",
    fileName: "raced-part",
    folder: (b) => dir(NodePath.join(b, "raced-part")),
    pause: {
      at: "before-link",
      act: ({ part }) => {
        putTheirs(part);
        return () => lstat(part)?.isFile() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-part.har.part"],
    expect: doneAs(""),
  },
  {
    cause: "folder replaced by a link to the profile while the link waits",
    fileName: "link-folder",
    folder: (b) => dir(NodePath.join(b, "link-folder")),
    pause: {
      at: "before-link",
      act: (at) => {
        folderToProfile(at, "link-folder-moved");
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failedUnconfirmed("folder-refused"),
  },
  {
    cause:
      "folder replaced by a link to the profile while the link waits, files put there at the part and finished names",
    fileName: "theirs-folder",
    folder: (b) => dir(NodePath.join(b, "theirs-folder")),
    pause: {
      at: "before-link",
      act: (at) => {
        folderToProfile(at, "theirs-folder-moved");
        putTheirs(NodePath.join(at.profile, "theirs-folder.har.part"));
        putTheirs(NodePath.join(at.profile, "theirs-folder.har"));
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["theirs-folder.har.part", "theirs-folder.har"],
    expect: failedUnconfirmed("folder-refused"),
  },
  {
    cause: "folder replaced by a link to the profile and put back while the link waits",
    fileName: "link-restore",
    folder: (b) => dir(NodePath.join(b, "link-restore")),
    pause: {
      at: "before-link",
      act: (at) => {
        folderSwappedAndBack(at, "link-restore-moved");
        return () => lstat(at.folder)?.isDirectory() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: doneAs(""),
  },
  {
    cause: "folder deleted while the link waits",
    fileName: "gone-folder",
    folder: (b) => dir(NodePath.join(b, "gone-folder")),
    pause: {
      at: "before-link",
      act: ({ folder }) => {
        NodeFS.rmSync(folder, { recursive: true, force: true });
        return absent(folder);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-missing"),
  },
  {
    cause: "cancel while the link waits",
    fileName: "cancel-link",
    folder: (b) => dir(NodePath.join(b, "cancel-link")),
    pause: { at: "before-link", act: () => () => true, cancel: true, withinMs: PROMPTLY_MS },
    expect: cancelled,
  },
  {
    cause: "the link still waiting at the step limit",
    fileName: "late-link",
    folder: (b) => dir(NodePath.join(b, "late-link")),
    pause: {
      at: "before-link",
      act: () => () => true,
      keep: true,
      withinMs: STEP_MS + PROMPTLY_MS,
    },
    expect: failed("timed-out"),
  },
  {
    cause: "the finished name removed after the link",
    fileName: "removed-finish",
    folder: (b) => dir(NodePath.join(b, "removed-finish")),
    pause: {
      at: "after-link",
      act: ({ base, name }) => {
        if (process.platform === "win32") displaceFile(base, name);
        else NodeFS.rmSync(name);
        return absent(name);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failedUnconfirmed("file-replaced"),
  },
  {
    cause: "a foreign file renamed over the finished name after the link",
    fileName: "replaced-finish",
    folder: (b) => dir(NodePath.join(b, "replaced-finish")),
    pause: {
      at: "after-link",
      act: ({ base, name }) => {
        putTheirs(NodePath.join(base, "replaced-finish.tmp"));
        replace(base, name, (p) =>
          NodeFS.renameSync(NodePath.join(base, "replaced-finish.tmp"), p),
        );
        return () => lstat(name)?.size === THEIRS.length;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["replaced-finish.har"],
    expect: failedUnconfirmed("file-replaced"),
  },
  {
    cause:
      "folder replaced by a link to the profile after the link, a file put there at the finished name",
    fileName: "after-folder",
    folder: (b) => dir(NodePath.join(b, "after-folder")),
    pause: {
      at: "after-link",
      act: (at) => {
        folderToProfile(at, "after-folder-moved");
        putTheirs(NodePath.join(at.profile, "after-folder.har"));
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["after-folder.har"],
    expect: failedUnconfirmed("folder-refused"),
  },
  {
    cause:
      "/proc/<pid>/fd masked before the export starts: no file can be linked, so a part is named",
    fileName: "proc-at-start",
    folder: (b) => dir(NodePath.join(b, "proc-at-start")),
    atStart: ({ maskProcFd }) => maskProcFd(),
    expect: doneNamed("fd-link-unavailable"),
  },
  {
    cause: "/proc/<pid>/fd masked while the link waits: the whole file is copied to a named part",
    fileName: "proc-before-link",
    folder: (b) => dir(NodePath.join(b, "proc-before-link")),
    pause: {
      at: "before-link",
      act: ({ maskProcFd }) => {
        maskProcFd();
        return () => true;
      },
      withinMs: COPY_MS,
    },
    expect: doneNamed("fd-link-lost"),
  },
  {
    cause:
      "/proc/<pid>/fd masked while the link waits and 8 KiB left free: the copy's first write meets a full disk",
    fileName: "copy-full",
    page: "/r/json/0",
    mount: { options: "size=4m", at: (b) => NodePath.join(b, "copy-full") },
    folder: (b) => NodePath.join(dir(NodePath.join(b, "copy-full")), "out"),
    pause: {
      at: "before-link",
      act: ({ base, maskProcFd, fill }) => {
        maskProcFd();
        fill(NodePath.join(base, "copy-full"), 8192);
        return () => true;
      },
      withinMs: COPY_MS,
    },
    expect: failed("disk-full"),
  },
  {
    cause: "/proc/<pid>/fd masked after the link: the folder is proved through its path instead",
    fileName: "proc-after-link",
    folder: (b) => dir(NodePath.join(b, "proc-after-link")),
    pause: {
      at: "after-link",
      act: ({ maskProcFd }) => {
        maskProcFd();
        return () => true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: (fileName) => ({ kind: "done", fileName: `${fileName}.har`, route: "link" }),
  },
  {
    cause: "O_TMPFILE refused (simulated: the create answers EOPNOTSUPP), so a part is named",
    fileName: "no-tmpfile",
    folder: (b) => dir(NodePath.join(b, "no-tmpfile")),
    fault: { op: "create", errno: "EOPNOTSUPP" },
    expect: doneNamed("unnamed-refused"),
  },
  {
    cause: "retention eviction during a long export leaves pinned packs byte-exact",
    fileName: "retention-evict",
    retentionCapBytes: 200 * MIB,
    folder: (b) => dir(NodePath.join(b, "retention-evict")),
    pause: {
      at: "before-bodies",
      actAsync: async ({ session, serverOrigin }) => {
        const port = new URL(serverOrigin).port;
        const otherTab = await session.openTab(`http://localhost:${port}/retention/page`);
        await session.evaluate(
          otherTab,
          `Promise.all([
            ...[0, 1, 2].map((i) =>
              fetch("/fixtures/binary?evict=" + i).then((r) => r.arrayBuffer()),
            ),
            ...[0, 1].map((i) =>
              fetch("/retention/blob?bytes=2000000&tag=evict-" + i).then((r) => r.arrayBuffer()),
            ),
          ]).then(() => "done")`,
        );
        await callHook(session, { kind: "flush" });
        const steps = (await callHook(session, { kind: "retain" })) as {
          readonly kind: string;
        }[];
        const problems: string[] = [];
        if (!steps.some((s) => s.kind === "blocked-by-pin")) {
          problems.push(`retention did not hit pinned export packs: ${JSON.stringify(steps)}`);
        }
        const status = (await callHook(session, { kind: "status" })) as {
          readonly overCapWhileExporting?: boolean;
        };
        if (status.overCapWhileExporting !== true) {
          problems.push(
            `expected overCapWhileExporting=true while pinned export held archive over cap, got ${JSON.stringify(status.overCapWhileExporting)}`,
          );
        }
        return problems;
      },
      withinMs: 60_000,
    },
    expect: doneAs(""),
  },
  ...(["EXDEV", "EMLINK", "EPERM"] as const).map((errno): Row => ({
    cause: `the link refused with ${errno} (simulated): the whole file is copied to a named part`,
    fileName: `link-${errno.toLowerCase()}`,
    folder: (b) => dir(NodePath.join(b, `link-${errno.toLowerCase()}`)),
    fault: { op: "link", errno },
    // Held where the link waits only so the unnamed file can be read before the copy; nothing changes there.
    pause: { at: "before-link", act: () => () => true, withinMs: COPY_MS },
    expect: doneNamed("link-refused"),
  })),
  ...(
    [
      ["link", "ENOSPC", "disk-full"],
      ["link", "EDQUOT", "disk-full"],
      ["link", "ENOENT", "folder-missing"],
      ["link", "ENOTDIR", "not-a-folder"],
      ["link", "EIO", "io-error"],
      ["write", "EIO", "io-error"],
      ["write", "EDQUOT", "disk-full"],
      ["hold-folder", "ELOOP", "folder-refused"],
    ] as const
  ).map(([op, errno, kind]): Row => ({
    cause: `the ${op} answered ${errno} (simulated)`,
    fileName: `${op}-${errno.toLowerCase()}`,
    folder: (b) => dir(NodePath.join(b, `${op}-${errno.toLowerCase()}`)),
    fault: { op, errno },
    expect: failed(kind),
  })),
  {
    cause: "a name of 255 bytes with .har (no part is named, so its suffix does not count)",
    fileName: "n".repeat(251),
    folder: (b) => dir(NodePath.join(b, "longest")),
    expect: doneAs(""),
  },
  {
    cause: "name too long",
    fileName: "n".repeat(300),
    folder: (b) => dir(NodePath.join(b, "long")),
    expect: failed("name-too-long"),
  },
];

/** A row's outcome; a done row that names no route was written on its table's own: the link, or the named route. */
const expected = (row: Row): RowOutcome => {
  const outcome = row.expect(row.fileName);
  if (outcome.kind !== "done" || outcome.route !== undefined) return outcome;
  if (process.platform !== "linux") return { ...outcome, route: "named", because: "platform" };
  return row.named === true
    ? { ...outcome, route: "named", because: "harness-pref" }
    : { ...outcome, route: "link" };
};

const LINUX_ONLY_UNNAMED = new Set([
  "overwritten",
  "proc-at-start",
  "proc-before-link",
  "copy-full",
  "proc-after-link",
  "no-tmpfile",
]);
// Windows NTFS has no FIFOs.
const POSIX_ONLY_NAMES = new Set(["raced-fifo", "part-fifo", "held-fifo"]);
const NON_LINUX_NAMED_EXTRAS = new Set([
  "part-read-only",
  "part-link",
  "part-file",
  "part-hard-link",
  "part-same-head",
  "part-overwritten",
  "part-folder",
  "part-fifo",
  "held-fifo",
  "held-cancel",
  "held-late",
  "held-copy",
  "held-folder-link",
  "held-folder-hard-link",
  "held-folder-gone",
  "held-part-gone",
  "swap-before-rename",
  "discard-locked",
]);

const NAMED_FAULT_ROWS: readonly Row[] = [
  {
    cause: "atomic rename refused with ENOTSUP (simulated) under a taken name",
    fileName: "no-atomic-rename",
    folder: (b) => {
      const folder = dir(NodePath.join(b, "no-atomic-rename"));
      putTheirs(NodePath.join(folder, "no-atomic-rename.har"));
      return folder;
    },
    theirs: ["no-atomic-rename.har"],
    fault: { op: "rename-part", errno: "ENOTSUP" },
    expect: failed("no-atomic-rename"),
  },
  ...(
    [
      ["rename-part", "ENOSPC", "disk-full"],
      ["rename-part", "EDQUOT", "disk-full"],
      ["rename-part", "ENOENT", "folder-missing"],
      ["rename-part", "ENOTDIR", "not-a-folder"],
      ["rename-part", "EIO", "io-error"],
      ["write", "EIO", "io-error"],
      ["write", "EDQUOT", "disk-full"],
      ["hold-folder", "ELOOP", "folder-refused"],
    ] as const
  ).map(([op, errno, kind]): Row => ({
    cause: `the ${op} answered ${errno} (simulated)`,
    fileName: `${op}-${errno.toLowerCase()}`,
    folder: (b) => dir(NodePath.join(b, `${op}-${errno.toLowerCase()}`)),
    fault: { op, errno },
    expect: failed(kind),
  })),
];

const adaptForNamedRoute = (row: Row): Row => {
  if (row.fileName === "n".repeat(251)) return { ...row, expect: failed("name-too-long") };
  if (row.fileName === "raced-part" && row.pause !== undefined) {
    return {
      ...row,
      pause: {
        ...row.pause,
        act: ({ base, part }) => {
          replace(base, part, putTheirs);
          return () => lstat(part)?.size === THEIRS.length;
        },
      },
      expect: failed("file-replaced"),
    };
  }
  const outcome = row.expect(row.fileName);
  if (outcome.kind === "write-failed" && outcome.unconfirmed === true) {
    return { ...row, expect: failed(outcome.failure) };
  }
  return row;
};

const platformRows = (platform: NodeJS.Platform): readonly Row[] => {
  if (platform === "linux") {
    return [
      ...UNNAMED_ROWS,
      ...NAMED_ROWS.map((row) => ({
        ...row,
        named: true as const,
        cause: `named part: ${row.cause}`,
      })),
    ];
  }
  const isAllowed = (row: Row): boolean =>
    row.mount === undefined &&
    !LINUX_ONLY_UNNAMED.has(row.fileName) &&
    row.fault === undefined &&
    (platform !== "win32" || !POSIX_ONLY_NAMES.has(row.fileName));
  return [
    ...UNNAMED_ROWS.filter(isAllowed).map((row) => ({
      ...adaptForNamedRoute(row),
      named: true as const,
    })),
    ...NAMED_ROWS.filter((row) => NON_LINUX_NAMED_EXTRAS.has(row.fileName) && isAllowed(row)).map(
      (row) => ({ ...row, named: true as const, cause: `named part: ${row.cause}` }),
    ),
    ...NAMED_FAULT_ROWS.map((row) => ({ ...row, named: true as const })),
  ];
};

const ROWS: readonly Row[] = platformRows(process.platform);

/**
 * The browser in its own user and mount namespace: root there to mount the row's tmpfs, then this user again in a
 * nested namespace, so file permissions apply to it as they do to the user. Every step execs, so the process the
 * harness started and stops is the browser itself.
 */
const launcher = (binary: string, mountAt: string | null, options: string | null): string => {
  const mountStep =
    mountAt === null || options === null
      ? ":"
      : `mount -t tmpfs -o ${options} hark-row ${JSON.stringify(mountAt)}`;
  return `#!/bin/sh
exec unshare --user --map-root-user --mount -- /bin/sh -c '${mountStep} && exec unshare --user --map-user=${String(process.getuid?.())} --map-group=${String(process.getgid?.())} -- "$@"' sh ${JSON.stringify(binary)} "$@"
`;
};

/** Names in each folder as the browser sees it, inside its mount namespace; null for a path that is not a folder. */
const LIST = `const done = arguments[arguments.length - 1];
(async () => {
  const listed = {};
  for (const path of arguments[0]) {
    try { listed[path] = (await IOUtils.getChildren(path)).map((child) => PathUtils.filename(child)); }
    catch { listed[path] = null; }
  }
  done(listed);
})();`;

/** The browser keeps writing its profile while a row is checked: a file gone between the listing and the read is absent. */
const contents = (path: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return null;
  }
};

const sha256 = (path: string): string => {
  const bytes = contents(path);
  return bytes === null ? "absent" : NodeCrypto.createHash("sha256").update(bytes).digest("hex");
};

/** Every export file opens with this, the document's start and its random id. */
const EXPORT_OPENING = '{"log":{"_harExportId"';

const digest = (bytes: Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The unnamed export file `pid` holds open, read through /proc/<pid>/fd from outside its namespace: its length and
 * SHA-256. The kernel names it `<folder>/#<inode> (deleted)`, and it opens as an export does.
 */
const unnamedFile = (pid: number): RowObservation["source"] => {
  const fds = `/proc/${String(pid)}/fd`;
  for (const fd of NodeFS.readdirSync(fds)) {
    const target = (() => {
      try {
        return NodeFS.readlinkSync(`${fds}/${fd}`);
      } catch {
        return "";
      }
    })();
    if (!target.includes("/#") || !target.endsWith(" (deleted)")) continue;
    const bytes = contents(`${fds}/${fd}`);
    if (
      bytes === null ||
      !bytes.subarray(0, EXPORT_OPENING.length).equals(Buffer.from(EXPORT_OPENING))
    )
      continue;
    return { bytes: bytes.length, sha256: digest(bytes) };
  }
  return null;
};

/**
 * A finished export's file, read back: its length, its SHA-256, and every fixture body in it against its pinned
 * SHA-256. A body may be absent only where the file says so (`_harExport.bodyMissing`: the browser aborts the video's
 * load). Only the fixtures page has pinned bodies, so a row that exports another page cannot end done.
 */
const readBack = (path: string, page: string | undefined): FileRead | null => {
  const bytes = contents(path);
  if (bytes === null) return null;
  const fixtures = (): readonly string[] => {
    if (page !== undefined)
      return [`exported ${page}, which has no pinned bodies to check it against`];
    try {
      const har = JSON.parse(bytes.toString("utf8")) as {
        log?: {
          entries?: { request?: { url?: string }; _harExport?: { bodyMissing?: unknown } }[];
        };
      };
      const saidMissing = new Set(
        (har.log?.entries ?? [])
          .filter((entry) => entry._harExport?.bodyMissing !== undefined)
          .map((entry) => entry.request?.url),
      );
      const checked = checkEntries(parseHarEntries(har), SCENARIOS.fixtures);
      const problems = checked.problems.filter(
        (problem) => problem.kind !== "empty" || !saidMissing.has(problem.url),
      );
      return problems.length === 0 ? [] : [formatHarCheck({ ...checked, ok: false, problems })];
    } catch (error) {
      return [`is not a HAR: ${String(error)}`];
    }
  };
  return { bytes: bytes.length, sha256: digest(bytes), fixtures: fixtures() };
};

/**
 * Whether a file holds any of an export's bytes. The browser rewrites prefs.js itself during a long row, so prefs.js is
 * checked by this rather than by its hash: no export byte may reach it.
 */
const exportBytesIn = (path: string): string => {
  const bytes = contents(path);
  if (bytes === null) return "absent";
  return bytes.includes(EXPORT_OPENING) ? "holds export bytes" : "no export bytes";
};

/** What is at a path, never following a link there: a file by its hash, a link by its target. */
const fingerprint = (path: string): string => {
  let stat: NodeFS.Stats | undefined;
  try {
    stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      return "absent";
    throw error;
  }
  if (stat === undefined) return "absent";
  if (stat.isSymbolicLink()) return `link to ${NodeFS.readlinkSync(path)}`;
  if (stat.isFIFO()) return "fifo";
  if (stat.isDirectory()) return "folder";
  return stat.isFile() ? `file ${sha256(path)}` : "other";
};

const dirInode = (path: string): bigint | null => {
  try {
    const stat = NodeFS.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat?.isDirectory() === true && stat.ino !== 0n ? stat.ino : null;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      return null;
    throw error;
  }
};

/**
 * Files under `root` (the row's whole tree: the profile, the archive and every folder around the export's) that are
 * new or changed since `before`, outside the folder the export holds, and whether each holds an export's bytes. The
 * browser rewrites its own files during a row; none of them may take an export byte. The journal holds the head only
 * as escaped JSON text, so it is checked by its lines, not here.
 */
const changedOutside = (
  root: string,
  before: ReadonlyMap<string, string>,
  theirs: ReadonlySet<string>,
  folderInode: bigint | null,
): RowObservation["outside"] => {
  const changed: { path: string; exportBytes: boolean }[] = [];
  for (const [path, print] of filesUnder(root, [])) {
    if (before.get(path) === print || theirs.has(path)) continue;
    if (folderInode !== null && dirInode(NodePath.dirname(path)) === folderInode) continue;
    changed.push({ path, exportBytes: exportBytesIn(path) === "holds export bytes" });
  }
  return changed;
};

/** Every non-folder entry under `root`, by path, except in the folders the browser itself owns. */
const filesUnder = (root: string, skip: readonly string[]): Map<string, string> => {
  const found = new Map<string, string>();
  const walk = (folder: string): void => {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = NodePath.join(folder, entry.name);
      if (skip.includes(path)) continue;
      if (entry.isDirectory()) walk(path);
      else found.set(path, fingerprint(path));
    }
  };
  walk(root);
  return found;
};

const namespacesRefused = (): string | null => {
  const probe = NodeChildProcess.spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "unshare",
      "--user",
      `--map-user=${String(process.getuid?.())}`,
      "true",
    ],
    { encoding: "utf8" },
  );
  return probe.status === 0 ? null : (probe.stderr || String(probe.error)).trim();
};

const MASK_SOURCE = NodePath.join(import.meta.dirname, "..", "native", "mask-proc-fd.c");

/** mask-proc-fd.c, built into `folder`, run on `pid`'s mount namespace with `args`; what it printed. */
const inMountNamespace =
  (folder: string, pid: number) =>
  (...args: readonly string[]): string => {
    const program = NodePath.join(folder, "mask-proc-fd");
    if (!NodeFS.existsSync(program)) {
      const built = NodeChildProcess.spawnSync("cc", ["-O2", "-o", program, MASK_SOURCE], {
        encoding: "utf8",
      });
      if (built.status !== 0) throw new Error(`no C compiler for mask-proc-fd.c: ${built.stderr}`);
    }
    const ran = NodeChildProcess.spawnSync(program, [String(pid), ...args], { encoding: "utf8" });
    if (ran.status !== 0)
      throw new Error(`mask-proc-fd ${[pid, ...args].join(" ")}: ${ran.stderr}`);
    return ran.stdout;
  };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wakes any reader waiting on a FIFO under `root` by opening it for writing, without waiting, and closing it. */
const wakeFifoReaders = (root: string): void => {
  for (const [path, print] of filesUnder(root, []))
    if (print === "fifo")
      try {
        NodeFS.closeSync(
          NodeFS.openSync(path, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK),
        );
      } catch {
        // No reader is waiting.
      }
};

async function runRow(
  context: CheckContext,
  row: Row,
  extensionPath: string,
): Promise<{
  readonly problems: readonly string[];
  readonly state: unknown;
  readonly timing: RowObservation["timing"];
}> {
  await using server = await startFixtureServer();
  await using workspace = recordingWorkspace("export-failures");
  const base = NodePath.dirname(workspace.downloads);
  const profile = workspace.profileDir;
  const folder = row.folder(base, profile);
  const seededUser =
    row.retentionCapBytes === undefined
      ? DEFAULT_USER_SETTINGS
      : {
          ...DEFAULT_USER_SETTINGS,
          retention: { ...DEFAULT_USER_SETTINGS.retention, maxBodyBytes: row.retentionCapBytes },
        };
  workspace.seed(NodeCrypto.randomBytes(16).toString("hex"), {
    user: seededUser,
    exportFolder: { kind: "chosen", path: folder, label: "Export" },
  });
  const linux = process.platform === "linux";
  const binary = linux ? NodePath.join(base, "browser-in-namespace.sh") : context.binaryPath;
  if (linux) {
    const mountAt = row.mount === undefined ? null : (row.mount.at?.(base) ?? folder);
    NodeFS.writeFileSync(
      binary,
      launcher(context.binaryPath, mountAt, row.mount?.options ?? null),
      { mode: 0o700 },
    );
  }
  const theirs = (row.theirs ?? []).map((name) => NodePath.join(folder, name));
  /** The real paths of the row's own files once it acted: a file it put outside the folder still counts as its own. */
  const theirsReal = new Set<string>();
  const keepTheirs = (): void => {
    for (const path of theirs) {
      if (!kept.has(path)) kept.set(path, fingerprint(path));
      if (lstat(path) === undefined) continue;
      // The folder's real path, so a file put through a link is found where it is; a dangling link stays as named.
      theirsReal.add(
        NodePath.join(NodeFS.realpathSync(NodePath.dirname(path)), NodePath.basename(path)),
      );
    }
  };
  /** Every file there before the export, then what the row put in place: none may change, now or at the next start. */
  const kept = filesUnder(base, [profile, workspace.dataHome]);
  const theirsBefore = theirs.filter((path) => fingerprint(path) !== "absent");
  const prefs = NodePath.join(profile, "prefs.js");
  const place: Place = { base, folder, profile };
  let state: unknown;
  let timing: RowObservation["timing"] = null;
  let journal = "";
  const holdProblems: string[] = [];
  let observation: RowObservation;
  {
    await using session = await workspace.launch({
      binaryPath: binary,
      extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
      ...(linux && row.named === true
        ? { extraPrefs: [{ name: NAMED_PARTS_PREF, value: true }] }
        : {}),
    });
    const page = await openExtensionPage(session, extensionPath);
    const tab = await session.openTab(`${server.origin}${row.page ?? FIXTURES_PAGE_PATH}`);
    await session.evaluate(
      tab,
      row.page === undefined ? "window.__harnessReady" : "document.readyState",
    );
    const tabId = await newestPageTab(page);
    const before = exportBytesIn(prefs);
    const outsideBefore = filesUnder(base, []);
    /** The folder the export holds, by inode, wherever a row moves it; read again at the end if the export made it. */
    let folderInode = dirInode(folder);
    if (row.pause !== undefined)
      await callHook(session, { kind: "export-pause", point: row.pause.at, action: "arm" });
    if (row.fault !== undefined) await callHook(session, { kind: "export-fault", ...row.fault });
    const name = NodePath.join(folder, `${row.fileName}.har`);
    const helper = linux ? inMountNamespace(base, session.browserPid) : null;
    /** Gecko aborts when it next makes shared memory without /proc/self/fd, so a mask lasts only for the export. */
    let masked = false;
    const unmask = (): void => {
      if (masked && helper !== null) helper("unmask");
      masked = false;
    };
    const at: During = {
      ...place,
      part: `${name}.part`,
      name,
      pid: session.browserPid,
      session,
      serverOrigin: server.origin,
      maskProcFd: () => {
        if (helper === null) throw new Error("maskProcFd requires a Linux mount namespace");
        helper();
        masked = true;
      },
      fill: (filled, bytes) => {
        if (helper === null) throw new Error("fill requires a Linux mount namespace");
        const free = Number(helper("fill", filled, String(bytes)));
        if (free > bytes) throw new Error(`${filled} still has ${String(free)} bytes free`);
      },
    };
    if (row.retentionCapBytes !== undefined) await callHook(session, { kind: "seal" });
    row.atStart?.(at);
    let route: unknown = null;
    let source: RowObservation["source"] = null;
    try {
      const job = await startExport(page, {
        selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName: row.fileName,
      });
      if (row.during !== undefined) {
        const writing = await waitForJob(
          page,
          job.id,
          (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
        );
        if (writing.state.kind === "writing") row.during(at);
      }
      if (row.pause !== undefined) {
        const paused = await pauseAndAct(
          session,
          page,
          job.id,
          row.pause,
          at,
          keepTheirs,
          linux && row.named !== true,
        );
        timing = paused.timing;
        state = paused.state;
        source = paused.source;
        holdProblems.push(...paused.problems);
      }
      keepTheirs();
      // A held row's export that never ended is checked as it is, so the next rows still run.
      if (state === undefined || ended({ state } as Parameters<typeof ended>[0]))
        state = (await waitForJob(page, job.id, ended)).state;
      if (row.retentionCapBytes !== undefined) {
        await callHook(session, { kind: "flush" });
        await callHook(session, { kind: "retain" });
        const after = (await callHook(session, { kind: "status" })) as {
          readonly usage: { readonly bodyBytes: number };
          readonly overCapWhileExporting?: boolean;
        };
        if (after.usage.bodyBytes > row.retentionCapBytes) {
          holdProblems.push(
            `after unpin, bodyBytes ${String(after.usage.bodyBytes)} > cap ${String(row.retentionCapBytes)}`,
          );
        }
        if (after.overCapWhileExporting !== false) {
          holdProblems.push(
            `after unpin, overCapWhileExporting=${String(after.overCapWhileExporting)}`,
          );
        }
      }
      unmask();
      journal = await journalSettled(NodePath.join(workspace.root(), "exports.jsonl"));
      route = await callHook(session, { kind: "export-route", id: job.id });
    } finally {
      if (row.pause !== undefined)
        await callHook(session, { kind: "export-pause", point: row.pause.at, action: "release" });
      unmask();
      if (process.platform !== "win32") wakeFifoReaders(base);
      row.after?.(place);
    }
    folderInode ??= dirInode(folder);
    const served = JSON.stringify({
      state,
      list: await value(page, "browser.hark.listExports()"),
      popup: await value(page, `browser.hark.getPopup({ tabId: ${String(tabId)} })`),
    });
    const listed = (await session.evaluateChrome(LIST, [[folder, profile]])) as Record<
      string,
      readonly string[] | null
    >;
    const named = (path: string): readonly string[] =>
      (listed[path] ?? []).filter(
        (name) => name.startsWith(row.fileName) && !(row.theirs ?? []).includes(name),
      );
    observation = {
      expect: expected(row),
      state,
      served,
      route,
      paths: [profile, folder, workspace.dataHome, base],
      files: [...named(folder), ...named(profile)],
      untouched: [
        { path: "prefs.js", before, after: exportBytesIn(prefs) },
        ...[...kept].map(([path, was]) => ({ path, before: was, after: fingerprint(path) })),
      ],
      journal,
      theirs: theirsBefore,
      timing,
      outside: changedOutside(base, outsideBefore, theirsReal, folderInode),
      written:
        (state as { kind?: string }).kind === "done"
          ? readBack(
              NodePath.join(folder, String((state as { fileName?: unknown }).fileName)),
              row.page,
            )
          : null,
      source,
    };
  }
  // The next start, which reads the journal and deletes what it can prove an unfinished export left.
  {
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: null,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    await waitForActiveExtensionUrl(
      session,
      await readExtensionId(extensionPath),
      await readExtensionPopupPath(extensionPath),
    );
    await callHook(session, { kind: "recovery" });
  }
  const afterNextStart = checkNextStart(
    [...kept].map(([path, was]) => ({ path, before: was, after: fingerprint(path) })),
  );
  return {
    problems: [...holdProblems, ...checkRow(observation), ...afterNextStart],
    state,
    timing,
  };
}

/**
 * Waits for the export at its pause, armed through the harness topic before the export started, acts, and lets it go
 * once the row's change is in place: or cancels, or keeps it held until the export has ended. Times the end.
 */
async function pauseAndAct(
  session: Parameters<typeof callHook>[0],
  page: Parameters<typeof waitForJob>[0],
  id: string,
  pause: NonNullable<Row["pause"]>,
  at: During,
  acted: () => void,
  hasUnnamed: boolean,
): Promise<{
  readonly timing: RowObservation["timing"];
  readonly problems: readonly string[];
  readonly state: unknown;
  readonly source: RowObservation["source"];
}> {
  const hook = (action: "reached" | "release") =>
    callHook(session, { kind: "export-pause", point: pause.at, action });
  const reachBy = Date.now() + 120_000;
  while ((await hook("reached")) !== true) {
    const job = await waitForJob(page, id, () => true);
    if (ended(job) || Date.now() > reachBy)
      return {
        timing: null,
        problems: [`the ${pause.at} pause was never reached: ${JSON.stringify(job.state)}`],
        state: job.state,
        source: null,
      };
    await sleep(20);
  }
  // What a copy to a named part must equal, read before the row acts and before the link can name the file.
  const source = hasUnnamed && pause.at === "before-link" ? unnamedFile(at.pid) : null;
  const problems: string[] = [];
  if (pause.act !== undefined) {
    const inPlace = pause.act(at);
    const observeBy = Date.now() + 10_000;
    while (!inPlace() && Date.now() < observeBy) await sleep(20);
    if (!inPlace()) problems.push("the row's change was not in place before the release");
  }
  if (pause.actAsync !== undefined) problems.push(...(await pause.actAsync(at)));
  if (hasUnnamed && pause.at === "before-link" && source === null)
    problems.push("the unnamed file could not be read while the link waited");
  acted();
  if (pause.cancel === true)
    await value(page, `browser.hark.cancelExport(${JSON.stringify(id)}).then(String)`);
  else if (pause.keep !== true) await hook("release");
  const from = Date.now();
  const endBy = from + pause.withinMs + 30_000;
  let job = await waitForJob(page, id, () => true);
  while (!ended(job) && Date.now() < endBy) {
    await sleep(50);
    job = await waitForJob(page, id, () => true);
  }
  const timing = { tookMs: Date.now() - from, withinMs: pause.withinMs };
  await hook("release");
  // What a held export does once let go after its job ended: it must name nothing.
  await sleep(500);
  return { timing, problems, state: job.state, source };
}

/**
 * The journal once every started line is ended, or as it is after 10 s: cleanup may finish after the job does. Read
 * before any FIFO reader is woken, so a read stuck on one shows as an open line.
 */
async function journalSettled(journal: string): Promise<string> {
  const by = Date.now() + 10_000;
  for (;;) {
    const text = NodeFS.existsSync(journal) ? NodeFS.readFileSync(journal, "utf8") : "";
    const started = (text.match(/"started"/g) ?? []).length;
    const endedLines = (text.match(/"ended"/g) ?? []).length;
    if (started <= endedLines || Date.now() > by) return text;
    await sleep(100);
  }
}

const errorText = (error: unknown, depth = 0): string => {
  if (depth > 4) return "...";
  if (typeof SuppressedError === "function" && error instanceof SuppressedError) {
    return `${errorText(error.error, depth + 1)}; suppressed during disposal: ${errorText(error.suppressed, depth + 1)}`;
  }
  return error instanceof Error ? error.message : String(error);
};

async function runRowForPlatform(
  context: CheckContext,
  row: Row,
  extensionPath: string,
): Promise<{
  readonly problems: readonly string[];
  readonly state: unknown;
  readonly timing: RowObservation["timing"];
}> {
  try {
    return await runRow(context, row, extensionPath);
  } catch (error) {
    throw new Error(`${row.cause}: ${errorText(error)}`, { cause: error });
  }
}

/**
 * Every cause in ROWS, made to happen for real on the browser, ends as its row says: its named kind and no file, or
 * done under the name it says. No path reaches the page, prefs.js holds no export byte and the row's own files are as
 * it left them. A failure `{ kind: "other", detail }` that carries a path must fail the same check.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "each export failure cause, caused for real, ends as its named kind with no path served",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const finish = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return finish(["needs --extension"], "");
    if (process.platform === "linux") {
      const refused = namespacesRefused();
      if (refused !== null) {
        if (process.env.CI)
          return finish([`a user and mount namespace is needed and was refused: ${refused}`], "");
        return finish([], `skipped: this machine refused a user and mount namespace (${refused})`);
      }
    }
    const problems: string[] = [];
    const seen: string[] = [];
    for (const row of ROWS) {
      const outcome = await runRowForPlatform(context, row, context.extensionPath);
      problems.push(...outcome.problems.map((p) => `${row.cause}: ${p}`));
      const state = outcome.state as { kind?: string; fileName?: string; failure?: unknown };
      const took =
        outcome.timing === null
          ? ""
          : ` (ended ${String(outcome.timing.tookMs)} ms after the row let it go)`;
      seen.push(
        `${row.cause}: ${state.kind === "done" ? `done as ${String(state.fileName)}` : JSON.stringify(state.failure ?? state)}${took}`,
      );
    }
    const leaky = checkRow({
      expect: { kind: "write-failed", failure: "access-denied" },
      state: { kind: "write-failed", failure: { kind: "other", detail: "/w/out/x.har.part" } },
      served: '{"detail":"/w/out/x.har.part"}',
      route: null,
      paths: ["/w/out"],
      files: [],
      untouched: [],
      journal: '{"started":"/w/out/theirs.har.part","head":"{"}\n',
      theirs: ["/w/out/theirs.har.part"],
      timing: { tookMs: 15_020, withinMs: PROMPTLY_MS },
      outside: [{ path: "/w/profile/x.har", exportBytes: true }],
      written: null,
      source: null,
    });
    if (leaky.length < 7)
      problems.push(
        `a detail with a path and an open journal line reported only as ${JSON.stringify(leaky)}`,
      );
    return finish(
      problems,
      `${seen.join("; ")}; a detail with a path and a journal line naming the row's file are reported`,
      seen,
    );
  },
};

/** @discovered-check */
export default check;
