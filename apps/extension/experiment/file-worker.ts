// The export's native file calls, in a ChromeWorker so none of them can stall the parent's main thread: libc,
// libSystem, or kernel32 through js-ctypes. A folder is held open and verified through its handle/descriptor; finishing
// uses an atomic no-replace primitive (linkat/renameat2 on Linux, renameatx_np on macOS, FileRenameInfo with
// ReplaceIfExists = FALSE on Windows). Nothing ever falls back to check-then-rename.

import { wholeSequences } from "./whole-utf8.ts";

/** The js-ctypes surface this worker uses. */
interface CCharArray {
  addressOfElement(index: number): unknown;
  readString(): string;
}
interface CCharArrayType {
  (init?: string): CCharArray;
}
interface CDataBox {
  readonly value: unknown;
  address(): unknown;
}
interface CStructInstance {
  address(): unknown;
}
interface CStructType {
  readonly size: number;
  readonly ptr: CType;
  (init?: Record<string, unknown>): CStructInstance;
}
interface CType {
  (value: number): CDataBox;
  readonly ptr: CType;
  readonly size?: number;
  array?(length?: number): CCharArrayType;
}
interface CFunction {
  (...args: readonly unknown[]): number | { toString(): string };
}
interface CLibrary {
  declare(
    name: string,
    abi: unknown,
    returns: CType,
    ...args: readonly (CType | "...")[]
  ): CFunction;
}
declare const ctypes: {
  readonly default_abi: unknown;
  readonly winapi_abi?: unknown;
  readonly int: CType;
  readonly unsigned_int: CType;
  readonly uint16_t: CType;
  readonly int32_t: CType;
  readonly uint32_t: CType;
  readonly size_t: CType;
  readonly ssize_t: CType;
  readonly int64_t: CType;
  readonly intptr_t: CType;
  readonly char: CType;
  readonly jschar: CType;
  readonly voidptr_t: CType;
  readonly StructType: (name: string, fields: readonly Record<string, unknown>[]) => CStructType;
  readonly errno: number;
  readonly winLastError?: number;
  open(name: string): CLibrary;
};
declare function postMessage(message: unknown): void;
/** A worker has these; the parent script's sandbox does not, so the worker encodes. */
declare class TextEncoder {
  encode(text: string): Uint8Array;
}
declare class TextDecoder {
  decode(bytes: Uint8Array): string;
}

export type WorkerPlatform = "linux" | "win" | "macosx";
export type WorkerArch = "x86-64" | "aarch64";

const LINUX_ARCH_FLAGS: {
  readonly [A in WorkerArch]: { readonly directory: number; readonly noFollow: number };
} = {
  "x86-64": { directory: 0o200000, noFollow: 0o400000 },
  aarch64: { directory: 0o40000, noFollow: 0o100000 },
};

const O_RDONLY = 0;
const O_RDWR = 2;
const LINUX_O_CREAT = 0o100;
const LINUX_O_EXCL = 0o200;
const LINUX_O_CLOEXEC = 0o2000000;
const LINUX_O_TMPFILE_BIT = 0o20000000;
const LINUX_AT_FDCWD = -100;
const LINUX_AT_SYMLINK_NOFOLLOW = 0x100;
const LINUX_AT_SYMLINK_FOLLOW = 0x400;
const LINUX_AT_EMPTY_PATH = 0x1000;
const STATX_BASIC = 0x7ff;
const RENAME_NOREPLACE = 1;

const MAC_O_CREAT = 0x0200;
const MAC_O_EXCL = 0x0800;
const MAC_O_NOFOLLOW = 0x0100;
const MAC_O_DIRECTORY = 0x00100000;
const MAC_O_CLOEXEC = 0x01000000;
const MAC_AT_FDCWD = -2;
const MAC_AT_SYMLINK_NOFOLLOW = 0x0020;
const MAC_RENAME_EXCL = 0x00000004;
const MAC_F_GETPATH = 50;
const MAC_MAXPATHLEN = 1024;

const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const LINUX_ERRNO: { readonly [code: number]: string } = {
  1: "EPERM",
  2: "ENOENT",
  5: "EIO",
  9: "EBADF",
  12: "ENOMEM",
  13: "EACCES",
  14: "EFAULT",
  17: "EEXIST",
  18: "EXDEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  24: "EMFILE",
  27: "EFBIG",
  28: "ENOSPC",
  30: "EROFS",
  31: "EMLINK",
  36: "ENAMETOOLONG",
  38: "ENOSYS",
  40: "ELOOP",
  95: "EOPNOTSUPP",
  122: "EDQUOT",
};

const MAC_ERRNO: { readonly [code: number]: string } = {
  1: "EPERM",
  2: "ENOENT",
  5: "EIO",
  9: "EBADF",
  12: "ENOMEM",
  13: "EACCES",
  14: "EFAULT",
  17: "EEXIST",
  18: "EXDEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  24: "EMFILE",
  27: "EFBIG",
  28: "ENOSPC",
  30: "EROFS",
  31: "EMLINK",
  45: "ENOTSUP",
  62: "ELOOP",
  63: "ENAMETOOLONG",
  69: "EDQUOT",
  78: "ENOSYS",
  102: "EOPNOTSUPP",
};

const WIN_ERRNO: { readonly [code: number]: string } = {
  1: "ENOTSUP",
  2: "ENOENT",
  3: "ENOENT",
  5: "EACCES",
  6: "EBADF",
  8: "ENOMEM",
  14: "ENOMEM",
  17: "EXDEV",
  19: "EROFS",
  23: "EIO",
  32: "EACCES",
  33: "EACCES",
  39: "ENOSPC",
  50: "ENOTSUP",
  80: "EEXIST",
  87: "EINVAL",
  112: "ENOSPC",
  123: "ENAMETOOLONG",
  183: "EEXIST",
  206: "ENAMETOOLONG",
  267: "ENOTDIR",
  1117: "EIO",
  1921: "ELOOP",
};

/** Reported when the OS or filesystem refuses an atomic no-replace rename. */
const NO_ATOMIC_RENAME = "NO_ATOMIC_RENAME";
/** Errno names indicating the kernel or filesystem has no atomic no-replace rename. */
const UNSUPPORTED_ATOMIC_ERRNOS = new Set(["ENOSYS", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * The answer when `/proc/self/fd/<n>` does not lead to the descriptor's own file (no /proc, or it is masked), so this
 * process cannot link the file there. Not an errno: the export takes the named route instead.
 */
const FD_LINK_UNAVAILABLE = "fd-link-unavailable";

/** A file's identity: device/volume and inode/file-index. */
export interface Identity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "file" | "folder" | "link" | "other";
}

export type WorkerRequest =
  | {
      readonly id: number;
      readonly op: "init";
      readonly platform: WorkerPlatform;
      readonly arch: WorkerArch;
    }
  | { readonly id: number; readonly op: "hold-folder"; readonly path: string }
  | { readonly id: number; readonly op: "where"; readonly fd: number; readonly expected: string }
  | { readonly id: number; readonly op: "create"; readonly folder: number; readonly mode: number }
  | {
      readonly id: number;
      readonly op: "create-part";
      readonly folder: number;
      readonly path: string;
      readonly name: string;
      readonly mode: number;
    }
  | { readonly id: number; readonly op: "fd-link"; readonly fd: number }
  | { readonly id: number; readonly op: "write"; readonly fd: number; readonly text: string }
  | { readonly id: number; readonly op: "identity"; readonly fd: number }
  | {
      readonly id: number;
      readonly op: "identity-at";
      readonly folder: number;
      readonly folderPath: string;
      readonly name: string;
    }
  | { readonly id: number; readonly op: "size"; readonly fd: number }
  | {
      readonly id: number;
      readonly op: "read";
      readonly fd: number;
      readonly offset: number;
      readonly bytes: number;
    }
  | {
      readonly id: number;
      readonly op: "read-text";
      readonly fd: number;
      readonly offset: number;
      readonly bytes: number;
    }
  | {
      readonly id: number;
      readonly op: "link";
      readonly fd: number;
      readonly folder: number;
      readonly name: string;
    }
  | {
      readonly id: number;
      readonly op: "rename-part";
      readonly fd: number;
      readonly folder: number;
      readonly fromName: string;
      readonly toName: string;
      readonly toPath: string;
    }
  | {
      readonly id: number;
      readonly op: "discard-part";
      readonly fd: number;
      readonly folder: number;
      readonly name: string;
    }
  | { readonly id: number; readonly op: "close"; readonly fd: number };

export type WorkerAnswer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly errno: string };

/** A failed call: the errno's name, or the code when the table has none. */
class Errno extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface StatResult {
  readonly identity: Identity;
  readonly size: number;
  readonly links: number;
}

interface Backend {
  readonly holdFolder: (path: string) => { readonly fd: number; readonly identity: Identity };
  readonly where: (fd: number, expected: string) => string | null;
  readonly createUnnamed: (
    folder: number,
    mode: number,
  ) => { readonly fd: number; readonly identity: Identity };
  readonly createPart: (
    folder: number,
    path: string,
    name: string,
    mode: number,
  ) => { readonly fd: number; readonly identity: Identity } | null;
  readonly fdLink: (fd: number) => boolean;
  readonly write: (fd: number, text: string) => number;
  readonly identity: (fd: number) => Identity;
  readonly identityAt: (folder: number, folderPath: string, name: string) => Identity | null;
  readonly size: (fd: number) => number;
  readonly read: (fd: number, offset: number, bytes: number) => ArrayBuffer;
  readonly readText: (
    fd: number,
    offset: number,
    bytes: number,
  ) => { readonly text: string; readonly bytes: number };
  readonly link: (fd: number, folder: number, name: string) => boolean;
  readonly renamePart: (
    fd: number,
    folder: number,
    fromName: string,
    toName: string,
    toPath: string,
  ) => boolean;
  readonly discardPart: (fd: number, folder: number, name: string) => number;
  readonly close: (fd: number) => number;
}

const kindOf = (mode: number): Identity["kind"] => {
  const type = mode & S_IFMT;
  if (type === S_IFREG) return "file";
  if (type === S_IFDIR) return "folder";
  return type === S_IFLNK ? "link" : "other";
};

const sameFile = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;

const failErrno = (table: { readonly [code: number]: string }): never => {
  const code = ctypes.errno;
  throw new Errno(table[code] ?? `errno ${String(code)}`);
};

const checkedPosix = (
  result: number | { toString(): string },
  table: { readonly [code: number]: string },
): number => {
  const value = Number(result);
  return value < 0 ? failErrno(table) : value;
};

function createLinuxBackend(arch: WorkerArch): Backend {
  const libc = ctypes.open("libc.so.6");
  const { int, unsigned_int: uint, size_t, ssize_t, int64_t, voidptr_t: voidp } = ctypes;
  const cstring = ctypes.char.ptr;
  const abi = ctypes.default_abi;
  const call = {
    openat: libc.declare("openat", abi, int, int, cstring, int, uint),
    linkat: libc.declare("linkat", abi, int, int, cstring, int, cstring, int),
    renameat2: libc.declare("renameat2", abi, int, int, cstring, int, cstring, uint),
    unlinkat: libc.declare("unlinkat", abi, int, int, cstring, int),
    write: libc.declare("write", abi, ssize_t, int, voidp, size_t),
    pread: libc.declare("pread", abi, ssize_t, int, voidp, size_t, int64_t),
    close: libc.declare("close", abi, int, int),
    statx: libc.declare("statx", abi, int, int, cstring, int, uint, voidp),
    readlink: libc.declare("readlink", abi, ssize_t, cstring, voidp, size_t),
  };
  const { directory, noFollow } = LINUX_ARCH_FLAGS[arch];
  const checked = (result: number | { toString(): string }): number =>
    checkedPosix(result, LINUX_ERRNO);
  const statx = (dirfd: number, name: string, atFlags: number): StatResult | null => {
    const buffer = new ArrayBuffer(256);
    if (Number(call.statx(dirfd, name, atFlags, STATX_BASIC, buffer)) !== 0) {
      if (ctypes.errno === 2) return null;
      failErrno(LINUX_ERRNO);
    }
    const view = new DataView(buffer);
    return {
      identity: {
        dev: `${String(view.getUint32(136, true))}:${String(view.getUint32(140, true))}`,
        ino: String(view.getBigUint64(32, true)),
        kind: kindOf(view.getUint16(28, true)),
      },
      size: Number(view.getBigUint64(40, true)),
      links: view.getUint32(16, true),
    };
  };
  const ofDescriptor = (fd: number): StatResult => {
    const found = statx(fd, "", LINUX_AT_EMPTY_PATH);
    if (found === null) throw new Errno("EBADF");
    return found;
  };
  const fdLink = (fd: number): string => `/proc/self/fd/${String(fd)}`;
  const linkable = (fd: number): boolean => {
    try {
      const through = statx(LINUX_AT_FDCWD, fdLink(fd), 0);
      return through !== null && sameFile(through.identity, ofDescriptor(fd).identity);
    } catch {
      return false;
    }
  };
  return {
    holdFolder: (path) => {
      const fd = checked(
        call.openat(LINUX_AT_FDCWD, path, O_RDONLY | directory | noFollow | LINUX_O_CLOEXEC, 0),
      );
      return { fd, identity: ofDescriptor(fd).identity };
    },
    where: (fd, expected) => {
      const buffer = new Uint8Array(4096);
      const length = Number(call.readlink(fdLink(fd), buffer, buffer.length));
      if (length >= 0) {
        const path = new TextDecoder().decode(buffer.subarray(0, length));
        return path.endsWith(" (deleted)") ? null : path;
      }
      const held = ofDescriptor(fd);
      if (held.links === 0) return null;
      const there = statx(LINUX_AT_FDCWD, expected, LINUX_AT_SYMLINK_NOFOLLOW);
      return there !== null && sameFile(there.identity, held.identity) ? expected : "";
    },
    createUnnamed: (folder, mode) => {
      const fd = checked(
        call.openat(folder, ".", LINUX_O_TMPFILE_BIT | directory | O_RDWR | LINUX_O_CLOEXEC, mode),
      );
      return { fd, identity: ofDescriptor(fd).identity };
    },
    createPart: (folder, _path, name, mode) => {
      const fd = Number(
        call.openat(folder, name, O_RDWR | LINUX_O_CREAT | LINUX_O_EXCL | LINUX_O_CLOEXEC, mode),
      );
      if (fd < 0) {
        if (ctypes.errno === 17) return null;
        failErrno(LINUX_ERRNO);
      }
      return { fd, identity: ofDescriptor(fd).identity };
    },
    fdLink: linkable,
    write: (fd, text) => {
      const all = new TextEncoder().encode(text);
      let done = 0;
      while (done < all.length) {
        const rest = all.subarray(done);
        done += checked(call.write(fd, rest, rest.length));
      }
      return done;
    },
    identity: (fd) => ofDescriptor(fd).identity,
    identityAt: (folder, _folderPath, name) =>
      statx(folder, name, LINUX_AT_SYMLINK_NOFOLLOW)?.identity ?? null,
    size: (fd) => ofDescriptor(fd).size,
    read: (fd, offset, bytes) => {
      const buffer = new Uint8Array(bytes);
      let read = 0;
      while (read < bytes) {
        const rest = buffer.subarray(read);
        const got = checked(call.pread(fd, rest, rest.length, offset + read));
        if (got === 0) break;
        read += got;
      }
      return buffer.slice(0, read).buffer;
    },
    readText: (fd, offset, bytes) => {
      const buffer = new Uint8Array(bytes);
      const read = checked(call.pread(fd, buffer, bytes, offset));
      const whole = read < bytes ? read : wholeSequences(buffer, read);
      return { text: new TextDecoder().decode(buffer.subarray(0, whole)), bytes: whole };
    },
    link: (fd, folder, name) => {
      if (
        Number(call.linkat(LINUX_AT_FDCWD, fdLink(fd), folder, name, LINUX_AT_SYMLINK_FOLLOW)) === 0
      )
        return true;
      const code = ctypes.errno;
      if (code === 17) return false;
      // A failed link through a /proc that no longer leads to the file is that, whatever errno it gave.
      if (!linkable(fd)) throw new Errno(FD_LINK_UNAVAILABLE);
      throw new Errno(LINUX_ERRNO[code] ?? `errno ${String(code)}`);
    },
    renamePart: (_fd, folder, fromName, toName) => {
      if (Number(call.renameat2(folder, fromName, folder, toName, RENAME_NOREPLACE)) === 0)
        return true;
      const code = ctypes.errno;
      if (code === 17) return false;
      const name = LINUX_ERRNO[code];
      if (name !== undefined && UNSUPPORTED_ATOMIC_ERRNOS.has(name))
        throw new Errno(NO_ATOMIC_RENAME);
      throw new Errno(name ?? `errno ${String(code)}`);
    },
    discardPart: (fd, folder, name) => {
      try {
        const expected = ofDescriptor(fd).identity;
        const there = statx(folder, name, LINUX_AT_SYMLINK_NOFOLLOW);
        if (
          there !== null &&
          there.identity.kind === "file" &&
          sameFile(there.identity, expected)
        ) {
          if (Number(call.unlinkat(folder, name, 0)) !== 0 && ctypes.errno !== 2)
            failErrno(LINUX_ERRNO);
        }
      } finally {
        call.close(fd);
      }
      return 0;
    },
    close: (fd) => checked(call.close(fd)),
  };
}

function createMacosBackend(arch: WorkerArch): Backend {
  const lib = ctypes.open("libSystem.B.dylib");
  const { int, unsigned_int: uint, size_t, ssize_t, int64_t, voidptr_t: voidp } = ctypes;
  const cstring = ctypes.char.ptr;
  const abi = ctypes.default_abi;
  // On x86-64 Darwin, 64-bit inode stat symbols carry the $INODE64 suffix; on arm64 they do not.
  const fstatSym = arch === "x86-64" ? "fstat$INODE64" : "fstat";
  const fstatatSym = arch === "x86-64" ? "fstatat$INODE64" : "fstatat";
  const call = {
    openat: lib.declare("openat", abi, int, int, cstring, int, "..."),
    renameatx_np: lib.declare("renameatx_np", abi, int, int, cstring, int, cstring, uint),
    unlinkat: lib.declare("unlinkat", abi, int, int, cstring, int),
    write: lib.declare("write", abi, ssize_t, int, voidp, size_t),
    pread: lib.declare("pread", abi, ssize_t, int, voidp, size_t, int64_t),
    close: lib.declare("close", abi, int, int),
    fstat: lib.declare(fstatSym, abi, int, int, voidp),
    fstatat: lib.declare(fstatatSym, abi, int, int, cstring, voidp, int),
    fcntl: lib.declare("fcntl", abi, int, int, int, "..."),
  };
  const checked = (result: number | { toString(): string }): number =>
    checkedPosix(result, MAC_ERRNO);
  const parseStat = (buffer: ArrayBuffer): StatResult => {
    const view = new DataView(buffer);
    return {
      identity: {
        dev: String(view.getInt32(0, true)),
        ino: String(view.getBigUint64(8, true)),
        kind: kindOf(view.getUint16(4, true)),
      },
      size: Number(view.getBigInt64(96, true)),
      links: view.getUint16(6, true),
    };
  };
  const ofDescriptor = (fd: number): StatResult => {
    const buffer = new ArrayBuffer(144);
    if (Number(call.fstat(fd, buffer)) !== 0) failErrno(MAC_ERRNO);
    return parseStat(buffer);
  };
  const statAt = (dirfd: number, name: string, atFlags: number): StatResult | null => {
    const buffer = new ArrayBuffer(144);
    if (Number(call.fstatat(dirfd, name, buffer, atFlags)) !== 0) {
      if (ctypes.errno === 2) return null;
      failErrno(MAC_ERRNO);
    }
    return parseStat(buffer);
  };
  return {
    holdFolder: (path) => {
      const fd = checked(
        call.openat(
          MAC_AT_FDCWD,
          path,
          O_RDONLY | MAC_O_DIRECTORY | MAC_O_NOFOLLOW | MAC_O_CLOEXEC,
        ),
      );
      return { fd, identity: ofDescriptor(fd).identity };
    },
    where: (fd, expected) => {
      const held = ofDescriptor(fd);
      if (held.links === 0) return null;
      const there = statAt(MAC_AT_FDCWD, expected, MAC_AT_SYMLINK_NOFOLLOW);
      if (there !== null && sameFile(there.identity, held.identity)) return expected;
      const pathType = ctypes.char.array?.(MAC_MAXPATHLEN);
      if (pathType === undefined) return "";
      const buffer = pathType();
      if (Number(call.fcntl(fd, MAC_F_GETPATH, buffer.addressOfElement(0))) < 0) return null;
      const actual = buffer.readString();
      const atActual =
        actual.length > 0 ? statAt(MAC_AT_FDCWD, actual, MAC_AT_SYMLINK_NOFOLLOW) : null;
      return atActual !== null && sameFile(atActual.identity, held.identity) ? actual : null;
    },
    createUnnamed: () => {
      throw new Errno("EOPNOTSUPP");
    },
    createPart: (folder, _path, name, mode) => {
      const fd = Number(
        call.openat(folder, name, O_RDWR | MAC_O_CREAT | MAC_O_EXCL | MAC_O_CLOEXEC, uint(mode)),
      );
      if (fd < 0) {
        if (ctypes.errno === 17) return null;
        failErrno(MAC_ERRNO);
      }
      return { fd, identity: ofDescriptor(fd).identity };
    },
    fdLink: () => false,
    write: (fd, text) => {
      const all = new TextEncoder().encode(text);
      let done = 0;
      while (done < all.length) {
        const rest = all.subarray(done);
        done += checked(call.write(fd, rest, rest.length));
      }
      return done;
    },
    identity: (fd) => ofDescriptor(fd).identity,
    identityAt: (folder, _folderPath, name) =>
      statAt(folder, name, MAC_AT_SYMLINK_NOFOLLOW)?.identity ?? null,
    size: (fd) => ofDescriptor(fd).size,
    read: (fd, offset, bytes) => {
      const buffer = new Uint8Array(bytes);
      let read = 0;
      while (read < bytes) {
        const rest = buffer.subarray(read);
        const got = checked(call.pread(fd, rest, rest.length, offset + read));
        if (got === 0) break;
        read += got;
      }
      return buffer.slice(0, read).buffer;
    },
    readText: (fd, offset, bytes) => {
      const buffer = new Uint8Array(bytes);
      const read = checked(call.pread(fd, buffer, bytes, offset));
      const whole = read < bytes ? read : wholeSequences(buffer, read);
      return { text: new TextDecoder().decode(buffer.subarray(0, whole)), bytes: whole };
    },
    link: () => {
      throw new Errno("EOPNOTSUPP");
    },
    renamePart: (_fd, folder, fromName, toName) => {
      if (Number(call.renameatx_np(folder, fromName, folder, toName, MAC_RENAME_EXCL)) === 0)
        return true;
      const code = ctypes.errno;
      if (code === 17) return false;
      const name = MAC_ERRNO[code];
      if (name !== undefined && UNSUPPORTED_ATOMIC_ERRNOS.has(name))
        throw new Errno(NO_ATOMIC_RENAME);
      throw new Errno(name ?? `errno ${String(code)}`);
    },
    discardPart: (fd, folder, name) => {
      try {
        const expected = ofDescriptor(fd).identity;
        const there = statAt(folder, name, MAC_AT_SYMLINK_NOFOLLOW);
        if (
          there !== null &&
          there.identity.kind === "file" &&
          sameFile(there.identity, expected)
        ) {
          if (Number(call.unlinkat(folder, name, 0)) !== 0 && ctypes.errno !== 2)
            failErrno(MAC_ERRNO);
        }
      } finally {
        call.close(fd);
      }
      return 0;
    },
    close: (fd) => checked(call.close(fd)),
  };
}

function toWinExtendedPath(path: string): string {
  const normalized = path.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) return normalized;
  if (normalized.startsWith("\\\\")) return `\\\\?\\UNC\\${normalized.slice(2)}`;
  return `\\\\?\\${normalized}`;
}

function createWindowsBackend(): Backend {
  const k32 = ctypes.open("kernel32.dll");
  const ntdll = ctypes.open("ntdll.dll");
  const abi = ctypes.winapi_abi ?? ctypes.default_abi;
  const { uint16_t, int32_t, uint32_t, int64_t, intptr_t, voidptr_t: voidp } = ctypes;
  const wstring = ctypes.jschar.ptr;
  const ptrSize = ctypes.voidptr_t.size ?? 8;

  const UNICODE_STRING = ctypes.StructType("UNICODE_STRING", [
    { Length: uint16_t },
    { MaximumLength: uint16_t },
    { Buffer: wstring },
  ]);
  const OBJECT_ATTRIBUTES = ctypes.StructType("OBJECT_ATTRIBUTES", [
    { Length: uint32_t },
    { RootDirectory: intptr_t },
    { ObjectName: UNICODE_STRING.ptr },
    { Attributes: uint32_t },
    { SecurityDescriptor: voidp },
    { SecurityQualityOfService: voidp },
  ]);

  const FILE_LIST_DIRECTORY = 0x0001;
  const FILE_TRAVERSE = 0x0020;
  const FILE_READ_ATTRIBUTES = 0x0080;
  const GENERIC_READ = 0x80000000;
  const GENERIC_WRITE = 0x40000000;
  const DELETE = 0x00010000;
  const SYNCHRONIZE = 0x00100000;
  const FILE_SHARE_ALL = 0x00000007;
  const OPEN_EXISTING = 3;
  const FILE_OPEN = 1;
  const FILE_CREATE = 2;
  const FILE_ATTRIBUTE_DIRECTORY = 0x0010;
  const FILE_ATTRIBUTE_NORMAL = 0x0080;
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;
  const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  const FILE_NON_DIRECTORY_FILE = 0x00000040;
  const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const FILE_OPEN_REPARSE_POINT = 0x00200000;
  const OBJ_CASE_INSENSITIVE = 0x00000040;
  const FILE_BEGIN = 0;
  const FILE_END = 2;
  const FILE_STANDARD_INFO = 1;
  const FILE_DISPOSITION_INFO = 4;
  const FILE_DISPOSITION_INFO_EX = 21;
  const FILE_RENAME_INFORMATION = 10;
  const FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
  const FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
  const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
  const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
  const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
  const STATUS_DELETE_PENDING = 0xc0000056;

  const call = {
    CreateFileW: k32.declare(
      "CreateFileW",
      abi,
      intptr_t,
      wstring,
      uint32_t,
      uint32_t,
      voidp,
      uint32_t,
      uint32_t,
      intptr_t,
    ),
    CloseHandle: k32.declare("CloseHandle", abi, int32_t, intptr_t),
    WriteFile: k32.declare("WriteFile", abi, int32_t, intptr_t, voidp, uint32_t, voidp, voidp),
    ReadFile: k32.declare("ReadFile", abi, int32_t, intptr_t, voidp, uint32_t, voidp, voidp),
    SetFilePointerEx: k32.declare(
      "SetFilePointerEx",
      abi,
      int32_t,
      intptr_t,
      int64_t,
      voidp,
      uint32_t,
    ),
    GetFileSizeEx: k32.declare("GetFileSizeEx", abi, int32_t, intptr_t, voidp),
    GetFileInformationByHandle: k32.declare(
      "GetFileInformationByHandle",
      abi,
      int32_t,
      intptr_t,
      voidp,
    ),
    GetFileInformationByHandleEx: k32.declare(
      "GetFileInformationByHandleEx",
      abi,
      int32_t,
      intptr_t,
      int32_t,
      voidp,
      uint32_t,
    ),
    SetFileInformationByHandle: k32.declare(
      "SetFileInformationByHandle",
      abi,
      int32_t,
      intptr_t,
      int32_t,
      voidp,
      uint32_t,
    ),
    NtCreateFile: ntdll.declare(
      "NtCreateFile",
      abi,
      int32_t,
      voidp,
      uint32_t,
      voidp,
      voidp,
      voidp,
      uint32_t,
      uint32_t,
      uint32_t,
      uint32_t,
      voidp,
      uint32_t,
    ),
    NtSetInformationFile: ntdll.declare(
      "NtSetInformationFile",
      abi,
      int32_t,
      intptr_t,
      voidp,
      voidp,
      uint32_t,
      int32_t,
    ),
    RtlNtStatusToDosError: ntdll.declare("RtlNtStatusToDosError", abi, uint32_t, int32_t),
  };

  const handles = new Map<number, unknown>();
  let nextHandleId = 1;
  const registerHandle = (handle: unknown): number => {
    const id = nextHandleId;
    nextHandleId += 1;
    handles.set(id, handle);
    return id;
  };
  const lookup = (fd: number): unknown => {
    const handle = handles.get(fd);
    if (handle === undefined) throw new Errno("EBADF");
    return handle;
  };
  const lastWinError = (): number => ctypes.winLastError ?? 0;
  const failWinCode = (code: number): never => {
    throw new Errno(WIN_ERRNO[code] ?? `winerr ${String(code)}`);
  };
  const failWin = (): never => failWinCode(lastWinError());
  const failNtStatus = (status: number): never => {
    const code = Number(call.RtlNtStatusToDosError(status | 0));
    return failWinCode(code);
  };
  const isInvalidHandle = (handle: number | { toString(): string }): boolean =>
    handle.toString() === "-1";

  const infoOfHandle = (
    handle: unknown,
  ): { readonly identity: Identity; readonly links: number } => {
    const buffer = new ArrayBuffer(52);
    if (Number(call.GetFileInformationByHandle(handle, buffer)) === 0) failWin();
    const view = new DataView(buffer);
    const attrs = view.getUint32(0, true);
    const vol = view.getUint32(28, true);
    const links = view.getUint32(40, true);
    const idxHigh = view.getUint32(44, true);
    const idxLow = view.getUint32(48, true);
    const fileIndex = (BigInt(idxHigh) << 32n) | BigInt(idxLow);
    const kind: Identity["kind"] =
      (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        ? "link"
        : (attrs & FILE_ATTRIBUTE_DIRECTORY) !== 0
          ? "folder"
          : "file";
    return {
      identity: { dev: String(vol), ino: fileIndex.toString(), kind },
      links,
    };
  };

  const isDeletePending = (handle: unknown): boolean => {
    const buffer = new ArrayBuffer(24);
    if (Number(call.GetFileInformationByHandleEx(handle, FILE_STANDARD_INFO, buffer, 24)) === 0)
      return false;
    return new DataView(buffer).getUint8(20) !== 0;
  };

  const assertBareName = (name: string): void => {
    if (name.length === 0 || name.includes("\\") || name.includes("/")) {
      throw new Errno("EINVAL");
    }
  };

  const openNoFollowMeta = (path: string): unknown | null => {
    const handle = call.CreateFileW(
      toWinExtendedPath(path),
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_ALL,
      null,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      0,
    );
    if (isInvalidHandle(handle)) {
      const code = lastWinError();
      if (code === 2 || code === 3) return null;
      failWin();
    }
    return handle;
  };

  const openRelative = (
    dirHandle: unknown,
    name: string,
    desiredAccess: number,
    disposition: number,
    options: number,
  ):
    | { readonly ok: true; readonly handle: unknown }
    | { readonly ok: false; readonly status: number } => {
    assertBareName(name);
    const makeWide = ctypes.jschar.array?.(name.length + 1);
    if (makeWide === undefined) throw new Errno("EINVAL");
    const nameBuf = makeWide(name);
    const ustr = UNICODE_STRING({
      Length: name.length * 2,
      MaximumLength: (name.length + 1) * 2,
      Buffer: nameBuf.addressOfElement(0),
    });
    const oa = OBJECT_ATTRIBUTES({
      Length: OBJECT_ATTRIBUTES.size,
      RootDirectory: dirHandle,
      ObjectName: ustr.address(),
      Attributes: OBJ_CASE_INSENSITIVE,
      SecurityDescriptor: null,
      SecurityQualityOfService: null,
    });
    const iosb = new ArrayBuffer(ptrSize === 8 ? 16 : 8);
    const handleOut = intptr_t(0);
    const status = Number(
      call.NtCreateFile(
        handleOut.address(),
        desiredAccess,
        oa.address(),
        iosb,
        null,
        FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_ALL,
        disposition,
        options,
        null,
        0,
      ),
    );
    if (status < 0) return { ok: false, status: status >>> 0 };
    return { ok: true, handle: handleOut.value };
  };

  type RelativeProbe =
    | { readonly kind: "open"; readonly handle: unknown }
    | { readonly kind: "missing" }
    | { readonly kind: "delete-pending" }
    | { readonly kind: "unknown"; readonly status: number };

  const probeRelativeMeta = (dirHandle: unknown, name: string): RelativeProbe => {
    const res = openRelative(
      dirHandle,
      name,
      FILE_READ_ATTRIBUTES,
      FILE_OPEN,
      FILE_OPEN_REPARSE_POINT,
    );
    if (res.ok) return { kind: "open", handle: res.handle };
    if (res.status === STATUS_OBJECT_NAME_NOT_FOUND || res.status === STATUS_OBJECT_PATH_NOT_FOUND)
      return { kind: "missing" };
    if (res.status === STATUS_DELETE_PENDING) return { kind: "delete-pending" };
    return { kind: "unknown", status: res.status };
  };

  const deleteByHandle = (handle: unknown): void => {
    const ex = new Uint32Array([
      FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    ]);
    if (Number(call.SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_EX, ex, 4)) !== 0)
      return;
    if (isDeletePending(handle)) return;
    const code = lastWinError();
    if (code === 2 || code === 3) return;
    if (code === 1 || code === 50 || code === 87) {
      const disp = new Uint8Array([1]);
      if (Number(call.SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO, disp, 1)) !== 0)
        return;
      if (isDeletePending(handle)) return;
      const fallback = lastWinError();
      if (fallback === 2 || fallback === 3) return;
      failWinCode(fallback);
    }
    failWinCode(code);
  };

  return {
    holdFolder: (path) => {
      const handle = call.CreateFileW(
        toWinExtendedPath(path),
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_ALL,
        null,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        0,
      );
      if (isInvalidHandle(handle)) failWin();
      try {
        const { identity } = infoOfHandle(handle);
        if (identity.kind === "link") throw new Errno("ELOOP");
        if (identity.kind !== "folder") throw new Errno("ENOTDIR");
        return { fd: registerHandle(handle), identity };
      } catch (error) {
        call.CloseHandle(handle);
        throw error;
      }
    },
    where: (fd, expected) => {
      const handle = lookup(fd);
      if (isDeletePending(handle)) return null;
      const held = infoOfHandle(handle);
      if (held.links === 0) return null;
      let thereHandle: unknown | null;
      try {
        thereHandle = openNoFollowMeta(expected);
      } catch {
        return "";
      }
      if (thereHandle === null) return "";
      try {
        if (isDeletePending(thereHandle)) return null;
        const there = infoOfHandle(thereHandle);
        if (there.identity.kind !== "folder") return "";
        return sameFile(there.identity, held.identity) ? expected : "";
      } finally {
        call.CloseHandle(thereHandle);
      }
    },
    createUnnamed: () => {
      throw new Errno("EOPNOTSUPP");
    },
    createPart: (folder, _path, name, _mode) => {
      const res = openRelative(
        lookup(folder),
        name,
        (GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE) >>> 0,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
      );
      if (!res.ok) {
        if (res.status === STATUS_OBJECT_NAME_COLLISION) return null;
        return failNtStatus(res.status);
      }
      const handle = res.handle;
      try {
        const { identity } = infoOfHandle(handle);
        if (identity.kind !== "file") {
          call.CloseHandle(handle);
          return null;
        }
        return { fd: registerHandle(handle), identity };
      } catch (error) {
        call.CloseHandle(handle);
        throw error;
      }
    },
    fdLink: () => false,
    write: (fd, text) => {
      const handle = lookup(fd);
      if (Number(call.SetFilePointerEx(handle, 0, null, FILE_END)) === 0) failWin();
      const all = new TextEncoder().encode(text);
      const writtenOut = new Uint32Array(1);
      let done = 0;
      while (done < all.length) {
        const rest = all.subarray(done);
        if (Number(call.WriteFile(handle, rest, rest.length, writtenOut, null)) === 0) failWin();
        done += writtenOut[0] ?? 0;
      }
      return done;
    },
    identity: (fd) => infoOfHandle(lookup(fd)).identity,
    identityAt: (folder, _folderPath, name) => {
      const probe = probeRelativeMeta(lookup(folder), name);
      if (probe.kind === "missing" || probe.kind === "delete-pending") return null;
      if (probe.kind === "unknown") return failNtStatus(probe.status);
      const handle = probe.handle;
      try {
        if (isDeletePending(handle)) return null;
        return infoOfHandle(handle).identity;
      } finally {
        call.CloseHandle(handle);
      }
    },
    size: (fd) => {
      const buffer = new ArrayBuffer(8);
      if (Number(call.GetFileSizeEx(lookup(fd), buffer)) === 0) failWin();
      return Number(new DataView(buffer).getBigInt64(0, true));
    },
    read: (fd, offset, bytes) => {
      const handle = lookup(fd);
      if (Number(call.SetFilePointerEx(handle, offset, null, FILE_BEGIN)) === 0) failWin();
      const buffer = new Uint8Array(bytes);
      const readOut = new Uint32Array(1);
      let read = 0;
      while (read < bytes) {
        const rest = buffer.subarray(read);
        if (Number(call.ReadFile(handle, rest, rest.length, readOut, null)) === 0) failWin();
        const got = readOut[0] ?? 0;
        if (got === 0) break;
        read += got;
      }
      return buffer.slice(0, read).buffer;
    },
    readText: (fd, offset, bytes) => {
      const handle = lookup(fd);
      if (Number(call.SetFilePointerEx(handle, offset, null, FILE_BEGIN)) === 0) failWin();
      const buffer = new Uint8Array(bytes);
      const readOut = new Uint32Array(1);
      if (Number(call.ReadFile(handle, buffer, bytes, readOut, null)) === 0) failWin();
      const read = readOut[0] ?? 0;
      const whole = read < bytes ? read : wholeSequences(buffer, read);
      return { text: new TextDecoder().decode(buffer.subarray(0, whole)), bytes: whole };
    },
    link: () => {
      throw new Errno("EOPNOTSUPP");
    },
    renamePart: (fd, folder, _fromName, toName, _toPath) => {
      assertBareName(toName);
      const handle = lookup(fd);
      const folderHandle = lookup(folder);
      const headerBytes = ptrSize === 8 ? 20 : 12;
      const nameBytes = toName.length * 2;
      const totalBytes = Math.max(headerBytes + nameBytes + 2, ptrSize === 8 ? 24 : 16);
      const buffer = new ArrayBuffer(totalBytes);
      const view = new DataView(buffer);
      // ReplaceIfExists = FALSE (0), RootDirectory = held folder handle, FileNameLength in bytes.
      view.setUint32(0, 0, true);
      const rawFolder = BigInt(String(folderHandle));
      if (ptrSize === 8) view.setBigInt64(8, rawFolder, true);
      else view.setUint32(4, Number(rawFolder) >>> 0, true);
      view.setUint32(ptrSize === 8 ? 16 : 8, nameBytes, true);
      for (let i = 0; i < toName.length; i += 1) {
        view.setUint16(headerBytes + i * 2, toName.charCodeAt(i), true);
      }
      // SetFileInformationByHandle(FileRenameInfo) rejects non-NULL RootDirectory; call NtSetInformationFile directly.
      const iosb = new ArrayBuffer(ptrSize === 8 ? 16 : 8);
      const signedStatus = Number(
        call.NtSetInformationFile(handle, iosb, buffer, totalBytes, FILE_RENAME_INFORMATION),
      );
      if (signedStatus >= 0) return true;
      const status = signedStatus >>> 0;
      if (status === STATUS_OBJECT_NAME_COLLISION) return false;
      const code = Number(call.RtlNtStatusToDosError(status | 0));
      if (code === 80 || code === 183) return false;
      const name = WIN_ERRNO[code];
      if (name !== undefined && UNSUPPORTED_ATOMIC_ERRNOS.has(name))
        throw new Errno(NO_ATOMIC_RENAME);
      throw new Errno(name ?? `winerr ${String(code)}`);
    },
    discardPart: (fd, folder, name) => {
      const handle = lookup(fd);
      try {
        // Whether the part is gone is decided only from what this worker's own handles report.
        if (isDeletePending(handle)) return 0;
        let expected: Identity | null = null;
        try {
          const info = infoOfHandle(handle);
          if (info.links === 0) return 0;
          expected = info.identity;
        } catch {
          expected = null;
        }
        if (expected !== null) {
          const probe = probeRelativeMeta(lookup(folder), name);
          if (probe.kind === "missing" || probe.kind === "delete-pending") return 0;
          if (probe.kind === "open") {
            let displaced = false;
            try {
              if (isDeletePending(probe.handle)) {
                displaced = true;
              } else {
                const there = infoOfHandle(probe.handle);
                displaced = there.identity.kind !== "file" || !sameFile(there.identity, expected);
              }
            } catch {
              displaced = false;
            } finally {
              call.CloseHandle(probe.handle);
            }
            if (displaced) return 0;
          }
        }
        deleteByHandle(handle);
      } finally {
        handles.delete(fd);
        call.CloseHandle(handle);
      }
      return 0;
    },
    close: (fd) => {
      const handle = lookup(fd);
      handles.delete(fd);
      if (Number(call.CloseHandle(handle)) === 0) failWin();
      return 0;
    },
  };
}

let backend: Backend | null = null;
const need = (): Backend => {
  if (backend === null) throw new Errno("not initialized");
  return backend;
};

const ANSWERS: {
  readonly [Op in WorkerRequest["op"]]: (request: Extract<WorkerRequest, { op: Op }>) => unknown;
} = {
  init: ({ platform, arch }) => {
    if (platform === "linux") backend = createLinuxBackend(arch);
    else if (platform === "macosx") backend = createMacosBackend(arch);
    else if (platform === "win") backend = createWindowsBackend();
    else throw new Errno(NO_ATOMIC_RENAME);
    return null;
  },
  "hold-folder": ({ path }) => need().holdFolder(path),
  where: ({ fd, expected }) => need().where(fd, expected),
  create: ({ folder, mode }) => need().createUnnamed(folder, mode),
  "create-part": ({ folder, path, name, mode }) => need().createPart(folder, path, name, mode),
  "fd-link": ({ fd }) => need().fdLink(fd),
  write: ({ fd, text }) => need().write(fd, text),
  identity: ({ fd }) => need().identity(fd),
  "identity-at": ({ folder, folderPath, name }) => need().identityAt(folder, folderPath, name),
  size: ({ fd }) => need().size(fd),
  read: ({ fd, offset, bytes }) => need().read(fd, offset, bytes),
  "read-text": ({ fd, offset, bytes }) => need().readText(fd, offset, bytes),
  link: ({ fd, folder, name }) => need().link(fd, folder, name),
  "rename-part": ({ fd, folder, fromName, toName, toPath }) =>
    need().renamePart(fd, folder, fromName, toName, toPath),
  "discard-part": ({ fd, folder, name }) => need().discardPart(fd, folder, name),
  close: ({ fd }) => need().close(fd),
};

declare const self: { onmessage: ((event: { readonly data: WorkerRequest }) => void) | null };
self.onmessage = ({ data }) => {
  try {
    const answer = (ANSWERS[data.op] as (request: WorkerRequest) => unknown)(data);
    postMessage({ id: data.id, ok: true, value: answer } satisfies WorkerAnswer);
  } catch (error) {
    const errno = error instanceof Errno ? error.code : `thrown ${String(error)}`;
    postMessage({ id: data.id, ok: false, errno } satisfies WorkerAnswer);
  }
};
