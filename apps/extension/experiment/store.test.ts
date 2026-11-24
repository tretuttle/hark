import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  parseSite,
  runIdAt,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
} from "@hark/recording/ids";
import {
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  packId,
  packPath,
  type SafeFolder,
} from "@hark/recording/layout";
import {
  DEFAULT_USER_SETTINGS,
  parseStoredSettings,
  type StoredSettings,
} from "@hark/recording/settings";
import type { Timers } from "./gecko-io.ts";
import { openStore } from "./store.ts";

const ROOT = "/mock-store" as SafeFolder;
const RUN = runIdAt(1_700_000_000_000 as EpochMs);

const makeSettings = (maxBodyBytes: number): StoredSettings => ({
  user: {
    ...DEFAULT_USER_SETTINGS,
    retention: {
      maxBodyBytes: maxBodyBytes as ByteCount,
      maxDetailBytes: 100_000 as ByteCount,
      maxAgeDays: 14,
    },
  },
  exportFolder: { kind: "downloads" },
});

describe("openStore startup gate and ledger persistence", () => {
  const saved: Record<string, unknown> = {};
  const written = new Map<string, string>();

  beforeEach(() => {
    written.clear();
    const g = globalThis as Record<string, unknown>;
    for (const key of ["IOUtils", "PathUtils", "Ci", "Cc"]) {
      saved[key] = g[key];
    }
    g["PathUtils"] = {
      join: (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/"),
    };
    g["IOUtils"] = {
      exists: async (path: string) => written.has(path),
      getChildren: async () => [],
      stat: async (path: string) => {
        const text = written.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return { type: "regular", size: text.length, lastModified: 1 };
      },
      readUTF8: async (path: string) => written.get(path) ?? "",
      writeUTF8: async (path: string, text: string) => {
        written.set(path, text);
        return text.length;
      },
      setPermissions: async () => undefined,
      move: async (from: string, to: string) => {
        const data = written.get(from) ?? "";
        written.delete(from);
        written.set(to, data);
      },
      remove: async (path: string) => {
        written.delete(path);
      },
      makeDirectory: async () => undefined,
    };
    g["Ci"] = {};
    g["Cc"] = {};
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  });

  it("starts with waitUntilLoaded active and persists ledger.json on close", async () => {
    const timers: Timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;

    const settings = makeSettings(10_000_000);
    const storeWithoutLedger = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      onSettings: () => undefined,
    });
    expect(storeWithoutLedger.isReady()).toBe(false);
    expect(storeWithoutLedger.needsStartupBuffer()).toBe(true);
    expect(storeWithoutLedger.usage().bodyBytes).toBe(10_000_000);

    await storeWithoutLedger.initRetention();
    expect(storeWithoutLedger.isReady()).toBe(true);
    expect(storeWithoutLedger.needsStartupBuffer()).toBe(false);
    expect(storeWithoutLedger.usage().bodyBytes).toBe(0);

    await storeWithoutLedger.close();
    const raw = written.get(`${ROOT}/${LAYOUT.ledger}`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      run: RUN,
      clean: true,
      bodyBytes: 0,
      detailBytes: 0,
      bodyCount: 0,
      detailCount: 0,
      siteCount: 0,
    });

    // Shutting down a non-empty archive persists its exact byte totals and counts.
    const g = globalThis as Record<string, unknown>;
    const prevIo = g["IOUtils"] as Record<string, unknown>;
    const site = parseSite("example.test")!;
    const pRel = packPath(packId(site, RUN, 1));
    const lRel = logSegmentPath(logSegmentId(site, RUN, 1));
    const pAbs = `${ROOT}/${pRel.join("/")}`;
    const lAbs = `${ROOT}/${lRel.join("/")}`;
    const siteDir = `${ROOT}/${LAYOUT.sitesDir}/${pRel[1]!}`;
    const packsDir = `${siteDir}/${LAYOUT.packDir}`;
    const logsDir = `${siteDir}/${LAYOUT.logDir}`;
    const scanDirs = new Set([`${ROOT}/${LAYOUT.sitesDir}`, siteDir, packsDir, logsDir]);
    g["IOUtils"] = {
      ...prevIo,
      exists: async (path: string) =>
        scanDirs.has(path) || path === pAbs || path === lAbs || written.has(path),
      getChildren: async (path: string) => {
        if (path === `${ROOT}/${LAYOUT.sitesDir}`) return [siteDir];
        if (path === siteDir) return [packsDir, logsDir];
        if (path === packsDir) return [pAbs];
        if (path === logsDir) return [lAbs];
        return [];
      },
      stat: async (path: string) => {
        const now = Date.now();
        if (scanDirs.has(path)) return { type: "directory", size: 0, lastModified: now };
        if (path === pAbs) return { type: "regular", size: 4_000_000, lastModified: now };
        if (path === lAbs) return { type: "regular", size: 1_000, lastModified: now };
        const text = written.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return { type: "regular", size: text.length, lastModified: now };
      },
    };
    const storePopulated = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      onSettings: () => undefined,
    });
    await storePopulated.initRetention();
    await storePopulated.close();
    const populatedRaw = written.get(`${ROOT}/${LAYOUT.ledger}`);
    expect(JSON.parse(populatedRaw!)).toEqual({
      version: 1,
      run: RUN,
      clean: true,
      bodyBytes: 4_000_000,
      detailBytes: 1_000,
      bodyCount: 1,
      detailCount: 1,
      siteCount: 1,
    });
    g["IOUtils"] = prevIo;

    const storeWithHeadroom = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      persistedUsage: { bodyBytes: 2_000_000, detailBytes: 50_000 },
      onSettings: () => undefined,
    });
    expect(storeWithHeadroom.isReady()).toBe(false);
    expect(storeWithHeadroom.needsStartupBuffer()).toBe(true);
    expect(storeWithHeadroom.needsStartupBuffer(1_000_000)).toBe(false);
    expect(storeWithHeadroom.usage()).toEqual({ bodyBytes: 2_000_000, detailBytes: 50_000 });
    await storeWithHeadroom.close();
  });

  const openSinglePackStore = async (siteHost: string, packBytes: number, capBytes: number) => {
    const timers: Timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;
    const site = parseSite(siteHost)!;
    const pRel = packPath(packId(site, RUN, 1));
    const pAbs = `${ROOT}/${pRel.join("/")}`;
    const siteDir = `${ROOT}/${LAYOUT.sitesDir}/${pRel[1]!}`;
    const packsDir = `${siteDir}/${LAYOUT.packDir}`;
    const removedPaths: string[] = [];
    const g = globalThis as Record<string, unknown>;
    const prevIo = g["IOUtils"] as Record<string, unknown>;
    g["IOUtils"] = {
      ...prevIo,
      exists: async (path: string) =>
        path === `${ROOT}/${LAYOUT.sitesDir}` ||
        path === siteDir ||
        path === packsDir ||
        path === pAbs,
      getChildren: async (path: string) => {
        if (path === `${ROOT}/${LAYOUT.sitesDir}`) return [siteDir];
        if (path === siteDir) return [packsDir];
        if (path === packsDir) return [pAbs];
        return [];
      },
      stat: async (path: string) => ({
        type: path === pAbs ? "regular" : "directory",
        size: path === pAbs ? packBytes : 0,
        lastModified: Date.now() - 1_000,
      }),
      remove: async (path: string) => {
        removedPaths.push(path);
        written.delete(path);
      },
    };
    const store = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings: makeSettings(capBytes),
      timers,
      onSettings: () => undefined,
    });
    await store.initRetention();
    return { store, pAbs, removedPaths };
  };

  it("saves a settings change to settings.json before applying it, and a failed write changes nothing", async () => {
    const timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;
    const applied: StoredSettings[] = [];
    const site = parseSite("kept.example")!;
    const store = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings: {
        ...makeSettings(10_000_000),
        user: { ...makeSettings(10_000_000).user, excludedSites: [site] },
      },
      timers,
      onSettings: (next) => applied.push(next),
    });
    await store.initRetention();
    const path = `${ROOT}/${LAYOUT.settings}`;
    const saved = await store.updateSettings({
      setting: { name: "media", value: "keep-bodies" },
      exportFolder: { kind: "chosen", path: "/exports/hars", label: "hars" },
    });
    const onDisk = parseStoredSettings(JSON.parse(written.get(path) ?? "null"));
    expect(onDisk).toEqual(saved);
    expect(onDisk?.user.media).toBe("keep-bodies");
    expect(onDisk?.user.excludedSites).toEqual([site]);
    expect(onDisk?.exportFolder).toEqual({ kind: "chosen", path: "/exports/hars", label: "hars" });
    expect(store.settings()).toEqual(saved);
    expect(applied.at(-1)).toEqual(saved);

    const included = await store.includeSite(site);
    expect(included.user.excludedSites).toEqual([]);
    expect(parseStoredSettings(JSON.parse(written.get(path)!))?.user.excludedSites).toEqual([]);

    const io = (globalThis as Record<string, unknown>)["IOUtils"] as Record<string, unknown>;
    const move = io["move"];
    io["move"] = async () => {
      throw new Error("ENOSPC");
    };
    await expect(
      store.updateSettings({ setting: { name: "media", value: "details-only" } }),
    ).rejects.toThrow("ENOSPC");
    io["move"] = move;
    expect(store.settings().user.media).toBe("keep-bodies");
    expect(parseStoredSettings(JSON.parse(written.get(path)!))?.user.media).toBe("keep-bodies");

    // Two changes sent without waiting for the first: the second must not write the first one back.
    const both = await Promise.all([
      store.updateSettings({ setting: { name: "maxBodyBytes", value: 1 } }),
      store.updateSettings({ setting: { name: "maxAgeDays", value: 3 } }),
    ]);
    const last = parseStoredSettings(JSON.parse(written.get(path)!))?.user.retention;
    expect(last).toMatchObject({ maxBodyBytes: 64 * 1_048_576, maxAgeDays: 3 });
    expect(both[1].user.retention).toEqual(last);
  });

  it("serializes updatePart deletions through the write chain rather than deleting synchronously", async () => {
    const { store, pAbs, removedPaths } = await openSinglePackStore("chain.example", 400, 500);

    let releaseChain!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    const blocked = store.enqueue(() => releasePromise);

    const partId = `${RUN}-1` as unknown as ExchangeId;
    store.openPart(partId, `${ROOT}/incoming/part.part`);
    store.updatePart(partId, 200);
    // While the write chain is blocked, updatePart must not delete old packs synchronously off-chain.
    expect(removedPaths).toEqual([]);

    releaseChain();
    await blocked;
    await store.flush();
    expect(removedPaths).toEqual([pAbs]);
    await store.close();
  });

  it("holds drain listeners while reserveWrite exceeds cap and wakes them once retention frees space", async () => {
    const { store, pAbs, removedPaths } = await openSinglePackStore(
      "drain.example",
      200_000,
      200_000,
    );

    const release = store.reserveWrite(150_000);
    expect(store.needsRetentionDrain()).toBe(true);
    let woken = 0;
    store.onRetentionDrain(() => {
      woken += 1;
    });
    expect(woken).toBe(0);

    await store.flush();
    expect(removedPaths).toEqual([pAbs]);
    expect(store.needsRetentionDrain()).toBe(false);
    expect(woken).toBe(1);
    release();
    expect(store.usage().bodyBytes).toBe(0);
    await store.close();
  });
});
