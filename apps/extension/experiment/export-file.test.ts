import * as NodeCrypto from "node:crypto";
import { WriteRefused } from "@hark/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  carriesHead,
  createPartSink,
  ERRNO_KINDS,
  ExportCancelled,
  exportFiles,
  journalLine,
  LINK_FALLBACK,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportLimits,
  type ExportPause,
  type ExportPlatform,
  type FileIdentity,
  type HeldFolder,
  type JournaledPart,
  type JournalEntry,
  type Part,
  type PartJournal,
  type PathState,
} from "./export-file.ts";

/**
 * An inode. A handle and every hard link hold the same object, so a write through a handle follows the inode.
 */
type FileNode = { readonly kind: "file"; bytes: number[] };
type Node =
  | { readonly kind: "folder"; readonly size?: number }
  | { readonly kind: "fifo"; readonly size: number | FileNode }
  | FileNode
  | { readonly kind: "link"; readonly target: string };

/** A call that waits at its start until the test lets it go. */
interface Hold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

type OpKey = "makeFolder" | "createPart" | "write" | "rename" | "discard";

/** A small POSIX file system: paths name inodes, links resolve, an open handle keeps writing its own inode. */
class MemoryFs {
  readonly nodes = new Map<string, Node>([["/", { kind: "folder" }]]);
  /** Errors to throw from one platform call, as the browser threw them for one cause. */
  readonly fail = new Map<OpKey, unknown>();
  readonly holds = new Map<OpKey, { gate: Promise<void>; reached: () => void }>();
  /** Every rename that moved something, as `from -> to`. */
  readonly moves: string[] = [];
  /** Set when anything reads a FIFO by its path. */
  fifoRead = false;

  parent = (path: string): string | null =>
    path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  filename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  join = (folder: string, name: string): string => `${folder === "/" ? "" : folder}/${name}`;

  /** Resolves links in every component but the last. */
  private resolveParent(path: string): string {
    const up = this.parent(path);
    return up === null ? path : this.join(this.realPath(up), this.filename(path));
  }

  /** Throws for a path that does not exist, as Gecko's `normalize` does. */
  realPath = (path: string, depth = 0): string => {
    if (depth > 20)
      throw Object.assign(new Error("loop"), { name: "NS_ERROR_FILE_UNRESOLVABLE_SYMLINK" });
    const resolved = this.resolveParent(path);
    const node = this.nodes.get(resolved);
    if (node === undefined && depth === 0 && path !== "/")
      throw Object.assign(new Error("missing"), { name: "NS_ERROR_FILE_NOT_FOUND" });
    return node?.kind === "link" ? this.realPath(node.target, depth + 1) : resolved;
  };

  folder(path: string, size?: number): void {
    this.nodes.set(path, size === undefined ? { kind: "folder" } : { kind: "folder", size });
  }
  file(path: string, text: string): FileNode {
    const node: FileNode = { kind: "file", bytes: [...Buffer.from(text)] };
    this.nodes.set(path, node);
    return node;
  }
  link(path: string, target: string): void {
    this.nodes.set(path, { kind: "link", target });
  }
  fifo(path: string, size: number | FileNode = 0): void {
    this.nodes.set(path, { kind: "fifo", size });
  }
  /** Every inode's number, given the first time it is asked for. */
  private readonly inodes = new WeakMap<object, number>();
  private lastInode = 0;
  ino(node: object): string {
    if (!this.inodes.has(node)) {
      this.lastInode += 1;
      this.inodes.set(node, this.lastInode);
    }
    return String(this.inodes.get(node));
  }
  /** Where `node` is named now, or null when nothing names it. */
  pathOf(node: Node): string | null {
    for (const [path, at] of this.nodes) if (at === node) return path;
    return null;
  }
  /** Every unlink or rename of a name the platform was asked for. An unnamed export makes none. */
  readonly removes: string[] = [];
  /** Answers `link` and `createUnnamed` refuse with, as the kernel gave them. */
  readonly failUnnamed = new Map<"createUnnamed" | "link", unknown>();
  /** Set to make every folder's file system unable to hold an unnamed file. */
  noUnnamedFiles = false;
  /** Set to hide /proc/self/fd, so no unnamed file can be linked. */
  noFdLink = false;
  /** The last unnamed file made, as another process reaches it through /proc/<pid>/fd. */
  lastUnnamed: FileNode | null = null;
  /**
   * Bytes the disk still takes; null for room enough. A write past them stores what fits, a short write, and then
   * throws the worker's ENOSPC.
   */
  room: number | null = null;
  /** Set to make readText hand back its last byte changed, as a copy that is not byte-exact would. */
  copyCorrupts = false;

  /** Appends `text` to `node` as far as the room allows, then throws `full` if not all of it fit. */
  private store(node: FileNode, text: string, full: unknown): void {
    const bytes = [...Buffer.from(text)];
    const taken = this.room === null ? bytes : bytes.slice(0, this.room);
    node.bytes.push(...taken);
    if (this.room === null) return;
    this.room -= taken.length;
    if (taken.length < bytes.length) throw full;
  }

  private identityOfNode(node: Node): FileIdentity {
    return {
      dev: "m",
      ino: this.ino(node),
      kind: node.kind === "fifo" ? "other" : node.kind,
    };
  }

  /** Holds the folder at `path` open, as file-worker.ts does with a directory descriptor/handle. */
  holdFolder = async (path: string): Promise<HeldFolder> => {
    const folder = this.nodes.get(path);
    if (folder?.kind !== "folder") throw new DOMException("x", "NotFoundError");
    const where = (): string | null => this.pathOf(folder);
    return {
      where: async () => where(),
      identityOf: async (name) => {
        const at = where();
        const node = at === null ? undefined : this.nodes.get(this.join(at, name));
        return node === undefined ? null : this.identityOfNode(node);
      },
      createUnnamed: async () => {
        if (this.failUnnamed.has("createUnnamed")) throw this.failUnnamed.get("createUnnamed");
        if (this.noUnnamedFiles) return { refused: "unnamed-refused", errno: "EOPNOTSUPP" };
        if (this.noFdLink) return { refused: "fd-link-unavailable", errno: "fd-link-unavailable" };
        const node: FileNode = { kind: "file", bytes: [] };
        this.lastUnnamed = node;
        return {
          file: {
            identity: this.identityOfNode(node),
            write: async (text) => this.store(node, text, { name: "ENOSPC" }),
            size: async () => node.bytes.length,
            read: async (offset, bytes) =>
              Uint8Array.from(node.bytes.slice(offset, offset + bytes)),
            readText: async (offset, bytes) => {
              const taken = node.bytes.slice(offset, offset + bytes);
              if (this.copyCorrupts && taken.length > 0) taken[taken.length - 1] = 0x20;
              return { text: Buffer.from(taken).toString(), bytes: taken.length };
            },
            link: async (name) => {
              if (this.failUnnamed.has("link")) throw this.failUnnamed.get("link");
              const at = where();
              if (at === null) throw { name: "ENOENT" };
              if (this.nodes.has(this.join(at, name))) return false;
              this.nodes.set(this.join(at, name), node);
              return true;
            },
            close: () => undefined,
          },
        };
      },
      createNamedPart: async (name) => {
        this.check("createPart");
        const at = where();
        if (at === null) throw { name: "ENOENT" };
        const full = this.join(at, name);
        if (this.nodes.has(full)) return null;
        const node = this.file(full, "");
        return {
          identity: this.identityOfNode(node),
          write: async (text) => {
            this.check("write");
            this.store(node, text, { name: "ENOSPC" });
          },
          size: async () => node.bytes.length,
          read: async (offset, bytes) => Uint8Array.from(node.bytes.slice(offset, offset + bytes)),
          rename: async (fromName, toName) => {
            await this.wait("rename");
            this.check("rename");
            const currentFolder = where();
            if (currentFolder === null) throw { name: "ENOENT" };
            const target = this.join(currentFolder, toName);
            if (this.nodes.has(target)) return false;
            const source = this.join(currentFolder, fromName);
            const current = this.nodes.get(source);
            if (current === undefined) throw { name: "ENOENT" };
            this.nodes.delete(source);
            this.nodes.set(target, current);
            this.moves.push(`${source} -> ${target}`);
            this.removes.push(`rename ${source}`);
            return true;
          },
          discard: async (atName) => {
            this.check("discard");
            const currentFolder = where();
            if (currentFolder === null) return;
            const target = this.join(currentFolder, atName);
            const there = this.nodes.get(target);
            if (there === node) {
              this.removes.push(`remove ${target}`);
              this.nodes.delete(target);
            }
          },
          close: () => undefined,
        };
      },
      close: () => undefined,
    };
  };

  text(path: string): string {
    const node = this.nodes.get(this.realPath(path));
    return node?.kind === "file" ? Buffer.from(node.bytes).toString() : "";
  }
  /** Removes a folder and everything in it. */
  removeTree(path: string): void {
    for (const key of this.nodes.keys())
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }
  /** The next `call` waits at its start until released. */
  hold(call: OpKey): Hold {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atStart = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.set(call, { gate, reached });
    return { reached: atStart, release };
  }

  private async wait(call: OpKey): Promise<void> {
    const held = this.holds.get(call);
    if (held === undefined) return;
    this.holds.delete(call);
    held.reached();
    await held.gate;
  }
  private check(call: OpKey): void {
    if (this.fail.has(call)) throw this.fail.get(call);
  }

  platform(options: { readonly preferNamed?: "platform" | "harness-pref" } = {}): ExportPlatform {
    return {
      holdFolder: this.holdFolder,
      ...(options.preferNamed === undefined ? {} : { preferNamed: options.preferNamed }),
      state: (path): PathState => {
        const node = this.nodes.get(this.resolveParent(path));
        if (node === undefined) return { kind: "missing" };
        if (node.kind === "file") return { kind: "file", size: node.bytes.length };
        if (node.kind === "link") return { kind: "link", size: node.target.length };
        if (node.kind === "fifo")
          return {
            kind: "other",
            size: typeof node.size === "number" ? node.size : node.size.bytes.length,
          };
        return { kind: "folder", size: node.size ?? 4096 };
      },
      realPath: (path) => this.realPath(path),
      parent: this.parent,
      join: this.join,
      filename: this.filename,
      makeFolder: async (folder) => {
        this.check("makeFolder");
        const real = this.realPath(folder);
        const node = this.nodes.get(real);
        if (node !== undefined && node.kind !== "folder")
          throw new DOMException("x", "InvalidAccessError");
        const up = this.parent(real);
        if (up !== null && !this.nodes.has(up)) await this.platform().makeFolder(up);
        if (node === undefined) this.folder(real);
      },
      readHead: async (path, bytes) => {
        const node = this.nodes.get(this.realPath(path));
        if (node?.kind === "fifo") {
          this.fifoRead = true;
          return new Uint8Array(0);
        }
        if (node?.kind !== "file") throw new DOMException("x", "NotReadableError");
        return node.bytes.length < bytes
          ? new Uint8Array(0)
          : Uint8Array.from(node.bytes.slice(0, bytes));
      },
      freeBytes: () => this.room ?? 1 << 30,
      sha256: () => {
        const hash = NodeCrypto.createHash("sha256");
        return { update: (bytes) => void hash.update(bytes), hex: () => hash.digest("hex") };
      },
    };
  }
}

/** Step timers the test fires by hand, and the job's cancel. */
class Limits implements ExportLimits {
  readonly stepMs = 15_000;
  readonly signal = { aborted: false };
  private readonly armed = new Set<() => void>();
  timer = (): { readonly elapsed: Promise<void>; readonly cancel: () => void } => {
    let fire = (): void => undefined;
    const elapsed = new Promise<void>((resolve) => {
      fire = resolve;
    });
    this.armed.add(fire);
    return { elapsed, cancel: () => this.armed.delete(fire) };
  };
  /** Every step timer still armed runs out. */
  elapse(): void {
    for (const fire of this.armed) fire();
    this.armed.clear();
  }
  private readonly held = new Map<ExportPause, { reached: () => void; gate: Promise<void> }>();
  pause = async (point: ExportPause): Promise<void> => {
    const held = this.held.get(point);
    if (held === undefined) return;
    this.held.delete(point);
    held.reached();
    await held.gate;
  };
  /** The export waits at `point` until released, as the harness topic holds it. */
  hold(point: ExportPause): Hold {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atPoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(point, { reached, gate });
    return { reached: atPoint, release };
  }
}

const PROFILE = "/home/u/profile";
const DOWNLOADS = "/home/u/Downloads";
/** The first write of an export, as runExport writes it: the document's opening with a random file id. */
const OPENING = '{"log":{"_harExportId":"9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e","entries":[';
const REST = "]}}";
const DOCUMENT = `${OPENING}${REST}`;

/** Every line the export journaled, parsed. */
class MemoryJournal implements PartJournal {
  readonly lines: JournalEntry[] = [];
  started = async (path: string, head: string): Promise<void> => {
    this.lines.push({ started: path, head });
  };
  ended = async (path: string): Promise<void> => {
    this.lines.push({ ended: path });
  };
  discardFailed = async (path: string, reason: string): Promise<void> => {
    this.lines.push({ discardFailed: path, reason });
  };
  /** What the next start would act on. */
  unended(): readonly JournaledPart[] {
    return unfinishedExports(this.lines.map(journalLine).join(""));
  }
}

const setup = (
  wrap: (platform: ExportPlatform, fs: MemoryFs) => ExportPlatform = (p) => p,
  options: { readonly preferNamed?: "platform" | "harness-pref" } = { preferNamed: "platform" },
) => {
  const fs = new MemoryFs();
  for (const folder of ["/home", "/home/u", PROFILE, DOWNLOADS]) fs.folder(folder);
  fs.file(`${PROFILE}/prefs.js`, "user_pref(1);");
  const limits = new Limits();
  const files = exportFiles(
    wrap(fs.platform(options), fs),
    (real) => !real.startsWith(PROFILE),
    limits,
  );
  return { fs, files, limits, journal: new MemoryJournal() };
};
type Setup = ReturnType<typeof setup>;

const failureOf = async (call: Promise<unknown>): Promise<unknown> => {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteRefused);
  return (error as WriteRefused).failure;
};

/** Writes the opening and then the rest through a new part, with `between` run after the opening. */
const exportOnce = async (
  { files, journal }: Pick<Setup, "files" | "journal">,
  between: (path: string) => void = () => undefined,
  rest = REST,
) => {
  const folder = await files.openFolder(DOWNLOADS);
  const { part, path } = await folder.createPart("site.har", journal);
  await part.append(OPENING, OPENING.length);
  between(path);
  await part.append(rest, rest.length);
  return { part, path };
};

/** As the host does: finish, or discard on any failure, and hand back the failure. */
const finishOrDiscard = async (part: Part): Promise<unknown> => {
  const failure = await failureOf(part.finish("site.har"));
  await part.discard();
  return failure;
};

/** What the part at `path` holds now. */
const partText = (fs: MemoryFs, path: string): string =>
  Buffer.from((fs.nodes.get(path) as FileNode).bytes).toString();

/** Names under the export folder, links and FIFOs included. */
const inDownloads = (fs: MemoryFs): readonly string[] =>
  [...fs.nodes.keys()].filter((p) => p.startsWith(`${DOWNLOADS}/`)).sort();

/**
 * What each cause must report, from the contract's kinds.
 */
const CAUSES: readonly {
  readonly cause: string;
  readonly call: OpKey;
  readonly error: unknown;
  readonly kind: string;
}[] = [
  {
    cause: "read-only mount, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "ReadOnlyError"),
    kind: "read-only",
  },
  {
    cause: "read-only mount, part creation",
    call: "createPart",
    error: { name: "EROFS" },
    kind: "read-only",
  },
  {
    cause: "folder is a file, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "InvalidAccessError"),
    kind: "not-a-folder",
  },
  {
    cause: "no permission, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "NotAllowedError"),
    kind: "access-denied",
  },
  {
    cause: "no permission, part creation",
    call: "createPart",
    error: { name: "EACCES" },
    kind: "access-denied",
  },
  {
    cause: "name too long",
    call: "createPart",
    error: { name: "ENAMETOOLONG" },
    kind: "name-too-long",
  },
  {
    cause: "no atomic rename primitive on filesystem",
    call: "rename",
    error: { name: "NO_ATOMIC_RENAME" },
    kind: "no-atomic-rename",
  },
  {
    cause: "an I/O error the table does not name, on purpose",
    call: "rename",
    error: { name: "NS_ERROR_FILE_DEVICE_FAILURE" },
    kind: "other",
  },
];

/** Moves the export folder to /home/u/moved, with everything in it, and puts a link to the profile in its place. */
const folderToProfileLink = (fs: MemoryFs): void => {
  for (const key of [...fs.nodes.keys()].filter(
    (k) => k === DOWNLOADS || k.startsWith(`${DOWNLOADS}/`),
  )) {
    fs.nodes.set(key.replace(DOWNLOADS, "/home/u/moved"), fs.nodes.get(key)!);
    fs.nodes.delete(key);
  }
  fs.link(DOWNLOADS, PROFILE);
};

/**
 * What happens while paused before the rename, and how the export must end.
 */
const BEFORE_RENAME: readonly {
  readonly cause: string;
  readonly act: (fs: MemoryFs, path: string) => void;
  readonly kind: string;
  readonly left: readonly string[];
  readonly profile?: readonly string[];
}[] = [
  {
    cause: "the folder is deleted",
    act: (fs) => fs.removeTree(DOWNLOADS),
    kind: "folder-missing",
    left: [],
  },
  {
    cause: "the folder is replaced by a link to the profile",
    act: folderToProfileLink,
    kind: "folder-refused",
    left: [],
  },
  {
    cause:
      "the folder is replaced by a link to the profile, the part hard-linked there under its name",
    act: (fs, path) => {
      folderToProfileLink(fs);
      fs.nodes.set(
        `${PROFILE}/site.har.part`,
        fs.nodes.get(path.replace(DOWNLOADS, "/home/u/moved"))!,
      );
    },
    kind: "folder-refused",
    left: [],
    profile: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har.part`],
  },
  {
    cause: "the part is deleted",
    act: (fs, path) => fs.nodes.delete(path),
    kind: "file-replaced",
    left: [],
  },
  {
    cause: "a FIFO takes the part's name",
    act: (fs, path) => fs.fifo(path),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause: "a link to prefs.js takes the part's name",
    act: (fs, path) => fs.link(path, `${PROFILE}/prefs.js`),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause: "a hard link to prefs.js takes the part's name",
    act: (fs, path) => fs.nodes.set(path, fs.nodes.get(`${PROFILE}/prefs.js`)!),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause:
      "a regular file of the written length and first bytes, at another inode, takes the part's name",
    act: (fs, path) => fs.file(path, partText(fs, path)),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
];

describe("the export file boundary (held-folder named part)", () => {
  it("refuses with no-atomic-rename when the platform cannot hold folders or rename atomically", async () => {
    const at = setup((p) => ({
      ...p,
      holdFolder: async () => Promise.reject({ name: "NO_ATOMIC_RENAME" }),
    }));
    const folder = await at.files.openFolder(DOWNLOADS);
    expect(await failureOf(folder.createPart("site.har", at.journal))).toEqual({
      kind: "no-atomic-rename",
    });
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("refuses under a taken name when the filesystem refuses atomic no-replace rename, leaving the taken name untouched", async () => {
    const at = setup();
    at.fs.file(`${DOWNLOADS}/site.har`, "theirs");
    at.fs.fail.set("rename", { name: "NO_ATOMIC_RENAME" });
    const { part } = await exportOnce(at);
    expect(await finishOrDiscard(part)).toEqual({ kind: "no-atomic-rename" });
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe("theirs");
    expect(inDownloads(at.fs)).toEqual([`${DOWNLOADS}/site.har`]);
    expect(at.journal.unended()).toEqual([]);
  });

  it.each(CAUSES)(
    "reports $cause as $kind, with no text, and leaves no journal line open",
    async ({ call, error, kind }) => {
      const at = setup();
      at.fs.fail.set(call, error);
      let part: Part | null = null;
      const failure = await failureOf(
        exportOnce(at).then((written) => {
          part = written.part;
          return written.part.finish("site.har");
        }),
      );
      await (part as Part | null)?.discard();
      expect(failure).toEqual({ kind });
      expect(at.journal.unended()).toEqual([]);
      if (call !== "rename") expect(at.journal.lines).toEqual([]);
      expect(inDownloads(at.fs)).toEqual([]);
    },
  );

  it.each(BEFORE_RENAME)(
    "when $cause while paused before the rename, reports $kind and changes nothing else",
    async ({ act, kind, left, profile = [`${PROFILE}/prefs.js`] }) => {
      const at = setup();
      const { part, path } = await exportOnce(at);
      const held = at.limits.hold("before-link");
      const finished = failureOf(part.finish("site.har"));
      await held.reached;
      act(at.fs, path);
      const replacement = at.fs.nodes.get(path);
      const inProfile = profile.map((p) => at.fs.nodes.get(p));
      held.release();
      expect(await finished).toEqual({ kind });
      await part.discard();
      expect(inDownloads(at.fs)).toEqual(left);
      if (left.length > 0) expect(at.fs.nodes.get(path)).toBe(replacement);
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect([...at.fs.nodes.keys()].filter((p) => p.startsWith(`${PROFILE}/`)).sort()).toEqual(
        profile,
      );
      profile.forEach((p, i) => expect(at.fs.nodes.get(p), p).toBe(inProfile[i]));
      expect(at.journal.unended()).toEqual([]);
    },
  );

  it("reports a full disk with the bytes a write needed and the free bytes", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    const platform = { ...fs.platform({ preferNamed: "platform" }), freeBytes: () => 4096 };
    const files = exportFiles(platform, () => true, new Limits());
    const folder = await files.openFolder("/d");
    const { part } = await folder.createPart("a.har", new MemoryJournal());
    fs.fail.set("write", { name: "ENOSPC" });
    expect(await failureOf(part.append("x".repeat(10_000), 10_000))).toEqual({
      kind: "disk-full",
      needBytes: 10_000,
      freeBytes: 4096,
    });
  });

  it("journals a part only once it holds its opening, and ends the line at the rename", async () => {
    const at = setup();
    const folder = await at.files.openFolder(DOWNLOADS);
    const { part, path } = await folder.createPart("site.har", at.journal);
    expect(at.journal.lines).toEqual([]);
    await part.append(OPENING, OPENING.length);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }]);
    await part.append(REST, REST.length);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
    expect(at.fs.nodes.has(path)).toBe(false);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("writes nothing through a part replaced by a link, a regular file or a hard link, reports file-replaced, and leaves the replacement", async () => {
    const attacks: readonly ((fs: MemoryFs, path: string) => void)[] = [
      (fs, path) => fs.link(path, `${PROFILE}/prefs.js`),
      (fs, path) => fs.file(path, "attacker's own file"),
      (fs, path) => fs.nodes.set(path, fs.nodes.get(`${PROFILE}/prefs.js`)!),
    ];
    for (const attack of attacks) {
      const at = setup();
      const { part, path } = await exportOnce(at, (p) => attack(at.fs, p));
      const replacement = at.fs.nodes.get(path);
      expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect(at.fs.nodes.has(`${DOWNLOADS}/site.har`)).toBe(false);
      expect(at.fs.nodes.get(path)).toBe(replacement);
      expect(at.journal.unended()).toEqual([]);
    }
  });

  const ONE_CONJUNCT: readonly {
    readonly seenBy: string;
    readonly change: string;
    readonly make: (fs: MemoryFs, path: string) => void;
    readonly inPlace: boolean;
  }[] = [
    {
      seenBy: "kind",
      change: "a FIFO whose reported size follows the part's",
      make: (fs, p) => fs.fifo(p, fs.nodes.get(p) as FileNode),
      inPlace: false,
    },
    {
      seenBy: "size",
      change: "a regular file one byte longer than the part",
      make: (fs, p) => fs.file(p, `${partText(fs, p)}x`),
      inPlace: false,
    },
    {
      seenBy: "identity",
      change: "a regular file with the part's size and first bytes, at another inode",
      make: (fs, p) => fs.file(p, partText(fs, p)),
      inPlace: false,
    },
    {
      seenBy: "written length",
      change: "the part's own file, appended to by another writer",
      make: (fs, p) => (fs.nodes.get(p) as FileNode).bytes.push(...Buffer.from(" ")),
      inPlace: true,
    },
    {
      seenBy: "first bytes",
      change: "the part's own first bytes, overwritten in place",
      make: (fs, p) => (fs.nodes.get(p) as FileNode).bytes.fill(0x20, 0, 16),
      inPlace: true,
    },
  ];
  it.each(ONE_CONJUNCT)(
    "only the $seenBy test sees $change; nothing is renamed and nothing but the export's own file is deleted",
    async ({ make, inPlace }) => {
      const at = setup();
      const { part, path } = await exportOnce(at, () => undefined, "");
      make(at.fs, path);
      const replacement = at.fs.nodes.get(path);
      expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
      expect(at.fs.moves).toEqual([]);
      expect(at.fs.fifoRead).toBe(false);
      expect(at.fs.nodes.get(path)).toBe(inPlace ? undefined : replacement);
      expect(at.journal.unended()).toEqual([]);
    },
  );

  it("after rename, a folder swapped for a link with a file already at the name is refused and cleans up inside the held folder only", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.limits.hold("after-link");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    folderToProfileLink(at.fs);
    const theirs = at.fs.file(`${PROFILE}/site.har`, "theirs");
    held.release();
    expect(await finished).toEqual({ kind: "folder-refused" });
    await part.discard();
    expect(at.fs.nodes.get(`${PROFILE}/site.har`)).toBe(theirs);
    expect(at.fs.nodes.has("/home/u/moved/site.har")).toBe(false);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("a finished name removed or replaced right after rename is file-replaced and never deletes the replacement", async () => {
    const removed = setup();
    const first = await exportOnce(removed);
    const holdRemoved = removed.limits.hold("after-link");
    const resRemoved = failureOf(first.part.finish("site.har"));
    await holdRemoved.reached;
    removed.fs.nodes.delete(`${DOWNLOADS}/site.har`);
    holdRemoved.release();
    expect(await resRemoved).toEqual({ kind: "file-replaced" });
    await first.part.discard();
    expect(inDownloads(removed.fs)).toEqual([]);

    const replaced = setup();
    const second = await exportOnce(replaced);
    const holdReplaced = replaced.limits.hold("after-link");
    const resReplaced = failureOf(second.part.finish("site.har"));
    await holdReplaced.reached;
    const theirs = replaced.fs.file(`${DOWNLOADS}/site.har`, "theirs");
    holdReplaced.release();
    expect(await resReplaced).toEqual({ kind: "file-replaced" });
    await second.part.discard();
    expect(replaced.fs.nodes.get(`${DOWNLOADS}/site.har`)).toBe(theirs);
  });

  it("a rename still running after the step limit ends timed-out, and the file is deleted once it lands", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    at.limits.elapse();
    expect(await finished).toEqual({ kind: "timed-out" });
    await part.discard();
    expect(at.journal.unended()).toEqual([{ path, head: OPENING }]);
    held.release();
    await expect.poll(() => at.journal.unended()).toEqual([]);
    expect(at.fs.moves).toEqual([`${path} -> ${DOWNLOADS}/site.har`]);
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("cancel during the rename ends cancelled once the rename lands, and deletes the finished file", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = part.finish("site.har").then(
      () => null,
      (e: unknown) => e,
    );
    await held.reached;
    at.limits.signal.aborted = true;
    held.release();
    expect(await finished).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("cancel before the rename renames nothing", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    at.limits.signal.aborted = true;
    expect(await part.finish("site.har").catch((e: unknown) => e)).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(at.fs.moves).toEqual([]);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("refuses a folder that is a link, resolves into the profile, or becomes a link", async () => {
    const linked = setup();
    linked.fs.nodes.delete(DOWNLOADS);
    linked.fs.link(DOWNLOADS, PROFILE);
    expect(await failureOf(linked.files.openFolder(DOWNLOADS))).toEqual({ kind: "folder-refused" });

    const through = setup();
    through.fs.link("/home/u/in", PROFILE);
    expect(await failureOf(through.files.openFolder("/home/u/in/new"))).toEqual({
      kind: "folder-refused",
    });
    expect(through.fs.nodes.has(`${PROFILE}/new`)).toBe(false);

    const later = setup();
    const { part } = await exportOnce(later, () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    expect(await finishOrDiscard(part)).toEqual({ kind: "folder-refused" });
    expect([...later.fs.nodes.keys()].filter((p) => p.startsWith(PROFILE))).toEqual([
      PROFILE,
      `${PROFILE}/prefs.js`,
    ]);
    expect(later.journal.unended()).toEqual([]);
  });

  it("never overwrites, and journals only the part it created: taken names, even a dangling link, move on", async () => {
    const at = setup();
    at.fs.file(`${DOWNLOADS}/site.har`, "theirs");
    at.fs.file(`${DOWNLOADS}/site.har.part`, "a stale part");
    at.fs.link(`${DOWNLOADS}/site (2).har.part`, "/nowhere");
    const { part, path } = await exportOnce(at, () =>
      at.fs.file(`${DOWNLOADS}/site (2).har`, "also theirs"),
    );
    expect(path).toBe(`${DOWNLOADS}/site (3).har.part`);
    expect(await part.finish("site.har")).toBe("site (3).har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe("theirs");
    expect(at.fs.text(`${DOWNLOADS}/site.har.part`)).toBe("a stale part");
    expect(at.fs.text(`${DOWNLOADS}/site (2).har`)).toBe("also theirs");
    expect(at.fs.text(`${DOWNLOADS}/site (3).har`)).toBe(DOCUMENT);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("moves past a taken finished name during atomic rename without overwriting it", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.limits.hold("before-link");
    const finished = part.finish("site.har");
    await held.reached;
    at.fs.file(`${DOWNLOADS}/site.har`, "raced");
    held.release();
    expect(await finished).toBe("site (2).har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe("raced");
    expect(at.fs.text(`${DOWNLOADS}/site (2).har`)).toBe(DOCUMENT);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("discards only its own part, and keeps the line of a part it could not delete", async () => {
    const own = setup();
    const { part, path } = await exportOnce(own);
    await part.discard();
    expect(own.fs.nodes.has(path)).toBe(false);
    expect(own.journal.unended()).toEqual([]);

    const stuck = setup();
    const third = await exportOnce(stuck);
    stuck.fs.fail.set("discard", new DOMException("x", "NotAllowedError"));
    await third.part.discard();
    expect(stuck.fs.text(third.path)).toBe(DOCUMENT);
    expect(stuck.journal.unended()).toEqual([{ path: third.path, head: OPENING }]);
  });

  it("before its opening is journaled, a part is discarded as the handle's own file", async () => {
    const at = setup();
    const folder = await at.files.openFolder(DOWNLOADS);
    const { part, path } = await folder.createPart("site.har", at.journal);
    await part.discard();
    expect(at.fs.nodes.has(path)).toBe(false);
    expect(at.journal.lines).toEqual([]);
  });
});

/** An export folder the platform holds open, as on Linux. */
const held = () => setup((p) => p, {});

/** Names under a folder, links and FIFOs included. */
const under = (fs: MemoryFs, folder: string): readonly string[] =>
  [...fs.nodes.keys()].filter((p) => p.startsWith(`${folder}/`)).sort();

/**
 * Changes raced against the finish at a pause point, each with what the export must report and every name under the
 * export folder, the folder it was moved to, and the profile afterwards.
 */
const RACES: readonly {
  readonly cause: string;
  readonly at: ExportPause;
  readonly act: (fs: MemoryFs) => void;
  readonly ends: { readonly done: string } | { readonly kind: string; readonly unconfirmed?: true };
  readonly left: { readonly [folder: string]: readonly string[] };
}[] = [
  {
    cause: "a foreign file is written at the finished name",
    at: "before-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har`, "theirs"),
    ends: { done: "site (2).har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site (2).har`, `${DOWNLOADS}/site.har`] },
  },
  {
    cause: "a link to prefs.js is put at the finished name",
    at: "before-link",
    act: (fs) => fs.link(`${DOWNLOADS}/site.har`, `${PROFILE}/prefs.js`),
    ends: { done: "site (2).har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site (2).har`, `${DOWNLOADS}/site.har`] },
  },
  {
    cause: "a file is put at the part's name",
    at: "before-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har.part`, "theirs"),
    ends: { done: "site.har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`, `${DOWNLOADS}/site.har.part`] },
  },
  {
    cause: "the folder is replaced by a link to the profile",
    at: "before-link",
    act: folderToProfileLink,
    ends: { kind: "folder-refused", unconfirmed: true },
    left: { "/home/u/moved": ["/home/u/moved/site.har"], [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause:
      "the folder is replaced by a link to the profile, with a file already there at the part's name",
    at: "before-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.file(`${PROFILE}/site.har.part`, "theirs");
    },
    ends: { kind: "folder-refused", unconfirmed: true },
    left: {
      "/home/u/moved": ["/home/u/moved/site.har"],
      [PROFILE]: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har.part`],
    },
  },
  {
    cause: "the folder is replaced by a link to the profile and put back",
    at: "before-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.nodes.delete(DOWNLOADS);
      fs.nodes.set(DOWNLOADS, fs.nodes.get("/home/u/moved")!);
      fs.nodes.delete("/home/u/moved");
    },
    ends: { done: "site.har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`], [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause: "the folder is deleted",
    at: "before-link",
    act: (fs) => fs.removeTree(DOWNLOADS),
    ends: { kind: "folder-missing" },
    left: { [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause: "the finished name is removed",
    at: "after-link",
    act: (fs) => fs.nodes.delete(`${DOWNLOADS}/site.har`),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [] },
  },
  {
    cause: "a foreign file takes the finished name",
    at: "after-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har`, "theirs"),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`] },
  },
  {
    cause: "the finished file's first bytes are overwritten",
    at: "after-link",
    act: (fs) => (fs.nodes.get(`${DOWNLOADS}/site.har`) as FileNode).bytes.fill(0x20, 0, 16),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`] },
  },
  {
    cause:
      "the folder is replaced by a link to the profile with a file already at the finished name",
    at: "after-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.file(`${PROFILE}/site.har`, "theirs");
    },
    ends: { kind: "folder-refused", unconfirmed: true },
    left: {
      "/home/u/moved": ["/home/u/moved/site.har"],
      [PROFILE]: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har`],
    },
  },
];

describe("an export folder held open, its file unnamed until one link", () => {
  it("names only its own file, in the held folder, and renames or deletes nothing", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
    expect(inDownloads(at.fs)).toEqual([`${DOWNLOADS}/site.har`]);
    expect(at.fs.removes).toEqual([]);
    expect(at.journal.lines).toEqual([]);
  });

  it.each(RACES)(
    "when $cause ($at), ends as written and touches nothing it did not create",
    async ({ at: point, act, ends, left }) => {
      const at = held();
      const { part } = await exportOnce(at);
      const before = new Map(at.fs.nodes);
      const hold = at.limits.hold(point);
      const finished = part.finish("site.har").then(
        (name) => ({ done: name }),
        (error: unknown) => error,
      );
      await hold.reached;
      act(at.fs);
      const acted = new Map(at.fs.nodes);
      hold.release();
      const outcome = await finished;
      await part.discard();
      if ("done" in ends) expect(outcome).toEqual(ends);
      else {
        expect(outcome).toBeInstanceOf(WriteRefused);
        expect((outcome as WriteRefused).failure).toEqual({ kind: ends.kind });
        expect(part.unconfirmed()).toBe(ends.unconfirmed === true);
      }
      for (const [folder, names] of Object.entries(left))
        expect(under(at.fs, folder)).toEqual(names);
      for (const [path, node] of acted)
        if (before.get(path) === node || !before.has(path))
          expect(at.fs.nodes.get(path), path).toBe(node);
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect(at.fs.removes).toEqual([]);
    },
  );

  it("an unnamed file overwritten through its descriptor is never named", async () => {
    const at = held();
    const { part } = await exportOnce(at, () => at.fs.lastUnnamed?.bytes.fill(0x20, 0, 16));
    expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
    expect(part.unconfirmed()).toBe(false);
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("a folder replaced before the finish is refused without naming anything", async () => {
    const at = held();
    const { part } = await exportOnce(at, () => folderToProfileLink(at.fs));
    expect(await finishOrDiscard(part)).toEqual({ kind: "folder-refused" });
    expect(part.unconfirmed()).toBe(false);
    expect(under(at.fs, "/home/u/moved")).toEqual([]);
    expect(under(at.fs, PROFILE)).toEqual([`${PROFILE}/prefs.js`]);
  });

  it("cancel while the link waits names nothing, and nothing is left", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    const hold = at.limits.hold("before-link");
    const finished = part.finish("site.har").catch((e: unknown) => e);
    await hold.reached;
    at.limits.signal.aborted = true;
    hold.release();
    expect(await finished).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    expect(part.unconfirmed()).toBe(false);
  });

  it("a link still waiting at the step limit ends timed-out, and names nothing once let go", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    const hold = at.limits.hold("before-link");
    const finished = failureOf(part.finish("site.har"));
    await hold.reached;
    at.limits.elapse();
    expect(await finished).toEqual({ kind: "timed-out" });
    await part.discard();
    hold.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("finishes on the link route and says so", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(part.route()).toEqual({ route: "link" });
  });

  /** Every errno the table names, from the call that makes the file and from the link, with what it must end as. */
  const ERRNO_ROWS = Object.entries(ERRNO_KINDS).flatMap(([errno, kind]) =>
    (["createUnnamed", "link"] as const)
      .filter((call) => call !== "link" || !Object.hasOwn(LINK_FALLBACK, errno))
      .map((call) => ({ errno, call, kind })),
  );
  it.each(ERRNO_ROWS)(
    "reports $errno from $call as $kind, with nothing left",
    async ({ errno, call, kind }) => {
      const at = held();
      at.fs.failUnnamed.set(call, { name: errno });
      const failure = await failureOf(
        exportOnce(at).then(async ({ part }) => {
          try {
            return await part.finish("site.har");
          } finally {
            await part.discard();
          }
        }),
      );
      expect(failure).toEqual(
        kind === "disk-full" ? { kind, needBytes: 1, freeBytes: 0 } : { kind },
      );
      expect(inDownloads(at.fs)).toEqual([]);
    },
  );

  it("leaves an errno the table does not name as other: a fault in the call itself", async () => {
    for (const errno of ["EBADF", "EFAULT", "EINVAL", "ENOMEM"]) {
      expect(Object.hasOwn(ERRNO_KINDS, errno), errno).toBe(false);
      const at = held();
      at.fs.failUnnamed.set("link", { name: errno });
      const { part } = await exportOnce(at);
      expect(await finishOrDiscard(part), errno).toEqual({ kind: "other" });
    }
  });

  it.each(Object.entries(LINK_FALLBACK).map(([errno, because]) => ({ errno, because })))(
    "a link refused with $errno moves the whole file to a named part and finishes there ($because)",
    async ({ errno, because }) => {
      const at = held();
      at.fs.failUnnamed.set("link", { name: errno });
      const { part } = await exportOnce(at);
      expect(await part.finish("site.har")).toBe("site.har");
      expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
      expect(inDownloads(at.fs)).toEqual([`${DOWNLOADS}/site.har`]);
      expect(part.route()).toEqual({ route: "named", because, errno });
      const path = `${DOWNLOADS}/site.har.part`;
      const head = DOCUMENT.slice(0, 128);
      expect(at.journal.lines).toEqual([{ started: path, head }, { ended: path }]);
      expect(part.unconfirmed()).toBe(false);
    },
  );

  it("a copy to a named part that fails is discarded, and the export names nothing", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    const { part } = await exportOnce(at);
    at.fs.fail.set("rename", new DOMException("x", "NotReadableError"));
    expect(await finishOrDiscard(part)).toEqual({ kind: "other" });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("a short write and then a full disk on the unnamed file end disk-full, with nothing left", async () => {
    const at = held();
    at.fs.room = OPENING.length + 10;
    const rest = "x".repeat(100);
    const failure = await failureOf(
      exportOnce(at, () => undefined, rest).then(async ({ part }) => part.finish("site.har")),
    );
    expect(failure).toEqual({ kind: "disk-full", needBytes: 100, freeBytes: 0 });
    expect(at.fs.lastUnnamed?.bytes.length).toBe(OPENING.length + 10);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([]);
  });

  it("the copy's first write meeting a short write and then a full disk ends disk-full, with no part left", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    const { part } = await exportOnce(at);
    at.fs.room = 10;
    expect(await finishOrDiscard(part)).toEqual({
      kind: "disk-full",
      needBytes: DOCUMENT.length,
      freeBytes: 0,
    });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("a copy whose bytes are not the unnamed file's fails as copy-mismatch, with nothing left", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    at.fs.copyCorrupts = true;
    const { part } = await exportOnce(at);
    expect(await finishOrDiscard(part)).toEqual({ kind: "copy-mismatch" });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("cancel while the bytes move to a named part ends cancelled, with nothing left", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    at.fs.failUnnamed.set("link", {
      get name() {
        at.limits.signal.aborted = true;
        return "EXDEV";
      },
    });
    expect(await part.finish("site.har").catch((e: unknown) => e)).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([]);
  });

  it.each([
    {
      cause: "the folder's file system makes no unnamed file",
      set: "noUnnamedFiles",
      because: "unnamed-refused",
      errno: "EOPNOTSUPP",
    },
    {
      cause: "/proc/self/fd cannot lead to the unnamed file",
      set: "noFdLink",
      because: "fd-link-unavailable",
      errno: "fd-link-unavailable",
    },
  ] as const)("names a part from the start where $cause", async ({ set, because, errno }) => {
    const at = held();
    at.fs[set] = true;
    const { part, path } = await exportOnce(at);
    expect(path).toBe(`${DOWNLOADS}/site.har.part`);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
    expect(part.route()).toEqual({ route: "named", because, errno });
  });
});

describe("the proof, without a handle, that a file is an export's", () => {
  const io = (fs: MemoryFs) => fs.platform();
  it("is a regular file, not a link, that starts with the journaled head, and never reads a FIFO", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    fs.file("/d/ours.har.part", `${OPENING}{"entry"`);
    fs.file("/d/theirs.har.part", "x".repeat(OPENING.length + 10));
    fs.file("/d/short.har.part", OPENING.slice(0, 10));
    fs.link("/d/link.har.part", "/d/ours.har.part");
    fs.fifo("/d/fifo.har.part", 4096);
    fs.folder("/d/folder.har.part", 4096);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING)).toBe(true);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING, OPENING.length + 8)).toBe(true);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING, OPENING.length)).toBe(false);
    for (const path of [
      "/d/theirs.har.part",
      "/d/short.har.part",
      "/d/link.har.part",
      "/d/fifo.har.part",
      "/d/folder.har.part",
      "/d/missing.har.part",
    ])
      expect(await carriesHead(io(fs), path, OPENING), path).toBe(false);
    expect(await carriesHead(io(fs), "/d/ours.har.part", "")).toBe(false);
    expect(fs.fifoRead).toBe(false);
  });

  it("is refused when the file stops being a regular file during the read", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    fs.file("/d/ours.har.part", OPENING);
    const platform = fs.platform();
    const swapping = {
      state: platform.state,
      readHead: async (path: string, bytes: number) => {
        const read = await platform.readHead(path, bytes);
        fs.fifo(path, OPENING.length);
        return read;
      },
    };
    expect(await carriesHead(swapping, "/d/ours.har.part", OPENING)).toBe(false);
  });
});

describe("the export's part sink", () => {
  it("writes every piece in order, the first alone and at once, and counts UTF-8 bytes as Node encodes them", async () => {
    const appended: string[] = [];
    const reported: number[] = [];
    const sink = createPartSink(
      async (text) => void appended.push(text),
      (bytes) => reported.push(bytes),
    );
    await sink.write(OPENING);
    expect(appended).toEqual([OPENING]);
    const pieces = ['{"a":"', "x".repeat(SINK_BATCH_UNITS), "é中😀", "\ud800", '"}'];
    for (const piece of pieces) await sink.write(piece);
    await sink.close();
    const text = OPENING + pieces.join("");
    expect(appended.join("")).toBe(text);
    expect(appended.length).toBeGreaterThan(2);
    expect(sink.bytesWritten()).toBe(Buffer.byteLength(text, "utf8"));
    expect(reported.at(-1)).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("the export journal", () => {
  it("names the parts that started and never ended, with their heads, and nothing else", () => {
    const journal = [
      journalLine({ started: "/d/a.har.part", head: OPENING }),
      journalLine({ started: "/d/b.har.part", head: OPENING }),
      journalLine({ ended: "/d/a.har.part" }),
      journalLine({ started: "/home/user/.bashrc", head: OPENING }),
      '{"started":"/d/no-head.har.part"}\n',
      journalLine({ started: "/d/empty-head.har.part", head: "" }),
      '{"started":"/d/torn.har.pa',
    ].join("");
    expect(unfinishedExports(journal)).toEqual([{ path: "/d/b.har.part", head: OPENING }]);
    expect(unfinishedExports("")).toEqual([]);
  });

  it("keeps the started line open with a discardFailed reason when discard throws", async () => {
    const { files, journal } = setup((base) => ({
      ...base,
      holdFolder: async (path) => {
        const held = await base.holdFolder!(path);
        return {
          ...held,
          createNamedPart: async (name, partPath) => {
            const created = await held.createNamedPart(name, partPath);
            if (created === null) return null;
            return {
              ...created,
              discard: () => Promise.reject(Object.assign(new Error("locked"), { name: "EACCES" })),
            };
          },
        };
      },
    }));
    const opened = await files.openFolder(DOWNLOADS);
    const { part } = await opened.createPart("a.har", journal);
    await part.append(OPENING, OPENING.length);
    await part.discard();
    expect(journal.unended()).toEqual([{ path: `${DOWNLOADS}/a.har.part`, head: OPENING }]);
    expect(journal.lines).toContainEqual({
      discardFailed: `${DOWNLOADS}/a.har.part`,
      reason: "EACCES",
    });
  });
});
