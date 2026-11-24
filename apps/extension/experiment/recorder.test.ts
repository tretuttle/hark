import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  parseChannelKey,
  runIdAt,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
  type Site,
} from "@hark/recording/ids";
import { partPath, type SafeFolder } from "@hark/recording/layout";
import type { CompiledRoutes } from "@hark/recording/routes";
import { DEFAULT_USER_SETTINGS } from "@hark/recording/settings";
import type { Timers } from "./gecko-io.ts";
import { startRecorder } from "./recorder.ts";
import type { AnsweredCommit, Store } from "./store.ts";

interface RecordedChunkHooks {
  guardListener: StreamListener | null;
  observer: RequestObserver | null;
  outputClosed: boolean;
  outputStreamWrites: number;
  settled: AnsweredCommit[];
  budget: number;
  partSize: number;
}

function installRecorderGlobals(state: RecordedChunkHooks): () => void {
  const g = globalThis as Record<string, unknown>;
  const keys = ["Services", "Ci", "Cc", "PathUtils", "ChromeUtils", "Components"] as const;
  const saved: Record<string, unknown> = {};
  for (const key of keys) saved[key] = g[key];

  g["Components"] = {
    isSuccessCode: () => true,
  };
  g["ChromeUtils"] = {
    now: () => 0,
    importESModule: () => ({}),
  };
  g["PathUtils"] = {
    join: (...parts: string[]) => parts.join("/"),
  };
  g["Ci"] = {
    nsIHttpChannel: Symbol("nsIHttpChannel"),
    nsIHttpChannelInternal: Symbol("nsIHttpChannelInternal"),
    nsITraceableChannel: Symbol("nsITraceableChannel"),
    nsIStreamListenerTee: Symbol("nsIStreamListenerTee"),
    nsIFile: Symbol("nsIFile"),
    nsIFileOutputStream: Symbol("nsIFileOutputStream"),
    nsIChannel: { DISPOSITION_ATTACHMENT: 1 },
  };
  g["Services"] = {
    obs: {
      addObserver: () => undefined,
      removeObserver: () => undefined,
    },
  };
  g["Cc"] = {
    "@mozilla.org/file/local;1": {
      createInstance: () => ({
        initWithPath: () => undefined,
        exists: () => true,
        fileSize: state.partSize,
        remove: () => undefined,
      }),
    },
    "@mozilla.org/network/file-output-stream;1": {
      createInstance: () => ({
        init: () => undefined,
        close: () => {
          state.outputClosed = true;
        },
      }),
    },
    "@mozilla.org/network/stream-listener-tee;1": {
      createInstance: () => ({
        init: (_original: StreamListener, _output: FileOutputStream, observer: RequestObserver) => {
          state.observer = observer;
        },
        onStartRequest: () => undefined,
        onDataAvailable: (
          _request: HttpChannel,
          _stream: unknown,
          _offset: number,
          count: number,
        ) => {
          if (!state.outputClosed) state.partSize += count;
          state.outputStreamWrites += 1;
        },
        onStopRequest: (request: HttpChannel) => {
          state.observer?.onStopRequest(request, 0);
        },
      }),
    },
  };

  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };
}

describe("recorder file-tee guardListener", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("closes output immediately on the chunk that hits ledger budget below route cap", () => {
    const state: RecordedChunkHooks = {
      guardListener: null,
      observer: null,
      outputClosed: false,
      outputStreamWrites: 0,
      settled: [],
      budget: 150,
      partSize: 0,
    };
    restore = installRecorderGlobals(state);

    const run = runIdAt(1_700_000_000_000 as EpochMs);
    const root = "/mock-archive" as SafeFolder;
    const routes: CompiledRoutes = {
      excluded: new Set<Site>(),
      keepMedia: true,
      memoryTeeMax: 100 as ByteCount,
      bodyFileCap: 1_000 as ByteCount,
      supported: new Set(["memory-tee", "file-tee"]),
    };
    const store = {
      settings: () => ({
        user: { ...DEFAULT_USER_SETTINGS, retention: { maxBytes: 500, maxDays: 14 } },
      }),
      enqueue: async () => undefined,
      flush: async () => undefined,
      sealAll: async () => undefined,
      commit: (input: AnsweredCommit) => {
        state.settled.push(input);
      },
      commitAbandoned: () => undefined,
      activity: () => {
        throw new Error("unused");
      },
      excludeSite: async () => false,
      updateSettings: async () => undefined,
      beginStartup: () => undefined,
      initRetention: async () => [],
      isReady: () => true,
      isScanCompleted: () => true,
      needsStartupBuffer: () => false,
      onReady: (listener: () => void) => {
        listener();
        return () => undefined;
      },
      onScanComplete: (listener: () => void) => {
        listener();
        return () => undefined;
      },
      unreadableEntries: () => 0,
      retain: async () => [],
      openPart: () => undefined,
      updatePart: () => undefined,
      partBudget: (_id: ExchangeId, routeCap: number) => Math.min(routeCap, state.budget),
      reserveWrite: () => () => undefined,
      needsRetentionDrain: () => false,
      onRetentionDrain: () => () => undefined,
      pin: () => {
        throw new Error("unused");
      },
      pinOldestPack: async () => null,
      unpin: async () => false,
      usage: () => ({ bodyBytes: 0, detailBytes: 0 }),
      overCapWhileExporting: () => false,
      workMetrics: () => {
        throw new Error("unused");
      },
      resetWorkMetrics: () => undefined,
      close: async () => undefined,
      problems: () => [],
      arm: () => undefined,
      reached: () => false,
    } as unknown as Store;

    let capturedObserver: Observer | null = null;
    const g = globalThis as Record<string, unknown>;
    (g["Services"] as { obs: { addObserver: (o: Observer) => void } }).obs.addObserver = (o) => {
      capturedObserver = o;
    };

    const timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;

    const recorder = startRecorder({
      run,
      routes,
      store,
      root,
      modes: { dir: null, file: null },
      timers,
    });

    const key = parseChannelKey("42");
    expect(key).not.toBeNull();
    const channel = {
      channelId: 42,
      URI: {
        spec: "https://example.test/large.bin",
        schemeIs: (scheme: string) => scheme === "https",
        host: "example.test",
        resolve: () => null,
      },
      requestMethod: "GET",
      responseStatus: 200,
      responseStatusText: "OK",
      contentType: "application/octet-stream",
      contentLength: 500,
      status: 0,
      transferSize: 500,
      encodedBodySize: 500,
      loadInfo: {
        browsingContext: {
          top: {
            browserId: 7,
            currentWindowGlobal: {
              documentURI: {
                spec: "https://example.test/page",
                schemeIs: (scheme: string) => scheme === "https",
                host: "example.test",
              },
            },
          },
        },
        browsingContextID: 7,
        loadingPrincipal: { isContentPrincipal: true, asciiHost: "example.test", scheme: "https" },
        triggeringPrincipal: {
          isSystemPrincipal: false,
          isContentPrincipal: true,
          asciiHost: "example.test",
        },
        externalContentPolicyType: 1,
        originAttributes: { privateBrowsingId: 0 },
      },
      getRequestHeader: () => "",
      getResponseHeader: () => "",
      visitRequestHeaders: () => undefined,
      visitResponseHeaders: () => undefined,
      QueryInterface: (iid: symbol) => {
        if (iid === (g["Ci"] as { nsITraceableChannel: symbol }).nsITraceableChannel) {
          return {
            setNewListener: (listener: StreamListener) => {
              state.guardListener = listener;
              return {
                onStartRequest: () => undefined,
                onDataAvailable: () => undefined,
                onStopRequest: () => undefined,
              };
            },
          };
        }
        return channel;
      },
    } as unknown as HttpChannel;

    capturedObserver!.observe(channel, "http-on-opening-request", "");
    capturedObserver!.observe(channel, "http-on-examine-response", "");
    expect(state.guardListener).not.toBeNull();

    const dummyStream = null as unknown as InputStream;
    const listener = state.guardListener!;
    listener.onStartRequest(channel);
    // Chunk 1: 100 B stays under ledger budget (150 B) so output stays open.
    listener.onDataAvailable(channel, dummyStream, 0, 100);
    expect(state.outputClosed).toBe(false);
    expect(state.partSize).toBe(100);

    // Chunk 2: crosses ledger budget (200 >= 150) well below route cap (1000); must close immediately.
    listener.onDataAvailable(channel, dummyStream, 100, 100);
    expect(state.outputClosed).toBe(true);
    expect(state.partSize).toBe(200);
    expect(recorder.counts().overBudgetReentries).toBe(0);

    // Chunk 3: output already closed by chunk 2, so guard does not re-enter at budget.
    listener.onDataAvailable(channel, dummyStream, 200, 100);
    expect(state.partSize).toBe(200);
    expect(recorder.counts().overBudgetReentries).toBe(0);

    capturedObserver!.observe(channel, "http-on-stop-request", "");
    listener.onStopRequest(channel, 0);

    expect(state.settled).toHaveLength(1);
    const settled = state.settled[0]!;
    expect(settled.input.sink).toEqual({
      kind: "closed",
      bytes: 200,
      cappedAt: 200,
    });
    expect(partPath(settled.input.capture.id).length).toBeGreaterThan(0);
    expect("example.test" as Site).toBe("example.test");
  });

  it("suspends startup-buffered channels at per-stream and total memory limits and resumes on ready", async () => {
    const state: RecordedChunkHooks = {
      guardListener: null,
      observer: null,
      outputClosed: false,
      outputStreamWrites: 0,
      settled: [],
      budget: 100_000_000,
      partSize: 0,
    };
    restore = installRecorderGlobals(state);
    const g = globalThis as Record<string, unknown>;
    const cc = g["Cc"] as Record<string, unknown>;
    cc["@mozilla.org/storagestream;1"] = {
      createInstance: () => {
        let len = 0;
        return {
          init: () => undefined,
          get length() {
            return len;
          },
          getOutputStream: () => ({ close: () => undefined }),
          newInputStream: () => ({}) as InputStream,
          __add: (n: number) => {
            len += n;
          },
        };
      },
    };
    const origTeeFactory = cc["@mozilla.org/network/stream-listener-tee;1"] as {
      createInstance: () => Record<string, unknown>;
    };
    const storages: { __add(n: number): void }[] = [];
    const origStorageFactory = cc["@mozilla.org/storagestream;1"] as {
      createInstance: () => { __add(n: number): void };
    };
    cc["@mozilla.org/storagestream;1"] = {
      createInstance: () => {
        const inst = origStorageFactory.createInstance();
        storages.push(inst);
        return inst;
      },
    };
    cc["@mozilla.org/network/stream-listener-tee;1"] = {
      createInstance: () => {
        const inner = origTeeFactory.createInstance();
        let activeStorage: { __add(n: number): void } | null = null;
        return {
          ...inner,
          init: (orig: StreamListener, out: unknown, obs: RequestObserver) => {
            if ("close" in (out as object) && Object.keys(out as object).length === 1) {
              activeStorage = storages[storages.length - 1] ?? null;
            }
            (inner["init"] as (a: StreamListener, b: unknown, c: RequestObserver) => void)(
              orig,
              out,
              obs,
            );
          },
          onDataAvailable: (req: HttpChannel, stream: unknown, offset: number, count: number) => {
            if (activeStorage !== null) activeStorage.__add(count);
            else {
              (inner["onDataAvailable"] as (a: unknown, b: unknown, c: number, d: number) => void)(
                req,
                stream,
                offset,
                count,
              );
            }
          },
        };
      },
    };
    cc["@mozilla.org/network/stream-transport-service;1"] = { getService: () => ({}) };
    cc["@mozilla.org/network/async-stream-copier;1"] = {
      createInstance: () => ({
        init: () => undefined,
        asyncCopy: (obs: RequestObserver, ctx: unknown) => {
          obs.onStopRequest(ctx, 0);
        },
      }),
    };

    const listeners = new Set<() => void>();
    let ready = false;
    const store = {
      settings: () => ({ user: DEFAULT_USER_SETTINGS }),
      enqueue: async () => undefined,
      flush: async () => undefined,
      sealAll: async () => undefined,
      commit: (input: AnsweredCommit) => {
        state.settled.push(input);
      },
      commitAbandoned: () => undefined,
      activity: () => {
        throw new Error("unused");
      },
      excludeSite: async () => false,
      updateSettings: async () => undefined,
      beginStartup: () => undefined,
      initRetention: async () => [],
      isReady: () => ready,
      isScanCompleted: () => ready,
      needsStartupBuffer: () => !ready,
      onReady: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onScanComplete: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unreadableEntries: () => 0,
      retain: async () => [],
      openPart: () => undefined,
      updatePart: () => undefined,
      partBudget: (_id: ExchangeId, routeCap: number) => Math.min(routeCap, state.budget),
      reserveWrite: () => () => undefined,
      needsRetentionDrain: () => false,
      onRetentionDrain: () => () => undefined,
      pin: () => {
        throw new Error("unused");
      },
      pinOldestPack: async () => null,
      unpin: async () => false,
      usage: () => ({ bodyBytes: 0, detailBytes: 0 }),
      overCapWhileExporting: () => false,
      workMetrics: () => {
        throw new Error("unused");
      },
      resetWorkMetrics: () => undefined,
      close: async () => undefined,
      problems: () => [],
      arm: () => undefined,
      reached: () => false,
    } as unknown as Store;

    let capturedObserver: Observer | null = null;
    (g["Services"] as { obs: { addObserver: (o: Observer) => void } }).obs.addObserver = (o) => {
      capturedObserver = o;
    };
    const timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;
    const run = runIdAt(1_700_000_000_000 as EpochMs);
    const recorder = startRecorder({
      run,
      routes: {
        excluded: new Set<Site>(),
        keepMedia: true,
        memoryTeeMax: 100 as ByteCount,
        bodyFileCap: 20_000_000 as ByteCount,
        supported: new Set(["memory-tee", "file-tee"]),
      },
      store,
      root: "/mock-archive" as SafeFolder,
      modes: { dir: null, file: null },
      timers,
    });

    const suspendCounts = new Map<number, number>();
    const resumeCounts = new Map<number, number>();
    const listenersById = new Map<number, StreamListener>();
    const makeChannel = (idNum: number): HttpChannel =>
      ({
        channelId: idNum,
        URI: {
          spec: `https://example.test/stream-${String(idNum)}.bin`,
          schemeIs: (scheme: string) => scheme === "https",
          host: "example.test",
          resolve: () => null,
        },
        requestMethod: "GET",
        responseStatus: 200,
        responseStatusText: "OK",
        contentType: "application/octet-stream",
        contentLength: 10_000_000,
        status: 0,
        transferSize: 10_000_000,
        encodedBodySize: 10_000_000,
        suspend: () => suspendCounts.set(idNum, (suspendCounts.get(idNum) ?? 0) + 1),
        resume: () => resumeCounts.set(idNum, (resumeCounts.get(idNum) ?? 0) + 1),
        loadInfo: {
          browsingContext: {
            top: {
              browserId: 7,
              currentWindowGlobal: {
                documentURI: {
                  spec: "https://example.test/page",
                  schemeIs: (scheme: string) => scheme === "https",
                  host: "example.test",
                },
              },
            },
          },
          browsingContextID: 7,
          loadingPrincipal: {
            isContentPrincipal: true,
            asciiHost: "example.test",
            scheme: "https",
          },
          triggeringPrincipal: {
            isSystemPrincipal: false,
            isContentPrincipal: true,
            asciiHost: "example.test",
          },
          externalContentPolicyType: 1,
          originAttributes: { privateBrowsingId: 0 },
        },
        getRequestHeader: () => "",
        getResponseHeader: () => "",
        visitRequestHeaders: () => undefined,
        visitResponseHeaders: () => undefined,
        QueryInterface: (iid: symbol) => {
          if (iid === (g["Ci"] as { nsITraceableChannel: symbol }).nsITraceableChannel) {
            return {
              setNewListener: (listener: StreamListener) => {
                listenersById.set(idNum, listener);
                return {
                  onStartRequest: () => undefined,
                  onDataAvailable: () => undefined,
                  onStopRequest: () => undefined,
                };
              },
            };
          }
          return channelById.get(idNum);
        },
      }) as unknown as HttpChannel;
    const channelById = new Map<number, HttpChannel>();
    const makeAndTrackChannel = (idNum: number): HttpChannel => {
      const ch = makeChannel(idNum);
      channelById.set(idNum, ch);
      return ch;
    };

    // Stream 101 hits STARTUP_PER_STREAM_MAX (4 MiB) and must suspend.
    const ch1 = makeAndTrackChannel(101);
    capturedObserver!.observe(ch1, "http-on-opening-request", "");
    capturedObserver!.observe(ch1, "http-on-examine-response", "");
    const l1 = listenersById.get(101)!;
    l1.onStartRequest(ch1);
    l1.onDataAvailable(ch1, null as unknown as InputStream, 0, 4 * 1_048_576);
    expect(suspendCounts.get(101)).toBe(1);
    expect(recorder.counts().startupSuspends).toBe(1);

    // Remaining streams push startup total to STARTUP_TOTAL_BUFFER_MAX (16 MiB) below per-stream cap.
    for (const idNum of [102, 103, 104, 105]) {
      const ch = makeAndTrackChannel(idNum);
      capturedObserver!.observe(ch, "http-on-opening-request", "");
      capturedObserver!.observe(ch, "http-on-examine-response", "");
      const l = listenersById.get(idNum)!;
      l.onStartRequest(ch);
      l.onDataAvailable(ch, null as unknown as InputStream, 0, 3 * 1_048_576 + 100);
    }
    expect(suspendCounts.get(105)).toBe(1);

    ready = true;
    for (const cb of listeners) cb();
    expect(resumeCounts.get(101)).toBe(1);
    expect(resumeCounts.get(105)).toBe(1);
  });

  it("resumes held streams on scan timeout without 0-byte first-part cuts", () => {
    const state: RecordedChunkHooks = {
      guardListener: null,
      observer: null,
      outputClosed: false,
      outputStreamWrites: 0,
      settled: [],
      budget: 0,
      partSize: 0,
    };
    restore = installRecorderGlobals(state);
    const g = globalThis as Record<string, unknown>;
    const cc = g["Cc"] as Record<string, unknown>;
    const storages: { __add(n: number): void; readonly corruptedAfterClose: boolean }[] = [];
    cc["@mozilla.org/storagestream;1"] = {
      createInstance: () => {
        let len = 0;
        let outClosed = false;
        let corruptedAfterClose = false;
        const inst = {
          get length() {
            return len;
          },
          get corruptedAfterClose() {
            return corruptedAfterClose;
          },
          init: () => undefined,
          getOutputStream: () => ({
            close: () => {
              outClosed = true;
            },
          }),
          newInputStream: () => ({}) as InputStream,
          __add: (n: number) => {
            // Mirrors Gecko nsIStorageStream: Write() after Close() still grows length with 0xE5 garbage.
            if (outClosed) corruptedAfterClose = true;
            len += n;
          },
        };
        storages.push(inst);
        return inst;
      },
    };
    const origTeeFactory = cc["@mozilla.org/network/stream-listener-tee;1"] as {
      createInstance: () => Record<string, unknown>;
    };
    cc["@mozilla.org/network/stream-listener-tee;1"] = {
      createInstance: () => {
        const inner = origTeeFactory.createInstance();
        let activeStorage: { __add(n: number): void } | null = null;
        return {
          ...inner,
          init: (orig: StreamListener, out: unknown, obs: RequestObserver) => {
            if ("close" in (out as object) && Object.keys(out as object).length === 1) {
              activeStorage = storages[storages.length - 1] ?? null;
            }
            (inner["init"] as (a: StreamListener, b: unknown, c: RequestObserver) => void)(
              orig,
              out,
              obs,
            );
          },
          onDataAvailable: (req: HttpChannel, stream: unknown, offset: number, count: number) => {
            if (activeStorage !== null) activeStorage.__add(count);
            else {
              (inner["onDataAvailable"] as (a: unknown, b: unknown, c: number, d: number) => void)(
                req,
                stream,
                offset,
                count,
              );
            }
          },
          onStopRequest: (request: HttpChannel) => {
            (inner["onStopRequest"] as (a: HttpChannel, status: number) => void)(request, 0);
          },
        };
      },
    };

    const readyListeners = new Set<() => void>();
    const scanListeners = new Set<() => void>();
    let ready = false;
    let scanDone = false;
    let openPartCalls = 0;
    const store = {
      settings: () => ({ user: DEFAULT_USER_SETTINGS }),
      enqueue: async () => undefined,
      flush: async () => undefined,
      sealAll: async () => undefined,
      commit: (input: AnsweredCommit) => {
        state.settled.push(input);
      },
      commitAbandoned: () => undefined,
      activity: () => {
        throw new Error("unused");
      },
      excludeSite: async () => false,
      updateSettings: async () => undefined,
      beginStartup: () => undefined,
      initRetention: async () => [],
      isReady: () => ready,
      isScanCompleted: () => scanDone,
      needsStartupBuffer: () => !ready,
      onReady: (listener: () => void) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      },
      onScanComplete: (listener: () => void) => {
        scanListeners.add(listener);
        return () => scanListeners.delete(listener);
      },
      unreadableEntries: () => 0,
      retain: async () => [],
      openPart: () => {
        openPartCalls += 1;
      },
      updatePart: () => undefined,
      partBudget: (_id: ExchangeId, routeCap: number) => Math.min(routeCap, state.budget),
      reserveWrite: () => () => undefined,
      needsRetentionDrain: () => false,
      onRetentionDrain: () => () => undefined,
      pin: () => {
        throw new Error("unused");
      },
      pinOldestPack: async () => null,
      unpin: async () => false,
      usage: () => ({ bodyBytes: 0, detailBytes: 0 }),
      overCapWhileExporting: () => false,
      workMetrics: () => {
        throw new Error("unused");
      },
      resetWorkMetrics: () => undefined,
      close: async () => undefined,
      problems: () => [],
      arm: () => undefined,
      reached: () => false,
    } as unknown as Store;

    let capturedObserver: Observer | null = null;
    (g["Services"] as { obs: { addObserver: (o: Observer) => void } }).obs.addObserver = (o) => {
      capturedObserver = o;
    };
    const timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;

    startRecorder({
      run: runIdAt(1_700_000_000_000 as EpochMs),
      routes: {
        excluded: new Set<Site>(),
        keepMedia: false,
        memoryTeeMax: 100 as ByteCount,
        bodyFileCap: 10_000_000 as ByteCount,
        supported: new Set(["memory-tee", "file-tee"]),
      },
      store,
      root: "/tmp/recorder-timeout-test" as SafeFolder,
      modes: { dir: null, file: null },
      timers,
    });

    const suspendCounts = new Map<number, number>();
    const resumeCounts = new Map<number, number>();
    const listenersById = new Map<number, StreamListener>();
    const channelById = new Map<number, HttpChannel>();
    const makeChannel = (idNum: number): HttpChannel => {
      const ch = {
        channelId: idNum,
        URI: {
          spec: `https://example.test/t-${String(idNum)}`,
          schemeIs: (s: string) => s === "https",
          host: "example.test",
        },
        requestMethod: "GET",
        responseStatus: 200,
        responseStatusText: "OK",
        contentType: "application/octet-stream",
        contentLength: 4_500_000,
        encodedBodySize: 4_500_000,
        suspend: () => suspendCounts.set(idNum, (suspendCounts.get(idNum) ?? 0) + 1),
        resume: () => resumeCounts.set(idNum, (resumeCounts.get(idNum) ?? 0) + 1),
        loadInfo: {
          browsingContext: {
            top: {
              browserId: 7,
              currentWindowGlobal: {
                documentURI: {
                  spec: "https://example.test/page",
                  schemeIs: (s: string) => s === "https",
                  host: "example.test",
                },
              },
            },
          },
          browsingContextID: 7,
          loadingPrincipal: {
            isContentPrincipal: true,
            asciiHost: "example.test",
            scheme: "https",
          },
          triggeringPrincipal: {
            isSystemPrincipal: false,
            isContentPrincipal: true,
            asciiHost: "example.test",
          },
          externalContentPolicyType: 1,
          originAttributes: { privateBrowsingId: 0 },
        },
        getRequestHeader: () => "",
        getResponseHeader: () => "",
        visitRequestHeaders: () => undefined,
        visitResponseHeaders: () => undefined,
        QueryInterface: (iid: symbol) => {
          if (iid === (g["Ci"] as { nsITraceableChannel: symbol }).nsITraceableChannel) {
            return {
              setNewListener: (listener: StreamListener) => {
                listenersById.set(idNum, listener);
                return {
                  onStartRequest: () => undefined,
                  onDataAvailable: () => undefined,
                  onStopRequest: () => undefined,
                };
              },
            };
          }
          return channelById.get(idNum);
        },
      } as unknown as HttpChannel;
      channelById.set(idNum, ch);
      return ch;
    };

    // Held pre-timeout small body (100 KB) + streams near 16 MiB total cap.
    for (const [idNum, firstChunk] of [
      [201, 50_000],
      [202, 4 * 1_048_576],
      [203, 4 * 1_048_576],
      [204, 4 * 1_048_576],
      [205, 3_500_000],
    ] as const) {
      const ch = makeChannel(idNum);
      capturedObserver!.observe(ch, "http-on-opening-request", "");
      capturedObserver!.observe(ch, "http-on-examine-response", "");
      const l = listenersById.get(idNum)!;
      l.onStartRequest(ch);
      l.onDataAvailable(ch, null as unknown as InputStream, 0, firstChunk);
    }
    expect(suspendCounts.get(202)).toBe(1);
    expect(openPartCalls).toBe(0);

    // 30s timeout opens gate with scanDone === false and budget === 0: channels must resume without 0-byte .part files.
    ready = true;
    for (const cb of readyListeners) cb();
    expect(openPartCalls).toBe(0);
    expect(resumeCounts.get(202)).toBe(1);

    // Stream 201 completes post-timeout within RAM budget: exact buffer commit, never first-part.
    const ch201 = channelById.get(201)!;
    listenersById.get(201)!.onDataAvailable(ch201, null as unknown as InputStream, 50_000, 50_000);
    listenersById.get(201)!.onStopRequest(ch201, 0);
    capturedObserver!.observe(ch201, "http-on-stop-request", "");

    // Stream 205 pushes total startup buffer past 16 MiB cap cleanly.
    const ch205 = channelById.get(205)!;
    listenersById
      .get(205)!
      .onDataAvailable(ch205, null as unknown as InputStream, 3_500_000, 700_000);

    // Post-timeout arrival while total RAM >= 16 MiB becomes incomplete scan-timeout (0 bytes, no .part, no first-part).
    const ch206 = makeChannel(206);
    capturedObserver!.observe(ch206, "http-on-opening-request", "");
    capturedObserver!.observe(ch206, "http-on-examine-response", "");
    listenersById.get(206)!.onStartRequest(ch206);
    listenersById.get(206)!.onDataAvailable(ch206, null as unknown as InputStream, 0, 10_000);
    listenersById.get(206)!.onStopRequest(ch206, 0);
    capturedObserver!.observe(ch206, "http-on-stop-request", "");

    // Stream 202 resumes and delivers remaining bytes past 4 MiB: must NOT re-suspend; cuts as scan-timeout with non-empty prefix.
    const ch202 = channelById.get(202)!;
    listenersById
      .get(202)!
      .onDataAvailable(ch202, null as unknown as InputStream, 4 * 1_048_576, 500_000);
    expect(suspendCounts.get(202)).toBe(1);
    listenersById.get(202)!.onStopRequest(ch202, 0);
    capturedObserver!.observe(ch202, "http-on-stop-request", "");

    expect(openPartCalls).toBe(0);
    expect(storages.every((s) => !s.corruptedAfterClose)).toBe(true);
    expect(state.settled).toHaveLength(3);
    expect(state.settled[0]!.input.sink).toEqual({
      kind: "closed",
      bytes: 100_000,
      cappedAt: null,
    });
    expect(state.settled[0]!.bytes?.kind).toBe("buffer");
    expect(state.settled[1]!.input.sink).toEqual({
      kind: "closed",
      bytes: 0,
      cappedAt: 0,
      cutWhy: "scan-timeout",
    });
    expect(state.settled[1]!.bytes).toBeNull();
    expect(state.settled[2]!.input.sink).toEqual({
      kind: "closed",
      bytes: 4 * 1_048_576,
      cappedAt: 4 * 1_048_576,
      cutWhy: "scan-timeout",
    });
    expect(state.settled[2]!.bytes?.kind).toBe("buffer");
  });

  it("drives a held body byte-exact across timeout and gate opening, and keeps scan-timeout prefixes uncorrupted", () => {
    const state: RecordedChunkHooks = {
      guardListener: null,
      observer: null,
      outputClosed: false,
      outputStreamWrites: 0,
      settled: [],
      budget: 0,
      partSize: 0,
    };
    restore = installRecorderGlobals(state);
    const g = globalThis as Record<string, unknown>;
    const cc = g["Cc"] as Record<string, unknown>;

    interface FakeByteStream {
      readonly __bytes: Uint8Array;
    }
    interface FakeStorage {
      readonly chunks: Uint8Array[];
      length: number;
      outClosed: boolean;
      corruptedAfterClose: boolean;
      newInputStream(offset: number): InputStream;
    }

    const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
      const total = parts.reduce((sum, p) => sum + p.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const part of parts) {
        out.set(part, cursor);
        cursor += part.length;
      }
      return out;
    };

    const storages: FakeStorage[] = [];
    const outputBuffers = new Map<unknown, { closed: boolean; chunks: Uint8Array[] }>();
    const pendingCopies: (() => void)[] = [];

    cc["@mozilla.org/storagestream;1"] = {
      createInstance: () => {
        const inst: FakeStorage & {
          init: () => void;
          getOutputStream: () => { close: () => void; __storage: FakeStorage };
        } = {
          chunks: [],
          length: 0,
          outClosed: false,
          corruptedAfterClose: false,
          init: () => undefined,
          getOutputStream: () => ({
            __storage: inst,
            close: () => {
              inst.outClosed = true;
            },
          }),
          newInputStream: (offset: number) => {
            const all = concatBytes(inst.chunks).subarray(offset);
            return { __bytes: all } as unknown as InputStream;
          },
        };
        storages.push(inst);
        return inst;
      },
    };

    cc["@mozilla.org/network/file-output-stream;1"] = {
      createInstance: () => {
        const rec = { closed: false, chunks: [] as Uint8Array[] };
        const stream = {
          init: () => undefined,
          close: () => {
            rec.closed = true;
          },
        };
        outputBuffers.set(stream, rec);
        return stream;
      },
    };

    cc["@mozilla.org/network/stream-listener-tee;1"] = {
      createInstance: () => {
        let teeOrig!: StreamListener;
        let teeOut: unknown = null;
        let teeObs!: RequestObserver;
        return {
          init: (orig: StreamListener, output: unknown, observer: RequestObserver) => {
            teeOrig = orig;
            teeOut = output;
            teeObs = observer;
          },
          onStartRequest: (request: HttpChannel) => {
            teeObs.onStartRequest(request);
            teeOrig.onStartRequest(request);
          },
          onDataAvailable: (
            request: HttpChannel,
            stream: InputStream,
            offset: number,
            count: number,
          ) => {
            const incoming = (stream as unknown as FakeByteStream).__bytes.subarray(0, count);
            const storageOut = teeOut as { __storage?: FakeStorage };
            if (storageOut.__storage !== undefined) {
              const s = storageOut.__storage;
              if (s.outClosed) {
                s.corruptedAfterClose = true;
                const poison = new Uint8Array(incoming.length);
                poison.fill(0xe5);
                s.chunks.push(poison);
              } else {
                s.chunks.push(new Uint8Array(incoming));
              }
              s.length += incoming.length;
            } else {
              const fileRec = outputBuffers.get(teeOut);
              if (fileRec !== undefined && !fileRec.closed) {
                fileRec.chunks.push(new Uint8Array(incoming));
                state.partSize += incoming.length;
              }
            }
            teeOrig.onDataAvailable(request, stream, offset, count);
          },
          onStopRequest: (request: HttpChannel, status: number) => {
            teeOrig.onStopRequest(request, status);
            teeObs.onStopRequest(request, status);
          },
        };
      },
    };

    cc["@mozilla.org/network/stream-transport-service;1"] = { getService: () => ({}) };
    cc["@mozilla.org/network/async-stream-copier;1"] = {
      createInstance: () => {
        let src!: FakeByteStream;
        let dst: unknown = null;
        return {
          init: (input: unknown, output: unknown) => {
            src = input as FakeByteStream;
            dst = output;
          },
          asyncCopy: (obs: RequestObserver, ctx: unknown) => {
            pendingCopies.push(() => {
              const fileRec = outputBuffers.get(dst);
              if (fileRec !== undefined && !fileRec.closed) {
                fileRec.chunks.push(new Uint8Array(src.__bytes));
                state.partSize += src.__bytes.length;
              }
              obs.onStopRequest(ctx, 0);
            });
          },
        };
      },
    };

    const readyListeners = new Set<() => void>();
    const scanListeners = new Set<() => void>();
    let ready = false;
    let scanDone = false;
    const partFiles = new Map<ExchangeId, { readonly path: string; bytes: number }>();
    const store = {
      settings: () => ({ user: DEFAULT_USER_SETTINGS }),
      enqueue: async () => undefined,
      flush: async () => undefined,
      sealAll: async () => undefined,
      commit: (input: AnsweredCommit) => {
        state.settled.push(input);
      },
      commitAbandoned: () => undefined,
      activity: () => {
        throw new Error("unused");
      },
      excludeSite: async () => false,
      updateSettings: async () => undefined,
      beginStartup: () => undefined,
      initRetention: async () => [],
      isReady: () => ready,
      isScanCompleted: () => scanDone,
      needsStartupBuffer: () => !ready,
      onReady: (listener: () => void) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      },
      onScanComplete: (listener: () => void) => {
        scanListeners.add(listener);
        return () => scanListeners.delete(listener);
      },
      unreadableEntries: () => 0,
      retain: async () => [],
      openPart: (id: ExchangeId, path: string) => {
        partFiles.set(id, { path, bytes: 0 });
      },
      updatePart: (id: ExchangeId, bytes: number) => {
        const rec = partFiles.get(id);
        if (rec !== undefined) rec.bytes = bytes;
      },
      partBudget: (_id: ExchangeId, routeCap: number) => Math.min(routeCap, state.budget),
      reserveWrite: () => () => undefined,
      needsRetentionDrain: () => false,
      onRetentionDrain: () => () => undefined,
      pin: () => {
        throw new Error("unused");
      },
      pinOldestPack: async () => null,
      unpin: async () => false,
      usage: () => ({ bodyBytes: 0, detailBytes: 0 }),
      overCapWhileExporting: () => false,
      workMetrics: () => {
        throw new Error("unused");
      },
      resetWorkMetrics: () => undefined,
      close: async () => undefined,
      problems: () => [],
      arm: () => undefined,
      reached: () => false,
    } as unknown as Store;

    let capturedObserver: Observer | null = null;
    (g["Services"] as { obs: { addObserver: (o: Observer) => void } }).obs.addObserver = (o) => {
      capturedObserver = o;
    };
    const timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;

    startRecorder({
      run: runIdAt(1_700_000_000_000 as EpochMs),
      routes: {
        excluded: new Set<Site>(),
        keepMedia: false,
        memoryTeeMax: 100 as ByteCount,
        bodyFileCap: 10_000_000 as ByteCount,
        supported: new Set(["memory-tee", "file-tee"]),
      },
      store,
      root: "/tmp/recorder-byte-exact-test" as SafeFolder,
      modes: { dir: null, file: null },
      timers,
    });

    const listenersById = new Map<number, StreamListener>();
    const origChunksById = new Map<number, Uint8Array[]>();
    const channelById = new Map<number, HttpChannel>();
    const makeChannel = (idNum: number, contentLength: number): HttpChannel => {
      const chunks: Uint8Array[] = [];
      origChunksById.set(idNum, chunks);
      const ch = {
        channelId: idNum,
        URI: {
          spec: `https://example.test/exact-${String(idNum)}`,
          schemeIs: (s: string) => s === "https",
          host: "example.test",
        },
        requestMethod: "GET",
        responseStatus: 200,
        responseStatusText: "OK",
        contentType: "application/octet-stream",
        contentLength,
        encodedBodySize: contentLength,
        suspend: () => undefined,
        resume: () => undefined,
        loadInfo: {
          browsingContext: {
            top: {
              browserId: 7,
              currentWindowGlobal: {
                documentURI: {
                  spec: "https://example.test/page",
                  schemeIs: (s: string) => s === "https",
                  host: "example.test",
                },
              },
            },
          },
          browsingContextID: 7,
          loadingPrincipal: {
            isContentPrincipal: true,
            asciiHost: "example.test",
            scheme: "https",
          },
          triggeringPrincipal: {
            isSystemPrincipal: false,
            isContentPrincipal: true,
            asciiHost: "example.test",
          },
          externalContentPolicyType: 1,
          originAttributes: { privateBrowsingId: 0 },
        },
        getRequestHeader: () => "",
        getResponseHeader: () => "",
        visitRequestHeaders: () => undefined,
        visitResponseHeaders: () => undefined,
        QueryInterface: (iid: symbol) => {
          if (iid === (g["Ci"] as { nsITraceableChannel: symbol }).nsITraceableChannel) {
            return {
              setNewListener: (listener: StreamListener) => {
                listenersById.set(idNum, listener);
                return {
                  onStartRequest: () => undefined,
                  onDataAvailable: (
                    _req: unknown,
                    stream: unknown,
                    _offset: number,
                    count: number,
                  ) => {
                    chunks.push(
                      new Uint8Array((stream as FakeByteStream).__bytes.subarray(0, count)),
                    );
                  },
                  onStopRequest: () => undefined,
                };
              },
            };
          }
          return channelById.get(idNum);
        },
      } as unknown as HttpChannel;
      channelById.set(idNum, ch);
      return ch;
    };

    const makePattern = (len: number, seed: number): Uint8Array => {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) buf[i] = (i * 131 + seed) & 0xff;
      return buf;
    };
    const asStream = (slice: Uint8Array): InputStream =>
      ({ __bytes: slice }) as unknown as InputStream;

    // Body 301 (400 KB) spans pre-timeout buffering, post-timeout buffering, mid-flush, and post-gate file phase.
    const body301 = makePattern(400_000, 17);
    const ch301 = makeChannel(301, 400_000);
    // Body 302 (4,500,000 B) hits 4,274,995 B before timeout, then receives remaining 225,005 B after timeout.
    const body302 = makePattern(4_500_000, 89);
    const ch302 = makeChannel(302, 4_500_000);

    for (const ch of [ch301, ch302]) {
      capturedObserver!.observe(ch, "http-on-opening-request", "");
      capturedObserver!.observe(ch, "http-on-examine-response", "");
      listenersById.get(ch.channelId)!.onStartRequest(ch);
    }

    // Pre-timeout chunks: 301 buffers 100 KB; 302 suspends at 4,274,995 B.
    listenersById
      .get(301)!
      .onDataAvailable(ch301, asStream(body301.subarray(0, 100_000)), 0, 100_000);
    listenersById
      .get(302)!
      .onDataAvailable(ch302, asStream(body302.subarray(0, 4_274_995)), 0, 4_274_995);

    // Timeout opens gate with scanDone === false and budget === 0.
    ready = true;
    for (const cb of readyListeners) cb();

    // Post-timeout chunks: 301 stays under buffer limit; 302 delivers rest in 2 chunks past cut.
    listenersById
      .get(301)!
      .onDataAvailable(ch301, asStream(body301.subarray(100_000, 250_000)), 100_000, 150_000);
    listenersById
      .get(302)!
      .onDataAvailable(ch302, asStream(body302.subarray(4_274_995, 4_400_000)), 4_274_995, 125_005);
    listenersById
      .get(302)!
      .onDataAvailable(ch302, asStream(body302.subarray(4_400_000, 4_500_000)), 4_400_000, 100_000);
    listenersById.get(302)!.onStopRequest(ch302, 0);
    capturedObserver!.observe(ch302, "http-on-stop-request", "");

    // Scan finishes and gate opens while body 301 is still mid-transfer.
    state.budget = 10_000_000;
    scanDone = true;
    for (const cb of scanListeners) cb();
    expect(pendingCopies.length).toBe(1);

    // Deliver a chunk WHILE copier.asyncCopy is still running (phase === "flushing").
    listenersById
      .get(301)!
      .onDataAvailable(ch301, asStream(body301.subarray(250_000, 300_000)), 250_000, 50_000);

    // Drain copier steps (initial storage copy + mid-flush overflow copy).
    while (pendingCopies.length > 0) pendingCopies.shift()!();

    // Deliver final chunk after switching to phase === "file" and close cleanly.
    listenersById
      .get(301)!
      .onDataAvailable(ch301, asStream(body301.subarray(300_000, 400_000)), 300_000, 100_000);
    listenersById.get(301)!.onStopRequest(ch301, 0);
    capturedObserver!.observe(ch301, "http-on-stop-request", "");

    expect(storages.every((s) => !s.corruptedAfterClose)).toBe(true);
    expect(state.settled).toHaveLength(2);

    // 302: original received all 4,500,000 B exact; kept scan-timeout buffer is exact 4,274,995 B with zero 0xE5 corruption.
    const rec302 = state.settled[0]!;
    expect(rec302.input.sink).toEqual({
      kind: "closed",
      bytes: 4_274_995,
      cappedAt: 4_274_995,
      cutWhy: "scan-timeout",
    });
    expect(rec302.bytes?.kind).toBe("buffer");
    const saved302 = (rec302.bytes as { readonly stream: InputStream })
      .stream as unknown as FakeByteStream;
    expect(saved302.__bytes.length).toBe(4_274_995);
    expect(Buffer.from(saved302.__bytes).equals(Buffer.from(body302.subarray(0, 4_274_995)))).toBe(
      true,
    );
    const orig302 = concatBytes(origChunksById.get(302)!);
    expect(orig302.length).toBe(4_500_000);
    expect(Buffer.from(orig302).equals(Buffer.from(body302))).toBe(true);

    // 301: full 400,000 B body transferred to part output byte-for-byte without interleaving or loss.
    const rec301 = state.settled[1]!;
    expect(rec301.input.sink).toEqual({
      kind: "closed",
      bytes: 400_000,
      cappedAt: null,
    });
    expect(rec301.bytes?.kind).toBe("part");
    const [writtenRec] = [...outputBuffers.values()];
    const written301 = concatBytes(writtenRec!.chunks);
    expect(written301.length).toBe(400_000);
    expect(Buffer.from(written301).equals(Buffer.from(body301))).toBe(true);
    const orig301 = concatBytes(origChunksById.get(301)!);
    expect(Buffer.from(orig301).equals(Buffer.from(body301))).toBe(true);
  });
});
