import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { WorkerAnswer, WorkerArch, WorkerPlatform, WorkerRequest } from "./file-worker.ts";

/**
 * Native libraries as js-ctypes hands them to file-worker.ts, replaced by a shim: each call is recorded with a copy
 * of the bytes it was given, and answers what the test scripts, setting errno or winLastError as the OS would.
 */
type Call = { readonly fn: string; readonly args: readonly unknown[]; readonly bytes: number[] };
const calls: Call[] = [];
const answerOf = new Map<string, (...args: readonly unknown[]) => number>();
let errno = 0;
let winLastError = 0;
const answers: WorkerAnswer[] = [];
let answer: ((request: WorkerRequest) => void) | null = null;

/** The next calls of `fn` answer these, in order: a number, or `{ errno }` / `{ winError }`. */
const script = (
  fn: string,
  ...results: readonly (number | { readonly errno: number } | { readonly winError: number })[]
) => {
  const queue = [...results];
  answerOf.set(fn, () => {
    const next = queue.shift() ?? 0;
    if (typeof next === "number") return next;
    if ("errno" in next) {
      errno = next.errno;
      return -1;
    }
    winLastError = next.winError;
    return 0;
  });
};

const ask = (request: WorkerRequest): WorkerAnswer => {
  answer?.(request);
  const last = answers.at(-1);
  if (last?.id !== request.id) throw new Error(`no answer to ${request.op}`);
  return last;
};

const init = (platform: WorkerPlatform, arch: WorkerArch = "x86-64") =>
  ask({ id: 99, op: "init", platform, arch });

const declarations = new Map<string, readonly unknown[]>();

let fcntlPath = "";

beforeAll(async () => {
  const type = Object.assign((value: number) => ({ cdata: value }), { ptr: {}, size: 8 });
  const boxType = Object.assign(
    (value: number) => {
      const box = { value, address: () => ({ target: box }) };
      return box;
    },
    { ptr: {}, size: 8 },
  );
  const voidPtr = Object.assign((value: number) => ({ cdata: value }), { ptr: {}, size: 8 });
  Object.assign(globalThis, {
    ctypes: {
      default_abi: "default",
      winapi_abi: "winapi",
      int: type,
      unsigned_int: type,
      uint16_t: type,
      int32_t: type,
      uint32_t: type,
      size_t: type,
      ssize_t: type,
      int64_t: type,
      intptr_t: boxType,
      char: {
        ptr: type,
        array: () => () => ({
          addressOfElement: () => ({ cdata: "path-buffer" }),
          readString: () => fcntlPath,
        }),
      },
      jschar: {
        ptr: type,
        array:
          () =>
          (text = "") => ({
            addressOfElement: () => ({ text }),
            readString: () => text,
          }),
      },
      voidptr_t: voidPtr,
      StructType: (_name: string, fields: readonly Record<string, unknown>[]) =>
        Object.assign(
          (init: Record<string, unknown> = {}) => ({
            ...init,
            address: () => init,
          }),
          { ptr: {}, size: fields.length * 8 },
        ),
      get errno() {
        return errno;
      },
      get winLastError() {
        return winLastError;
      },
      open: () => ({
        declare: (fn: string, ...sig: readonly unknown[]) => {
          declarations.set(fn, sig);
          const params = sig.slice(2);
          return (...args: readonly unknown[]) => {
            // SpiderMonkey js-ctypes rejects JS numbers for voidptr_t parameters; only null or buffers/pointers pass.
            for (let index = 0; index < params.length && params[index] !== "..."; index += 1) {
              if (params[index] === voidPtr && typeof args[index] === "number") {
                throw new TypeError(
                  `can't pass the number ${String(args[index])} to voidptr_t in ${fn}`,
                );
              }
            }
            const buffer = args.find(
              (arg) => ArrayBuffer.isView(arg) || arg instanceof ArrayBuffer,
            );
            const bytes = ArrayBuffer.isView(buffer)
              ? [...new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)]
              : buffer instanceof ArrayBuffer
                ? [...new Uint8Array(buffer)]
                : [];
            calls.push({ fn, args, bytes });
            return answerOf.get(fn)?.(...args) ?? 0;
          };
        },
      }),
    },
    postMessage: (message: WorkerAnswer) => answers.push(message),
    self: {},
  });
  await import("./file-worker.ts");
  const self = (globalThis as unknown as { self: { onmessage: (event: object) => void } }).self;
  answer = (request) => self.onmessage({ data: request });
});

beforeEach(() => {
  calls.length = 0;
  answerOf.clear();
  errno = 0;
  winLastError = 0;
  fcntlPath = "";
});

describe("the file worker's calls into libc on Linux", () => {
  const text = '{"log":"héllo, wörld"}';
  const all = [...new TextEncoder().encode(text)];

  it("retries a short write with exactly the bytes not yet written, and answers ENOSPC after it", () => {
    init("linux");
    script("write", 5, { errno: 28 });
    expect(ask({ id: 2, op: "write", fd: 7, text })).toEqual({ id: 2, ok: false, errno: "ENOSPC" });
    const writes = calls.filter((call) => call.fn === "write");
    expect(writes.map((call) => call.bytes)).toEqual([all, all.slice(5)]);
    // Each call's length is its buffer's: no call reaches past the bytes it was given.
    expect(writes.map((call) => call.args[2])).toEqual([all.length, all.length - 5]);
    expect(writes.map((call) => call.args[0])).toEqual([7, 7]);
  });

  it("writes everything through several short writes and answers the whole length", () => {
    init("linux");
    script("write", 3, 4, all.length - 7);
    expect(ask({ id: 3, op: "write", fd: 7, text })).toEqual({
      id: 3,
      ok: true,
      value: all.length,
    });
    const writes = calls.filter((call) => call.fn === "write");
    expect(writes.map((call) => call.bytes)).toEqual([all, all.slice(3), all.slice(7)]);
  });

  it("reads on after a short read, from where it stopped, until the file ends", () => {
    init("linux");
    script("pread", 4, 6, 0);
    const read = ask({ id: 4, op: "read", fd: 9, offset: 100, bytes: 32 });
    expect(read).toMatchObject({ id: 4, ok: true });
    expect(new Uint8Array((read as { value: ArrayBuffer }).value).length).toBe(10);
    const preads = calls.filter((call) => call.fn === "pread");
    expect(preads.map((call) => [call.args[2], call.args[3]])).toEqual([
      [32, 100],
      [28, 104],
      [22, 110],
    ]);
  });

  it("finishes a named part with renameat2(RENAME_NOREPLACE), answers false on EEXIST, and refuses NO_ATOMIC_RENAME on ENOSYS", () => {
    init("linux");
    script("renameat2", 0, { errno: 17 }, { errno: 38 });
    expect(
      ask({
        id: 5,
        op: "rename-part",
        fd: 8,
        folder: 4,
        fromName: "a.har.part",
        toName: "a.har",
        toPath: "/d/a.har",
      }),
    ).toEqual({ id: 5, ok: true, value: true });
    expect(
      ask({
        id: 6,
        op: "rename-part",
        fd: 8,
        folder: 4,
        fromName: "a.har.part",
        toName: "a.har",
        toPath: "/d/a.har",
      }),
    ).toEqual({ id: 6, ok: true, value: false });
    expect(
      ask({
        id: 7,
        op: "rename-part",
        fd: 8,
        folder: 4,
        fromName: "a.har.part",
        toName: "a.har",
        toPath: "/d/a.har",
      }),
    ).toEqual({ id: 7, ok: false, errno: "NO_ATOMIC_RENAME" });
    expect(calls.filter((c) => c.fn === "renameat2").map((c) => c.args[4])).toEqual([1, 1, 1]);
  });
});

describe("the file worker's calls on macOS", () => {
  it("finishes with renameatx_np(RENAME_EXCL), maps macOS errno 63 to ENAMETOOLONG, and refuses NO_ATOMIC_RENAME on ENOTSUP", () => {
    init("macosx", "aarch64");
    expect(declarations.get("openat")?.at(-1)).toBe("...");
    script("openat", 5);
    expect(
      ask({
        id: 9,
        op: "create-part",
        folder: 3,
        path: "/d/x.har.part",
        name: "x.har.part",
        mode: 0o644,
      }),
    ).toMatchObject({ id: 9, ok: true });
    expect(calls.find((c) => c.fn === "openat")?.args[3]).toEqual({ cdata: 0o644 });
    script("renameatx_np", 0, { errno: 17 }, { errno: 63 }, { errno: 45 });
    expect(
      ask({
        id: 10,
        op: "rename-part",
        fd: 5,
        folder: 3,
        fromName: "x.har.part",
        toName: "x.har",
        toPath: "/d/x.har",
      }),
    ).toEqual({ id: 10, ok: true, value: true });
    expect(
      ask({
        id: 11,
        op: "rename-part",
        fd: 5,
        folder: 3,
        fromName: "x.har.part",
        toName: "x.har",
        toPath: "/d/x.har",
      }),
    ).toEqual({ id: 11, ok: true, value: false });
    expect(
      ask({
        id: 12,
        op: "rename-part",
        fd: 5,
        folder: 3,
        fromName: "x.har.part",
        toName: "x.har",
        toPath: "/d/x.har",
      }),
    ).toEqual({ id: 12, ok: false, errno: "ENAMETOOLONG" });
    expect(
      ask({
        id: 13,
        op: "rename-part",
        fd: 5,
        folder: 3,
        fromName: "x.har.part",
        toName: "x.har",
        toPath: "/d/x.har",
      }),
    ).toEqual({ id: 13, ok: false, errno: "NO_ATOMIC_RENAME" });
    expect(calls.filter((c) => c.fn === "renameatx_np").map((c) => c.args[4])).toEqual([
      4, 4, 4, 4,
    ]);
  });

  it("distinguishes deleted from moved directories on macOS via F_GETPATH even when st_nlink stays non-zero", () => {
    init("macosx", "aarch64");
    expect(declarations.get("fcntl")?.at(-1)).toBe("...");
    const writeStat = (
      buffer: ArrayBuffer,
      dev: number,
      mode: number,
      links: number,
      ino: bigint,
    ) => {
      const view = new DataView(buffer);
      view.setInt32(0, dev, true);
      view.setUint16(4, mode, true);
      view.setUint16(6, links, true);
      view.setBigUint64(8, ino, true);
    };
    answerOf.set("fstat", (_fd, buf) => {
      writeStat(buf as ArrayBuffer, 1, 0o40700, 2, 100n);
      return 0;
    });
    // Deleted: expected path is missing and F_GETPATH returns stale expected path.
    answerOf.set("fstatat", () => {
      errno = 2;
      return -1;
    });
    answerOf.set("fcntl", () => {
      fcntlPath = "/d/out";
      return 0;
    });
    expect(ask({ id: 14, op: "where", fd: 3, expected: "/d/out" })).toEqual({
      id: 14,
      ok: true,
      value: null,
    });
    // Moved: expected path holds a link, while F_GETPATH resolves to the moved folder with the same identity.
    answerOf.set("fstatat", (_dirfd, path, buf) => {
      if (path === "/d/moved") {
        writeStat(buf as ArrayBuffer, 1, 0o40700, 2, 100n);
        return 0;
      }
      writeStat(buf as ArrayBuffer, 1, 0o120777, 1, 200n);
      return 0;
    });
    answerOf.set("fcntl", () => {
      fcntlPath = "/d/moved";
      return 0;
    });
    expect(ask({ id: 15, op: "where", fd: 3, expected: "/d/out" })).toEqual({
      id: 15,
      ok: true,
      value: "/d/moved",
    });
  });
});

describe("the file worker's calls on Windows", () => {
  const winOpenHelper = (folderRaw: number, fileInodeOf: (h: unknown) => number) => {
    let nextHandle = folderRaw - 1;
    answerOf.set("CreateFileW", () => {
      nextHandle += 1;
      return nextHandle;
    });
    answerOf.set("NtCreateFile", (outPtr) => {
      nextHandle += 1;
      (outPtr as { target: { value: number } }).target.value = nextHandle;
      return 0;
    });
    answerOf.set("GetFileInformationByHandle", (handle, buf) => {
      const view = new DataView(buf as ArrayBuffer);
      const isFolder = handle === folderRaw;
      view.setUint32(0, isFolder ? 0x10 : 0x80, true);
      view.setUint32(28, 1, true);
      view.setUint32(40, 1, true);
      view.setUint32(48, fileInodeOf(handle), true);
      return 1;
    });
    answerOf.set("GetFileInformationByHandleEx", () => 1);
    answerOf.set("CloseHandle", () => 1);
  };

  it("creates and renames relative to the held folder handle, and discards with FileDispositionInfoEx", () => {
    init("win");
    winOpenHelper(42, (h) => (h === 42 ? 10 : 20));

    const folder = ask({ id: 19, op: "hold-folder", path: "C:\\out" }) as {
      ok: true;
      value: { fd: number };
    };
    expect(folder.ok).toBe(true);
    const created = ask({
      id: 20,
      op: "create-part",
      folder: folder.value.fd,
      path: "C:\\out\\site.har.part",
      name: "site.har.part",
      mode: 0o644,
    });
    expect(created).toMatchObject({ id: 20, ok: true });
    const fd = (created as { value: { fd: number } }).value.fd;
    const ntCreate = calls.find((c) => c.fn === "NtCreateFile");
    const oa = ntCreate?.args[2] as {
      RootDirectory: number;
      ObjectName: { Length: number; Buffer: { text: string } };
    };
    expect(oa.RootDirectory).toBe(42);
    expect(oa.ObjectName.Buffer.text).toBe("site.har.part");
    expect(oa.ObjectName.Length).toBe("site.har.part".length * 2);
    // FILE_CREATE (2), FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT (0x200060)
    expect(ntCreate?.args[7]).toBe(2);
    expect(Number(ntCreate?.args[8]) & 0x00200060).toBe(0x00200060);

    script("NtSetInformationFile", 0, -0x3fffffcb, -0x3ffffffe);
    answerOf.set("RtlNtStatusToDosError", (status) =>
      Number(status) >>> 0 === 0xc0000035 ? 183 : 50,
    );
    expect(
      ask({
        id: 21,
        op: "rename-part",
        fd,
        folder: folder.value.fd,
        fromName: "site.har.part",
        toName: "site.har",
        toPath: "C:\\out\\site.har",
      }),
    ).toEqual({ id: 21, ok: true, value: true });
    const renameCall = calls.find((c) => c.fn === "NtSetInformationFile");
    expect(renameCall?.args[4]).toBe(10);
    // ReplaceIfExists = 0, RootDirectory = 42n (bytes 8..15), FileName = bare "site.har" (not full path).
    const renameView = new DataView(renameCall?.args[2] as ArrayBuffer);
    expect(renameView.getUint8(0)).toBe(0);
    expect(renameView.getBigInt64(8, true)).toBe(42n);
    expect(renameView.getUint32(16, true)).toBe("site.har".length * 2);
    expect(
      ask({
        id: 22,
        op: "rename-part",
        fd,
        folder: folder.value.fd,
        fromName: "site.har.part",
        toName: "site.har",
        toPath: "C:\\out\\site.har",
      }),
    ).toEqual({ id: 22, ok: true, value: false });
    expect(
      ask({
        id: 23,
        op: "rename-part",
        fd,
        folder: folder.value.fd,
        fromName: "site.har.part",
        toName: "site.har",
        toPath: "C:\\out\\site.har",
      }),
    ).toEqual({ id: 23, ok: false, errno: "NO_ATOMIC_RENAME" });

    answerOf.set("SetFileInformationByHandle", () => 1);
    expect(
      ask({ id: 24, op: "discard-part", fd, folder: folder.value.fd, name: "site.har.part" }),
    ).toEqual({
      id: 24,
      ok: true,
      value: 0,
    });
    const dispCall = calls.filter((c) => c.fn === "SetFileInformationByHandle").at(-1);
    // FILE_DISPOSITION_INFO_EX (21) with FILE_DISPOSITION_FLAG_DELETE | POSIX_SEMANTICS (0x03).
    expect(dispCall?.args[1]).toBe(21);
    expect(dispCall?.bytes).toEqual([3, 0, 0, 0]);
    expect(calls.some((c) => c.fn === "CloseHandle")).toBe(true);
  });

  it("decides gone-ness only from handles and tries FileDispositionInfoEx when metadata is unreadable", () => {
    init("win");
    winOpenHelper(51, (h) => Number(h));

    const folder = ask({ id: 31, op: "hold-folder", path: "C:\\out" }) as {
      ok: true;
      value: { fd: number };
    };
    const partA = ask({
      id: 32,
      op: "create-part",
      folder: folder.value.fd,
      path: "C:\\out\\a.har.part",
      name: "a.har.part",
      mode: 0o644,
    }) as { ok: true; value: { fd: number } };
    // Already delete-pending on part handle: discard-part closes and succeeds without disposition call.
    answerOf.set("GetFileInformationByHandleEx", (_h, _cls, buf) => {
      new DataView(buf as ArrayBuffer).setUint8(20, 1);
      return 1;
    });
    answerOf.set("SetFileInformationByHandle", () => 0);
    expect(
      ask({
        id: 33,
        op: "discard-part",
        fd: partA.value.fd,
        folder: folder.value.fd,
        name: "a.har.part",
      }),
    ).toEqual({ id: 33, ok: true, value: 0 });
    expect(calls.some((c) => c.fn === "SetFileInformationByHandle")).toBe(false);

    // Not delete-pending, and relative probe sees a different FileId (54 !== 53): leave displaced file alone.
    answerOf.set("GetFileInformationByHandleEx", () => 1);
    const partB = ask({
      id: 34,
      op: "create-part",
      folder: folder.value.fd,
      path: "C:\\out\\b.har.part",
      name: "b.har.part",
      mode: 0o644,
    }) as { ok: true; value: { fd: number } };
    expect(
      ask({
        id: 35,
        op: "discard-part",
        fd: partB.value.fd,
        folder: folder.value.fd,
        name: "b.har.part",
      }),
    ).toEqual({ id: 35, ok: true, value: 0 });
    expect(calls.some((c) => c.fn === "SetFileInformationByHandle")).toBe(false);

    // Relative probe fails with STATUS_ACCESS_DENIED (unknown, NOT gone): must still try FILE_DISPOSITION_INFO_EX and throw if that fails too.
    let ntCall = 0;
    answerOf.set("NtCreateFile", (outPtr) => {
      ntCall += 1;
      if (ntCall === 1) {
        (outPtr as { target: { value: number } }).target.value = 60;
        return 0;
      }
      return -1073741790; // STATUS_ACCESS_DENIED (0xC0000022)
    });
    const partC = ask({
      id: 36,
      op: "create-part",
      folder: folder.value.fd,
      path: "C:\\out\\c.har.part",
      name: "c.har.part",
      mode: 0o644,
    }) as { ok: true; value: { fd: number } };
    answerOf.set("SetFileInformationByHandle", () => {
      winLastError = 5;
      return 0;
    });
    expect(
      ask({
        id: 37,
        op: "discard-part",
        fd: partC.value.fd,
        folder: folder.value.fd,
        name: "c.har.part",
      }),
    ).toEqual({ id: 37, ok: false, errno: "EACCES" });
    expect(calls.filter((c) => c.fn === "SetFileInformationByHandle").at(-1)?.args[1]).toBe(21);
  });

  it("holds folders, checks where, writes, and reads on Windows with null pointers for voidp parameters", () => {
    init("win");
    winOpenHelper(77, () => 99);
    answerOf.set("GetFileInformationByHandle", (handle, buf) => {
      const view = new DataView(buf as ArrayBuffer);
      const isFolder = handle === 77 || handle === 78;
      view.setUint32(0, isFolder ? 0x10 : 0x80, true);
      view.setUint32(28, 1, true);
      view.setUint32(40, 1, true);
      view.setUint32(48, 99, true);
      return 1;
    });
    answerOf.set("SetFilePointerEx", () => 1);
    answerOf.set("WriteFile", (_h, buf, len, written) => {
      void buf;
      (written as Uint32Array)[0] = len as number;
      return 1;
    });
    answerOf.set("ReadFile", (_h, buf, _len, readOut) => {
      const bytes = Buffer.from("hi");
      (buf as Uint8Array).set(bytes);
      (readOut as Uint32Array)[0] = bytes.length;
      return 1;
    });

    const folder = ask({ id: 25, op: "hold-folder", path: "C:\\out" }) as {
      ok: true;
      value: { fd: number };
    };
    expect(folder.ok).toBe(true);
    expect(ask({ id: 26, op: "where", fd: folder.value.fd, expected: "C:\\out" })).toEqual({
      id: 26,
      ok: true,
      value: "C:\\out",
    });

    const part = ask({
      id: 27,
      op: "create-part",
      folder: folder.value.fd,
      path: "C:\\out\\a.har.part",
      name: "a.har.part",
      mode: 0o644,
    }) as { ok: true; value: { fd: number } };
    expect(part.ok).toBe(true);
    expect(ask({ id: 28, op: "write", fd: part.value.fd, text: "hi" })).toEqual({
      id: 28,
      ok: true,
      value: 2,
    });
    expect(ask({ id: 29, op: "read", fd: part.value.fd, offset: 0, bytes: 2 })).toMatchObject({
      id: 29,
      ok: true,
    });
    expect(ask({ id: 30, op: "read-text", fd: part.value.fd, offset: 0, bytes: 2 })).toEqual({
      id: 30,
      ok: true,
      value: { text: "hi", bytes: 2 },
    });
  });
});
