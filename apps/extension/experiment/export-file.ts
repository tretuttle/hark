// How an export reaches disk: the one boundary for every export file call, where a platform error becomes a
// WriteFailure. Every platform holds the export folder open in file-worker.ts and finishes with an atomic
// no-replace primitive (O_TMPFILE + linkat or renameat2 on Linux, renameatx_np on macOS, FileRenameInfo with
// ReplaceIfExists = FALSE on Windows). Any platform or filesystem without one refuses rather than falling back.

import type { WriteFailure } from "@hark/export/jobs";
import { WriteRefused, type HarSink } from "@hark/export/run";
import type { AbortSignalLike } from "@hark/export/source";
import type { ByteCount } from "@hark/recording/ids";

/** Text is handed to the file in batches of about this many UTF-16 code units. */
export const SINK_BATCH_UNITS = 1_048_576;
const PART_SUFFIX = ".part";

/** UTF-8 length of a JavaScript string. A lone surrogate is written as U+FFFD, three bytes. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

/**
 * Platform errors by DOMException `name` or nsresult name for folder setup (makeFolder, freeBytes), never message
 * text, which carries paths.
 */
const FS_ERROR_KINDS: {
  readonly [name: string]: Exclude<WriteFailure["kind"], "other" | "disk-full" | "timed-out">;
} = {
  /** A folder that must be created where this user may not write. */
  NotAllowedError: "access-denied",
  /** A folder that must be created on a read-only mount. */
  ReadOnlyError: "read-only",
  /** The folder is a file. */
  InvalidAccessError: "not-a-folder",
  NS_ERROR_FILE_NAME_TOO_LONG: "name-too-long",
  NS_ERROR_FILE_ACCESS_DENIED: "access-denied",
  NS_ERROR_FILE_READ_ONLY: "read-only",
};

/**
 * What an errno from file-worker.ts means for the export, for every call: the folder, the file, its writes and
 * the finish/discard. `disk-full` comes with no free bytes, which is what the kernel said. EBADF, EFAULT, EINVAL and
 * ENOMEM are faults in the call or process and stay `other`.
 */
export const ERRNO_KINDS: {
  readonly [errno: string]: Exclude<WriteFailure["kind"], "other" | "timed-out">;
} = {
  EACCES: "access-denied",
  EPERM: "access-denied",
  EROFS: "read-only",
  ENOSPC: "disk-full",
  EDQUOT: "disk-full",
  ENAMETOOLONG: "name-too-long",
  /** The held folder was deleted. */
  ENOENT: "folder-missing",
  ENOTDIR: "not-a-folder",
  /** The folder's path ends in a link, which holding it never follows. */
  ELOOP: "folder-refused",
  EIO: "io-error",
  /** The platform or filesystem lacks an atomic no-replace rename primitive. */
  NO_ATOMIC_RENAME: "no-atomic-rename",
};

/**
 * Errors of the Linux link alone that say the link cannot be made here, not that the folder refuses the file: the
 * export's bytes move to a named part inside the held folder, and finish with renameat2(RENAME_NOREPLACE).
 */
export const LINK_FALLBACK: { readonly [error: string]: NamedBecause } = {
  /** /proc/self/fd no longer leads to the file (masked or gone since the file was made). */
  "fd-link-unavailable": "fd-link-lost",
  /** The file system will not link this file into the folder. */
  EXDEV: "link-refused",
  EMLINK: "link-refused",
  EPERM: "link-refused",
};

/** A failure that is only its kind. */
type Refused = Exclude<WriteFailure["kind"], "disk-full">;

/**
 * Why an export took the named route: platform has no unnamed files (Windows, macOS), or the harness asked; the
 * folder's file system makes no unnamed files, or /proc cannot lead to one; or the link failed after writing.
 */
export type NamedBecause =
  | "platform"
  | "harness-pref"
  | "unnamed-refused"
  | "fd-link-unavailable"
  | "fd-link-lost"
  | "link-refused";

/** The route an export took, kept in the parent for diagnosis. A page sees only `route`. */
export type ExportRoute =
  | { readonly route: "link" }
  | { readonly route: "named"; readonly because: NamedBecause; readonly errno?: string };

/** Why a held folder made no linkable unnamed file, and the error that said so. */
export interface UnnamedRefused {
  readonly refused: "unnamed-refused" | "fd-link-unavailable";
  readonly errno: string;
}

const errorName = (error: unknown): string | null => {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" ? name : null;
};

/** What is at a path, without following a link there. `size` is the size lstat gives, whatever the kind. */
export type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "link" | "folder" | "other"; readonly size: number };

/** The raw file calls an export makes outside the worker, plus `holdFolder`. */
export interface ExportPlatform {
  readonly state: (path: string) => PathState;
  /** Every link resolved. May throw for a path that does not exist. */
  readonly realPath: (path: string) => string;
  readonly parent: (path: string) => string | null;
  readonly join: (folder: string, name: string) => string;
  readonly filename: (path: string) => string;
  readonly makeFolder: (folder: string) => Promise<void>;
  /**
   * Up to `bytes` first bytes of what is at `path`, opened so that the open never waits, a FIFO's included, and read
   * only when the opened file reports at least that many bytes. It follows a link, so a caller checks the kind first.
   */
  readonly readHead: (path: string, bytes: number) => Promise<Uint8Array>;
  readonly freeBytes: (folder: string) => number;
  /** A new SHA-256 over the bytes it is given, as lowercase hex. */
  readonly sha256: () => {
    readonly update: (bytes: Uint8Array) => void;
    readonly hex: () => string;
  };
  /** Holds a folder open and creates/renames/discards files in it atomically; absent if unsupported. */
  readonly holdFolder?: (realFolder: string) => Promise<HeldFolder>;
  /** When set, skip unnamed-file creation and use a named `.har.part` inside the held folder. */
  readonly preferNamed?: "platform" | "harness-pref";
}

/** A file's identity: device/volume and inode/file-index, and its kind without following links. */
export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "file" | "folder" | "link" | "other";
}

/** A folder held open: files are created, renamed without replace, and discarded inside it. */
export interface HeldFolder {
  /** The path the held folder has now; null once it was deleted. Any other path, "" included, is somewhere else. */
  readonly where: () => Promise<string | null>;
  /** A new unnamed file in the folder that a link can name, or why there is none. */
  readonly createUnnamed: () => Promise<{ readonly file: UnnamedFile } | UnnamedRefused>;
  /** Creates `<name>.har.part` exclusively inside the held folder; null when the name is taken. */
  readonly createNamedPart: (name: string, path: string) => Promise<NamedPartFile | null>;
  /** What has `name` in the held folder, never following a link; null when nothing has it. */
  readonly identityOf: (name: string) => Promise<FileIdentity | null>;
  readonly close: () => void;
}

/**
 * An open `.har.part` inside a held folder: written and read only through its open handle/fd, finished atomically
 * without replacing an existing target, and discarded by handle/fd.
 */
export interface NamedPartFile {
  readonly identity: FileIdentity;
  readonly write: (text: string) => Promise<void>;
  readonly size: () => Promise<number>;
  readonly read: (offset: number, bytes: number) => Promise<Uint8Array>;
  /** Renames `fromName` to `toName`/`toPath` atomically without replacing; false when target exists. */
  readonly rename: (fromName: string, toName: string, toPath: string) => Promise<boolean>;
  /** Deletes the export's own file (by handle on Windows; identity-checked unlinkat on POSIX) and closes. */
  readonly discard: (name: string) => Promise<void>;
  readonly close: () => void;
}

/**
 * The export's file before it has a name (Linux O_TMPFILE): written and read only through its own descriptor.
 * Closed unnamed, it is gone, and nothing is left to delete.
 */
export interface UnnamedFile {
  readonly identity: FileIdentity;
  readonly write: (text: string) => Promise<void>;
  readonly size: () => Promise<number>;
  /** Up to `bytes` bytes from `offset`; fewer only at the file's end. */
  readonly read: (offset: number, bytes: number) => Promise<Uint8Array>;
  /** Whole UTF-8 sequences from `offset`, at most `bytes` of them, and how many bytes they took. */
  readonly readText: (
    offset: number,
    bytes: number,
  ) => Promise<{ readonly text: string; readonly bytes: number }>;
  /** Gives this file `name` in its folder, never replacing anything: false when something has that name. */
  readonly link: (name: string) => Promise<boolean>;
  readonly close: () => void;
}

/** Where the harness may hold an export: before bodies, before rename/link, right before rename after checks, and after. */
export type ExportPause = "before-bodies" | "before-link" | "before-rename" | "after-link";

/** What bounds an export's file calls: a call still running after `stepMs` is `timed-out`, and cancel is honored. */
export interface ExportLimits {
  readonly stepMs: number;
  /** Settles `elapsed` after `ms`, unless `cancel` comes first. */
  readonly timer: (ms: number) => { readonly elapsed: Promise<void>; readonly cancel: () => void };
  readonly signal: AbortSignalLike;
  /** Resolves at once, unless the harness holds the export at `point`. */
  readonly pause: (point: ExportPause) => Promise<void>;
}

/** Thrown at a step boundary once the job's cancel was asked for. Not a WriteFailure: the job ends cancelled. */
export class ExportCancelled extends Error {
  override readonly name = "ExportCancelled";
}

/**
 * Where a part is recorded so the next start can delete it after a crash. `started` comes only once the part exists
 * and holds `head`, its first bytes, which carry the export's random id; `ended` once the part is renamed, deleted,
 * or found to be no longer this export's.
 */
export interface PartJournal {
  readonly started: (path: string, head: string) => Promise<void>;
  readonly ended: (path: string) => Promise<void>;
  readonly discardFailed?: (path: string, reason: string) => Promise<void>;
}

/** A part being written: appended through its one handle, then finished atomically, or discarded. */
export interface Part {
  readonly append: (text: string, needBytes: number) => Promise<void>;
  /**
   * Confirms the part is this export's file holding what was written, and, given `copyOf`, that its bytes are exactly
   * those, then finishes atomically without replacing anything and returns the name it got.
   */
  readonly finish: (planned: string, copyOf?: FileDigest) => Promise<string>;
  /** Deletes the part if it is still this export's file. Returns at once if a timed-out rename is still running. */
  readonly discard: () => Promise<void>;
  /** True once the export named its file and then could not prove the name still holds it: nothing is named. */
  readonly unconfirmed: () => boolean;
  readonly route: () => ExportRoute;
}

/** A whole file's length and SHA-256. */
export interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExportFolder {
  readonly path: string;
  /** A free name for `planned` and its file, created inside the held folder. */
  readonly createPart: (
    planned: string,
    journal: PartJournal,
  ) => Promise<{ readonly part: Part; readonly path: string }>;
}

const NAME_TRIES = 100;
/** How much of an unnamed file is copied at a time when its bytes move to a named part. */
const COPY_BYTES = 1_048_576;
/** How much of the part's first write is its identity: the document's opening, with the export's random id. */
const HEAD_BYTES = 128;

/** `name.har`, `name (2).har`, and on. */
const numbered = (planned: string, n: number): string => {
  const dot = planned.endsWith(".har") ? planned.length - 4 : planned.length;
  return n === 1 ? planned : `${planned.slice(0, dot)} (${String(n)})${planned.slice(dot)}`;
};

const asciiPrefix = (text: string, max: number): string => {
  let end = 0;
  while (end < text.length && end < max && text.charCodeAt(end) < 0x80) end += 1;
  return text.slice(0, end);
};

const sameBytes = (found: Uint8Array, text: string): boolean =>
  found.length === text.length && found.every((byte, index) => byte === text.charCodeAt(index));

/**
 * Whether the file at `path` is a regular file, not a link, whose first bytes are `head` (and, given `size`, of that
 * length). A head names one export, so this is the proof, without a handle, that a file is that export's own. The
 * kind is read before and after the read, and the read never waits on a FIFO.
 */
export const carriesHead = async (
  io: Pick<ExportPlatform, "state" | "readHead">,
  path: string,
  head: string,
  size?: number,
): Promise<boolean> => {
  const fits = (state: PathState): boolean =>
    state.kind === "file" && (size === undefined ? state.size >= head.length : state.size === size);
  if (head.length === 0 || !fits(io.state(path))) return false;
  return sameBytes(await io.readHead(path, head.length), head) && fits(io.state(path));
};

/**
 * The export's only way to the file system. Every call either succeeds or throws WriteRefused with a kind from
 * ERRNO_KINDS/FS_ERROR_KINDS, or `timed-out` once a call has run `stepMs`. The folder is resolved to its real path
 * and held open; a file is written only through its descriptor/handle and finished with an atomic no-replace call.
 */
export function exportFiles(
  platform: ExportPlatform,
  allowed: (realFolder: string) => boolean,
  limits: ExportLimits,
) {
  const free = (folder: string): number | null => {
    try {
      return platform.freeBytes(folder);
    } catch {
      return null;
    }
  };
  const refuse = (kind: Refused): never => {
    throw new WriteRefused({ kind } as WriteFailure);
  };

  /** Why `folder` is no longer the real, unlinked folder it was resolved to, or null while it still is. */
  const folderProblem = (folder: string): Refused | null => {
    try {
      const state = platform.state(folder).kind;
      if (state === "missing") return "folder-missing";
      if (state === "link") return "folder-refused";
      if (state !== "folder") return "not-a-folder";
      return platform.realPath(folder) === folder ? null : "folder-refused";
    } catch {
      return null;
    }
  };
  const stillFolder = (folder: string): void => {
    const problem = folderProblem(folder);
    if (problem !== null) refuse(problem);
  };

  /** Free space first, then a folder that is no longer the export's, then the error's name. */
  const classify = (
    error: unknown,
    folder: string,
    resolved: boolean,
    needBytes: number,
  ): WriteFailure => {
    const freeBytes = free(folder);
    if (freeBytes !== null && freeBytes < needBytes)
      return {
        kind: "disk-full",
        needBytes: needBytes as ByteCount,
        freeBytes: freeBytes as ByteCount,
      };
    const moved = resolved ? folderProblem(folder) : null;
    if (moved !== null) return { kind: moved } as WriteFailure;
    const name = errorName(error);
    const kind =
      name === null
        ? null
        : Object.hasOwn(FS_ERROR_KINDS, name)
          ? FS_ERROR_KINDS[name]
          : Object.hasOwn(ERRNO_KINDS, name)
            ? ERRNO_KINDS[name]
            : null;
    if (kind === "disk-full")
      return {
        kind,
        needBytes: Math.max(needBytes, 1) as ByteCount,
        freeBytes: 0 as ByteCount,
      };
    return { kind: kind ?? "other" } as WriteFailure;
  };
  const run = async <T>(
    folder: string,
    resolved: boolean,
    call: () => T | Promise<T>,
    needBytes = 0,
  ): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WriteRefused || error instanceof ExportCancelled) throw error;
      throw new WriteRefused(classify(error, folder, resolved, needBytes));
    }
  };

  /** `op`, or `timed-out` once it has run `stepMs`; `late` then gets the call, which may still settle. */
  const bounded = async <T>(op: Promise<T>, late?: (op: Promise<T>) => void): Promise<T> => {
    const timer = limits.timer(limits.stepMs);
    try {
      return await Promise.race([
        op,
        timer.elapsed.then((): never => {
          op.catch(() => undefined);
          late?.(op);
          return refuse("timed-out");
        }),
      ]);
    } finally {
      timer.cancel();
    }
  };

  const openFolder = async (configured: string): Promise<ExportFolder> => {
    const folder = await run(configured, false, async () => {
      if (platform.state(configured).kind === "link") refuse("folder-refused");
      const missing: string[] = [];
      let existing = configured;
      while (platform.state(existing).kind === "missing") {
        const up = platform.parent(existing);
        if (up === null || up === existing) refuse("folder-missing");
        missing.unshift(platform.filename(existing));
        existing = up as string;
      }
      const existingKind = platform.state(existing).kind;
      if (existingKind === "link") refuse("folder-refused");
      if (existingKind !== "folder") refuse("not-a-folder");
      const planned = missing.reduce(platform.join, platform.realPath(existing));
      if (!allowed(planned)) refuse("folder-refused");
      await bounded(platform.makeFolder(planned));
      stillFolder(planned);
      if (!allowed(platform.realPath(planned))) refuse("folder-refused");
      return planned;
    });
    const step = <T>(call: () => T | Promise<T>, needBytes = 0): Promise<T> =>
      run(folder, true, call, needBytes);

    /** The length and SHA-256 of what `read` gives from the start to the end, one bounded read per step. */
    const digestOf = async (
      read: (offset: number) => Uint8Array | Promise<Uint8Array>,
    ): Promise<FileDigest> => {
      const hash = platform.sha256();
      let bytes = 0;
      for (;;) {
        if (limits.signal.aborted) throw new ExportCancelled();
        const at = bytes;
        const chunk = await step(() => bounded(Promise.resolve(read(at))));
        if (chunk.length === 0) return { bytes, sha256: hash.hex() };
        hash.update(chunk);
        bytes += chunk.length;
      }
    };

    const awayIn = async (held: HeldFolder): Promise<Refused | null> => {
      const now = await held.where();
      if (now === null) return folderProblem(folder) ?? "folder-missing";
      return now === folder ? null : "folder-refused";
    };

    const sameIdentity = (a: FileIdentity | null, b: FileIdentity): boolean =>
      a !== null && a.kind === "file" && a.dev === b.dev && a.ino === b.ino;

    /**
     * A named `.har.part` inside a held folder: written and read only through its open handle/fd, finished atomically
     * without replacing anything, and discarded by handle/fd (FileDispositionInfo on Windows, identity-checked
     * unlinkat on POSIX).
     */
    const heldNamedPart = (
      held: HeldFolder,
      file: NamedPartFile,
      partName: string,
      partPath: string,
      journal: PartJournal,
      route: ExportRoute,
    ): Part => {
      let written = 0;
      let head = "";
      let journaled = false;
      let open = true;
      let atName = partName;
      let late: Promise<void> | null = null;
      const close = (): void => {
        if (!open) return;
        open = false;
        file.close();
        held.close();
      };
      const holdsWritten = async (): Promise<boolean> =>
        (await file.size()) === written && sameBytes(await file.read(0, head.length), head);
      const sameAt = async (name: string): Promise<boolean> =>
        sameIdentity(await held.identityOf(name), file.identity);
      const ended = async (): Promise<void> => {
        if (journaled) await bounded(journal.ended(partPath));
      };
      const cleanUp = async (): Promise<void> => {
        if (!open) return;
        open = false;
        let discarded = false;
        let discardError: unknown = null;
        try {
          await bounded(file.discard(atName));
          discarded = true;
        } catch (error) {
          // Still journaled with a reason if not removed; next-start recovery cleans it up.
          discardError = error;
        } finally {
          held.close();
        }
        if (discarded) {
          await ended().catch(() => undefined);
        } else if (journaled) {
          const reason = errorName(discardError) ?? String(discardError);
          await journal.discardFailed?.(partPath, reason).catch(() => undefined);
        }
      };
      return {
        append: async (text, needBytes) => {
          const first = written === 0 && !journaled;
          await step(async () => {
            if (first) head = asciiPrefix(text, HEAD_BYTES);
            await bounded(file.write(text));
            written += needBytes;
            if (!first) return;
            const gone = await bounded(awayIn(held));
            if (gone !== null) refuse(gone);
            if (!(await bounded(sameAt(partName))) || !(await bounded(holdsWritten())))
              refuse("file-replaced");
          }, needBytes);
          if (!first) return;
          journaled = true;
          await step(() => bounded(journal.started(partPath, head)));
        },
        finish: async (planned, copyOf) => {
          await step(async () => {
            const gone = await bounded(awayIn(held));
            if (gone !== null) refuse(gone);
            if (!(await bounded(sameAt(partName))) || !(await bounded(holdsWritten())))
              refuse("file-replaced");
          });
          if (copyOf !== undefined) {
            const copied = await digestOf((at) => file.read(at, COPY_BYTES));
            if (copied.bytes !== copyOf.bytes || copied.sha256 !== copyOf.sha256)
              refuse("copy-mismatch");
          }
          for (let n = 1; n <= NAME_TRIES; n += 1) {
            if (limits.signal.aborted) throw new ExportCancelled();
            const name = numbered(planned, n);
            const target = platform.join(folder, name);
            await step(() =>
              bounded(
                limits.pause("before-link").then(() => {
                  if (!open || limits.signal.aborted) throw new ExportCancelled();
                }),
              ),
            );
            const renamed = await step(() =>
              bounded(
                (async () => {
                  const gone = await awayIn(held);
                  if (gone !== null) refuse(gone);
                  if (!(await sameAt(partName))) refuse("file-replaced");
                  await limits.pause("before-rename");
                  if (!open || limits.signal.aborted) throw new ExportCancelled();
                  return file.rename(partName, name, target);
                })(),
                (op) => {
                  late = op.then(
                    async (didRename) => {
                      if (didRename) atName = name;
                      await cleanUp();
                    },
                    () => undefined,
                  );
                },
              ),
            );
            if (!renamed) continue;
            atName = name;
            await step(async () => {
              await bounded(limits.pause("after-link"));
              const gone = await bounded(awayIn(held));
              if (gone !== null) {
                await cleanUp();
                refuse(gone);
              }
              if (!(await bounded(sameAt(name))) || !(await bounded(holdsWritten()))) {
                await cleanUp();
                refuse("file-replaced");
              }
            });
            if (limits.signal.aborted) {
              await cleanUp();
              throw new ExportCancelled();
            }
            close();
            await ended().catch(() => undefined);
            return name;
          }
          return refuse("name-taken");
        },
        discard: async () => {
          if (late === null) return cleanUp();
          const settled = late.then(cleanUp);
          settled.catch(() => undefined);
          return undefined;
        },
        unconfirmed: () => false,
        route: () => route,
      };
    };

    /** Creates `<name>.har.part` exclusively inside `held`, taking ownership of `held`. */
    const namedPart = async (
      held: HeldFolder,
      planned: string,
      journal: PartJournal,
      route: ExportRoute,
    ): Promise<{ readonly part: Part; readonly path: string }> => {
      try {
        for (let n = 1; n <= NAME_TRIES; n += 1) {
          if (limits.signal.aborted) throw new ExportCancelled();
          const name = numbered(planned, n);
          const partName = `${name}${PART_SUFFIX}`;
          const partPath = platform.join(folder, partName);
          const file = await step(async () => {
            const gone = await bounded(awayIn(held));
            if (gone !== null) refuse(gone);
            return bounded(held.createNamedPart(partName, partPath));
          });
          if (file === null) continue;
          const gone = await step(() => bounded(awayIn(held))).catch(async (error: unknown) => {
            await file.discard(partName).catch(() => undefined);
            throw error;
          });
          if (gone !== null) {
            await file.discard(partName).catch(() => undefined);
            refuse(gone);
          }
          return {
            part: heldNamedPart(held, file, partName, partPath, journal, route),
            path: partPath,
          };
        }
        return refuse("name-taken");
      } catch (error) {
        held.close();
        throw error;
      }
    };

    /**
     * The export's file, unnamed in the held folder until one link names it (Linux). Nothing here renames or deletes:
     * a failure before the link closes the file and it is gone. A link the platform cannot make moves the bytes to a
     * named part inside the same held folder.
     */
    const unnamedPart = (held: HeldFolder, file: UnnamedFile, journal: PartJournal): Part => {
      let written = 0;
      let head = "";
      let open = true;
      /** Linked under a name that the checks after the link did not prove. */
      let unproved = false;
      /** The named part the bytes moved to, once the link could not be made. */
      let moved: Part | null = null;
      const closeFile = (): void => {
        file.close();
      };
      const close = (): void => {
        if (!open) return;
        open = false;
        closeFile();
        held.close();
      };
      const holdsWritten = async (): Promise<boolean> =>
        (await file.size()) === written && sameBytes(await file.read(0, head.length), head);
      const provenNamed = (name: string) => async (): Promise<void> => {
        await bounded(limits.pause("after-link"));
        const gone = await bounded(awayIn(held));
        if (gone !== null) refuse(gone);
        if (!sameIdentity(await bounded(held.identityOf(name)), file.identity))
          refuse("file-replaced");
        if (!(await bounded(holdsWritten()))) refuse("file-replaced");
      };
      /**
       * Copies the whole file, as written, to a new named part in the same held folder, which then finishes once its
       * length and SHA-256 are the unnamed file's, each read back on its own.
       */
      const toNamed = async (planned: string, route: ExportRoute): Promise<string> => {
        const { part } = await namedPart(held, planned, journal, route);
        moved = part;
        for (let offset = 0; offset < written;) {
          if (limits.signal.aborted) throw new ExportCancelled();
          const at = offset;
          const chunk = await step(() => bounded(file.readText(at, COPY_BYTES)));
          if (chunk.bytes === 0) refuse("file-replaced");
          await part.append(chunk.text, chunk.bytes);
          offset += chunk.bytes;
        }
        const source = await digestOf((at) => file.read(at, COPY_BYTES));
        if (open) {
          open = false;
          closeFile();
        }
        return part.finish(planned, source);
      };
      return {
        append: async (text, needBytes) => {
          const first = written === 0;
          await step(async () => {
            if (first) head = asciiPrefix(text, HEAD_BYTES);
            await bounded(file.write(text));
            written += needBytes;
            if (first && !(await bounded(holdsWritten()))) refuse("file-replaced");
          }, needBytes);
        },
        finish: async (planned) => {
          await step(async () => {
            if (!(await bounded(holdsWritten()))) refuse("file-replaced");
            const gone = await bounded(awayIn(held));
            if (gone !== null) refuse(gone);
          });
          for (let n = 1; n <= NAME_TRIES; n += 1) {
            if (limits.signal.aborted) throw new ExportCancelled();
            const name = numbered(planned, n);
            const linked = await step(() =>
              bounded(
                limits.pause("before-link").then(() => {
                  // A step that timed out or a cancel while held never names the file afterwards.
                  if (!open || limits.signal.aborted) throw new ExportCancelled();
                  return file.link(name).catch((error: unknown): ExportRoute => {
                    const errno = errorName(error) ?? "";
                    if (!Object.hasOwn(LINK_FALLBACK, errno)) throw error;
                    return { route: "named", because: LINK_FALLBACK[errno]!, errno };
                  });
                }),
              ),
            );
            if (typeof linked === "object") return toNamed(planned, linked);
            if (!linked) continue;
            unproved = true;
            await step(provenNamed(name));
            unproved = false;
            close();
            return name;
          }
          return refuse("name-taken");
        },
        discard: async () => {
          if (moved !== null) {
            if (open) {
              open = false;
              closeFile();
            }
            await moved.discard();
            return;
          }
          close();
        },
        unconfirmed: () => unproved,
        route: () => moved?.route() ?? { route: "link" },
      };
    };

    /** Holds the folder open and verifies its path still names it; refuses if no atomic primitive exists. */
    const holdFolder = async (): Promise<HeldFolder> => {
      if (platform.holdFolder === undefined) return refuse("no-atomic-rename");
      const held = await step(() => bounded(platform.holdFolder!(folder)));
      const at = await step(() => bounded(held.where())).catch((error: unknown) => {
        held.close();
        throw error;
      });
      if (at !== folder) {
        held.close();
        refuse(at === null ? (folderProblem(folder) ?? "folder-missing") : "folder-refused");
      }
      return held;
    };

    return {
      path: folder,
      createPart: async (planned, journal) => {
        const held = await holdFolder();
        if (platform.preferNamed !== undefined) {
          return namedPart(held, planned, journal, {
            route: "named",
            because: platform.preferNamed,
          });
        }
        const made = await step(() => bounded(held.createUnnamed())).catch((error: unknown) => {
          held.close();
          throw error;
        });
        if ("file" in made) return { part: unnamedPart(held, made.file, journal), path: folder };
        return namedPart(held, planned, journal, {
          route: "named",
          because: made.refused,
          errno: made.errno,
        });
      },
    };
  };

  return { openFolder };
}

export type PartSink = HarSink & {
  /** Writes what is still batched. Throws WriteRefused like `write`. */
  readonly close: () => Promise<void>;
};

/**
 * The export's sink. A refused append is the only failure that fails an export: `append` throws WriteRefused with
 * the bytes it needed, and nothing after it is written. The first piece, the document's opening with the export's
 * random id, is appended alone and at once, so the part is journaled before the rest is written.
 */
export function createPartSink(
  append: (text: string, needBytes: number) => Promise<void>,
  onBytes: (bytes: ByteCount) => void,
): PartSink {
  let pending: string[] = [];
  let pendingUnits = 0;
  let pendingBytes = 0;
  let written = 0;
  let opened = false;
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const text = pending.join("");
    const needBytes = pendingBytes;
    pending = [];
    pendingUnits = 0;
    pendingBytes = 0;
    await append(text, needBytes);
    written += needBytes;
    onBytes(written as ByteCount);
  };
  return {
    write: async (text) => {
      pending.push(text);
      pendingUnits += text.length;
      pendingBytes += utf8Length(text);
      if (opened && pendingUnits < SINK_BATCH_UNITS) return;
      opened = true;
      await flush();
    },
    bytesWritten: () => (written + pendingBytes) as ByteCount,
    close: flush,
  };
}

/** One line of `exports.jsonl` in the archive. */
export type JournalEntry =
  | { readonly started: string; readonly head: string }
  | { readonly ended: string }
  | { readonly discardFailed: string; readonly reason: string };

export const journalLine = (entry: JournalEntry): string => `${JSON.stringify(entry)}\n`;

/** A part the journal says started and never ended, with the first bytes that prove a file at its path is it. */
export interface JournaledPart {
  readonly path: string;
  readonly head: string;
}

/**
 * Started and never ended, so left by a crash. Only `.har.part` paths with a head are listed: a damaged line cannot
 * name another file, and a line with no head proves nothing about the file at its path.
 */
export const unfinishedExports = (journal: string): readonly JournaledPart[] => {
  const open = new Map<string, string>();
  for (const line of journal.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { started, head, ended } = parsed as {
      started?: unknown;
      head?: unknown;
      ended?: unknown;
    };
    if (
      typeof started === "string" &&
      started.endsWith(`.har${PART_SUFFIX}`) &&
      typeof head === "string" &&
      head.length > 0
    )
      open.set(started, head);
    if (typeof ended === "string") open.delete(ended);
  }
  return [...open].map(([path, head]) => ({ path, head }));
};
