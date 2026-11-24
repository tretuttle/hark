import type { RunId } from "@hark/recording/ids";
import { LAYOUT, type SafeFolder } from "@hark/recording/layout";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadPersistedLedger, openPersistedLedger } from "./files.ts";

interface FakeNode {
  kind: "file" | "dir";
  content: string;
  mtime: number;
  mode: number;
}

const ROOT = "/tmp/fake-files-root" as SafeFolder;
const RUN = "run-files-test" as RunId;
const LEDGER_PATH = `${ROOT}/${LAYOUT.ledger}`;
const SITES_PATH = `${ROOT}/${LAYOUT.sitesDir}`;

const baseLedger = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    run: "prev-clean-run",
    clean: true,
    bodyBytes: 1_000,
    detailBytes: 200,
    bodyCount: 4,
    detailCount: 1,
    siteCount: 1,
    ...overrides,
  });

describe("persisted ledger validation and synchronous open", () => {
  const nodes = new Map<string, FakeNode>();
  const saved: Record<string, unknown> = {};

  const putDir = (path: string, mtime: number): void => {
    const clean = path.replace(/\/+$/u, "");
    const parts = clean.split("/");
    for (let i = 2; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join("/");
      const cur = nodes.get(sub);
      if (cur === undefined) {
        nodes.set(sub, { kind: "dir", content: "", mtime, mode: 0o700 });
      }
    }
    const leaf = nodes.get(clean);
    if (leaf !== undefined) leaf.mtime = mtime;
  };

  const putFile = (path: string, content: string, mtime: number): void => {
    const slash = path.lastIndexOf("/");
    if (slash > 0) putDir(path.slice(0, slash), mtime);
    nodes.set(path, { kind: "file", content, mtime, mode: 0o600 });
  };

  const childrenOf = (dirPath: string): string[] => {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const path of nodes.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) names.add(path);
    }
    return [...names].sort();
  };

  const makeLocalFile = (initialPath: string): LocalFile => {
    const makeEntry = (entryPath: string): LocalFile => {
      let curPath = entryPath;
      const wrapper: {
        path: string;
        exists: () => boolean;
        isDirectory: () => boolean;
        readonly lastModifiedTime?: number | undefined;
        permissions: number;
        readonly directoryEntries?: {
          hasMoreElements: () => boolean;
          getNext: () => LocalFile;
          close: () => void;
        };
        initWithPath: (next: string) => void;
        create: (_type: number, mode: number) => void;
        moveTo: (_dir: LocalFile | null, newName: string) => void;
      } = {
        get path() {
          return curPath;
        },
        exists: () => nodes.has(curPath),
        isDirectory: () => nodes.get(curPath)?.kind === "dir",
        get lastModifiedTime() {
          return nodes.get(curPath)?.mtime;
        },
        get permissions() {
          return nodes.get(curPath)?.mode ?? 0o600;
        },
        set permissions(val: number) {
          const n = nodes.get(curPath);
          if (n !== undefined) n.mode = val;
        },
        get directoryEntries() {
          const list = childrenOf(curPath);
          let idx = 0;
          return {
            hasMoreElements: () => idx < list.length,
            getNext: () => makeEntry(list[idx++]!),
            close: () => undefined,
          };
        },
        initWithPath: (next: string) => {
          curPath = next;
        },
        create: (_type: number, mode: number) => {
          nodes.set(curPath, { kind: "dir", content: "", mtime: 10_000, mode });
        },
        moveTo: (_dir: LocalFile | null, newName: string) => {
          const src = nodes.get(curPath);
          if (src === undefined) throw new Error(`missing source ${curPath}`);
          const parent = curPath.slice(0, curPath.lastIndexOf("/"));
          const dest = `${parent}/${newName}`;
          nodes.delete(curPath);
          nodes.set(dest, { ...src, mtime: src.mtime });
          curPath = dest;
        },
      };
      return wrapper as unknown as LocalFile;
    };
    return makeEntry(initialPath);
  };

  beforeEach(() => {
    nodes.clear();
    const g = globalThis as Record<string, unknown>;
    for (const key of ["Cc", "Ci", "ChromeUtils", "PathUtils"]) {
      saved[key] = g[key];
    }
    const NS_I_FILE = Symbol("nsIFile");
    const NS_I_INPUT = Symbol("nsIFileInputStream");
    const NS_I_OUTPUT = Symbol("nsIFileOutputStream");
    g["Ci"] = {
      nsIFile: NS_I_FILE,
      nsIFileInputStream: NS_I_INPUT,
      nsIFileOutputStream: NS_I_OUTPUT,
    };
    g["PathUtils"] = {
      join: (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/"),
      filename: (p: string) => p.slice(p.lastIndexOf("/") + 1),
    };
    g["ChromeUtils"] = {
      importESModule: () => ({
        NetUtil: {
          readInputStreamToString: (stream: { _content: string }) => stream._content,
        },
      }),
    };
    g["Cc"] = {
      "@mozilla.org/file/local;1": {
        createInstance: () => makeLocalFile(""),
      },
      "@mozilla.org/network/file-input-stream;1": {
        createInstance: () => {
          let content = "";
          return {
            get _content() {
              return content;
            },
            init: (file: LocalFile) => {
              content = nodes.get(file.path)?.content ?? "";
            },
            available: () => Buffer.byteLength(content, "utf8"),
            close: () => undefined,
          };
        },
      },
      "@mozilla.org/network/file-output-stream;1": {
        createInstance: () => {
          let targetPath = "";
          let buf = "";
          let fileMode = 0o600;
          return {
            init: (file: LocalFile, _flags: number, mode: number) => {
              targetPath = file.path;
              fileMode = mode;
              buf = "";
            },
            write: (text: string) => {
              buf += text;
              return text.length;
            },
            close: () => {
              nodes.set(targetPath, {
                kind: "file",
                content: buf,
                mtime: 20_000,
                mode: fileMode,
              });
            },
          };
        },
      },
    };
    putDir(`${ROOT}/${LAYOUT.incomingDir}`, 1_000);
    putFile(`${SITES_PATH}/a/${LAYOUT.packDir}/p1.pack`, "x", 5_000);
    putFile(`${SITES_PATH}/a/${LAYOUT.logDir}/l1.ndjson`, "y", 5_000);
    putDir(`${SITES_PATH}/a/${LAYOUT.packDir}`, 5_000);
    putDir(`${SITES_PATH}/a/${LAYOUT.logDir}`, 5_000);
    putDir(`${SITES_PATH}/a`, 5_000);
    putDir(SITES_PATH, 5_000);
    putFile(LEDGER_PATH, baseLedger(), 10_000);
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const [key, val] of Object.entries(saved)) g[key] = val;
  });

  it("rejects missing, corrupt, unclean, incomplete, and disk-skewed ledgers", () => {
    expect(loadPersistedLedger(ROOT)).toEqual({
      bodyBytes: 1_000,
      detailBytes: 200,
      bodyCount: 4,
      detailCount: 1,
    });

    nodes.delete(LEDGER_PATH);
    expect(loadPersistedLedger(ROOT)).toBeNull();

    putFile(LEDGER_PATH, "{broken-json", 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();

    // Must never trust an unclean ledger from a crashed session.
    putFile(LEDGER_PATH, baseLedger({ clean: false }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();

    putFile(LEDGER_PATH, baseLedger({ version: 2 }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putFile(LEDGER_PATH, baseLedger({ run: "" }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putFile(LEDGER_PATH, baseLedger({ bodyBytes: -1 }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();

    putFile(LEDGER_PATH, baseLedger(), 10_000);
    putFile(`${LEDGER_PATH}${LAYOUT.tmpSuffix}`, "tmp", 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    nodes.delete(`${LEDGER_PATH}${LAYOUT.tmpSuffix}`);

    putFile(`${ROOT}/${LAYOUT.incomingDir}/stray.part`, "123", 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    nodes.delete(`${ROOT}/${LAYOUT.incomingDir}/stray.part`);

    // Mtime newer than ledger on sites/, site/, or sub-dir invalidates trust.
    putDir(`${SITES_PATH}/a/packs`, 10_001);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putDir(`${SITES_PATH}/a/packs`, 5_000);

    putDir(`${SITES_PATH}/a`, 10_001);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putDir(`${SITES_PATH}/a`, 5_000);

    putDir(SITES_PATH, 10_001);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putDir(SITES_PATH, 5_000);

    // Zero body/detail count cannot pass when packs or logs exist on disk.
    putFile(LEDGER_PATH, baseLedger({ bodyCount: 0 }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putFile(LEDGER_PATH, baseLedger({ detailCount: 0 }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
    putFile(LEDGER_PATH, baseLedger({ siteCount: 2 }), 10_000);
    expect(loadPersistedLedger(ROOT)).toBeNull();
  });

  it("openPersistedLedger reads clean totals once and marks clean: false synchronously for crash safety", () => {
    const loaded = openPersistedLedger(ROOT, { dir: 0o700, file: 0o600 }, RUN);
    expect(loaded).toEqual({
      bodyBytes: 1_000,
      detailBytes: 200,
      bodyCount: 4,
      detailCount: 1,
    });
    const onDisk = JSON.parse(nodes.get(LEDGER_PATH)!.content) as Record<string, unknown>;
    expect(onDisk["clean"]).toBe(false);
    expect(onDisk["run"]).toBe(RUN);

    // Next startup after a crash sees clean: false even when directory mtimes never advanced past ledger.
    expect(loadPersistedLedger(ROOT)).toBeNull();
  });
});
