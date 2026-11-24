// The parent's side of file-worker.ts: one ChromeWorker per held folder, so a call stuck in the kernel stalls only
// that export's worker, never the main thread, and the export's step limit still ends it. A refused call rejects with
// `{ name: <errno name> }`, which exportFiles classifies like any platform error.

import type {
  FileIdentity,
  HeldFolder,
  NamedPartFile,
  UnnamedFile,
  UnnamedRefused,
} from "./export-file.ts";
import type {
  Identity,
  WorkerAnswer,
  WorkerArch,
  WorkerPlatform,
  WorkerRequest,
} from "./file-worker.ts";

/** What O_TMPFILE answers on a file system that cannot make an unnamed file: the export then names a part instead. */
const NO_UNNAMED_FILES = new Set(["EOPNOTSUPP", "EISDIR", "EINVAL"]);

/** What rename-part answers when no atomic no-replace rename is available, including simulated faults. */
const UNSUPPORTED_ATOMIC_ERRNOS = new Set(["ENOSYS", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

type Ask = {
  [Op in WorkerRequest["op"]]: Omit<Extract<WorkerRequest, { op: Op }>, "id">;
}[WorkerRequest["op"]];

/** A harness profile's armed fault: the errno name the next call of `op` answers instead of running. */
export type FaultFor = (op: WorkerRequest["op"]) => string | null;

class FileWorker {
  readonly #worker: ChromeWorker;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }
  >();
  readonly #fault: FaultFor;
  #next = 1;

  constructor(url: string, platform: WorkerPlatform, arch: WorkerArch, fault: FaultFor) {
    this.#fault = fault;
    this.#worker = new ChromeWorker(url);
    this.#worker.onmessage = ({ data }: { readonly data: WorkerAnswer }) => {
      const waiting = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.value);
      else waiting?.reject({ name: data.errno });
    };
    this.#worker.onerror = () => {
      for (const waiting of this.#pending.values()) waiting.reject({ name: "worker-error" });
      this.#pending.clear();
    };
    void this.ask({ op: "init", platform, arch }).catch(() => undefined);
  }

  ask<T>(request: Ask): Promise<T> {
    const fault = this.#fault(request.op);
    if (fault !== null) return Promise.reject({ name: fault });
    const id = this.#next;
    this.#next += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage takes no origin
      this.#worker.postMessage({ ...request, id });
    });
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

const sameIdentity = (identity: Identity): FileIdentity => ({
  dev: identity.dev,
  ino: identity.ino,
  kind: identity.kind,
});

const nameOf = (error: unknown): string => {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" ? name : "unknown";
};

/** Holds `realFolder` open in a new worker. The worker ends once the folder and its file are closed. */
export const holdFolderIn =
  (url: string, platform: WorkerPlatform, arch: WorkerArch, mode: number, fault: FaultFor) =>
  async (realFolder: string): Promise<HeldFolder> => {
    const worker = new FileWorker(url, platform, arch, fault);
    const held = await worker
      .ask<{ readonly fd: number }>({ op: "hold-folder", path: realFolder })
      .catch((error: unknown) => {
        worker.terminate();
        throw error;
      });
    const folder = held.fd;
    /** Closed in order once nothing needs them, and the worker ended after the last close answered. */
    const open = new Set<number>([folder]);
    const closeFd = (fd: number): void => {
      if (!open.delete(fd)) return;
      const closing = worker.ask({ op: "close", fd }).catch(() => undefined);
      if (open.size === 0) void closing.then(() => worker.terminate());
    };
    const unnamed = (fd: number, identity: Identity): UnnamedFile => ({
      identity: sameIdentity(identity),
      write: async (text) => {
        await worker.ask({ op: "write", fd, text });
      },
      size: () => worker.ask<number>({ op: "size", fd }),
      read: async (offset, bytes) =>
        new Uint8Array(await worker.ask<ArrayBuffer>({ op: "read", fd, offset, bytes })),
      readText: (offset, bytes) => worker.ask({ op: "read-text", fd, offset, bytes }),
      link: (name) => worker.ask<boolean>({ op: "link", fd, folder, name }),
      close: () => closeFd(fd),
    });
    const namedPartFile = (fd: number, identity: Identity): NamedPartFile => ({
      identity: sameIdentity(identity),
      write: async (text) => {
        await worker.ask({ op: "write", fd, text });
      },
      size: () => worker.ask<number>({ op: "size", fd }),
      read: async (offset, bytes) =>
        new Uint8Array(await worker.ask<ArrayBuffer>({ op: "read", fd, offset, bytes })),
      rename: (fromName, toName, toPath) =>
        worker
          .ask<boolean>({ op: "rename-part", fd, folder, fromName, toName, toPath })
          .catch((error: unknown) => {
            if (UNSUPPORTED_ATOMIC_ERRNOS.has(nameOf(error))) throw { name: "NO_ATOMIC_RENAME" };
            throw error;
          }),
      discard: async (name) => {
        if (!open.delete(fd)) return;
        const discarding = worker.ask({ op: "discard-part", fd, folder, name });
        try {
          await discarding;
        } finally {
          if (open.size === 0) worker.terminate();
        }
      },
      close: () => closeFd(fd),
    });
    return {
      where: () => worker.ask<string | null>({ op: "where", fd: folder, expected: realFolder }),
      createUnnamed: async () => {
        let made: { readonly fd: number; readonly identity: Identity };
        try {
          made = await worker.ask({ op: "create", folder, mode });
        } catch (error) {
          const name = nameOf(error);
          if (NO_UNNAMED_FILES.has(name))
            return { refused: "unnamed-refused", errno: name } satisfies UnnamedRefused;
          throw error;
        }
        open.add(made.fd);
        // The file can be named only through /proc/self/fd: without it, the export takes the named route now.
        const linkable = await worker
          .ask<boolean>({ op: "fd-link", fd: made.fd })
          .catch(() => false);
        if (linkable) return { file: unnamed(made.fd, made.identity) };
        closeFd(made.fd);
        return {
          refused: "fd-link-unavailable",
          errno: "fd-link-unavailable",
        } satisfies UnnamedRefused;
      },
      createNamedPart: async (name, path) => {
        const made = await worker.ask<{ readonly fd: number; readonly identity: Identity } | null>({
          op: "create-part",
          folder,
          path,
          name,
          mode,
        });
        if (made === null) return null;
        open.add(made.fd);
        return namedPartFile(made.fd, made.identity);
      },
      identityOf: async (name) => {
        const found = await worker.ask<Identity | null>({
          op: "identity-at",
          folder,
          folderPath: realFolder,
          name,
        });
        return found === null ? null : sameIdentity(found);
      },
      close: () => closeFd(folder),
    };
  };
