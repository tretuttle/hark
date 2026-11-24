// Observers, gates, facts and sinks on the parent main thread, for every HTTP channel. Owns the live map and the cap
// watchdog; hands every settled exchange and every byte on disk to the store. No body byte is read into script and
// nothing touches the HTTP cache.

import { DEFAULT_REDACTION_RULES } from "@hark/har/rules";
import {
  abandon,
  EXAMINE_ACCEPTS,
  examine,
  open,
  unanswered,
  type AbandonReason,
  type Capture,
  type ExamineTopic,
  type ExchangeFacts,
  type Header,
  type LiveExchange,
  type NetError,
  type RequestFacts,
  type ResponseFacts,
  type SinkResult,
  type StopFacts,
  type Timings,
  type UploadOutcome,
} from "@hark/recording/exchange";
import {
  exchangeId,
  parseChannelKey,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
  type RunId,
  type Site,
  type TabKey,
} from "@hark/recording/ids";
import { partPath, type SafeFolder } from "@hark/recording/layout";
import {
  chooseRoute,
  firstGate,
  type CompiledRoutes,
  type GateFacts,
  type ResponseSource,
  type Route,
} from "@hark/recording/routes";
import { topSiteOf } from "@hark/recording/site";
import {
  errorName,
  localFile,
  openOutput,
  siteOfHost,
  siteOfUri,
  type Modes,
  type Timers,
} from "./gecko-io.ts";
import type { CopiedBytes, PendingUpload, Store } from "./store.ts";

const OPENING = "http-on-opening-request";
const STOP = "http-on-stop-request";
/** Which topic delivered the head, as route selection reads it. */
const EXAMINE_SOURCE: { readonly [T in ExamineTopic]: ResponseSource } = {
  "http-on-examine-response": "network",
  "http-on-examine-cached-response": "cache",
  "http-on-examine-merged-response": "revalidated",
  "service-worker-synthesized-response": "service-worker",
};
const isExamineTopic = (topic: string): topic is ExamineTopic => topic in EXAMINE_SOURCE;
const TOPICS: readonly string[] = [OPENING, ...Object.keys(EXAMINE_SOURCE), STOP];

const NS_BINDING_REDIRECTED = 0x804b0003;
const STORAGE_SEGMENT = 16_384;
const COPY_CHUNK = 65_536;
const STARTUP_PER_STREAM_MAX = 4 * 1_048_576;
const STARTUP_TOTAL_BUFFER_MAX = 16 * 1_048_576;
const WATCHDOG_MS = 250;
const UPLOAD_MAX = 1_048_576;
/** Past this many live requests, new ones are not recorded and the overflow is counted. */
const MAX_LIVE = 20_000;
/** An internal redirect's source keeps NS_BINDING_REDIRECTED and never reaches examine or stop; its target carries the request. */
const SWEEP_EVERY = 256;
const MAX_ERRORS_KEPT = 20;
const PREPARE_FAILURES: { readonly [name: string]: "disk-full" | "access-denied" } = {
  NS_ERROR_FILE_NO_DEVICE_SPACE: "disk-full",
  NS_ERROR_FILE_ACCESS_DENIED: "access-denied",
};
const SECRET_HEADERS: ReadonlySet<string> = new Set(
  DEFAULT_REDACTION_RULES.filter((rule) => rule.target === "header").flatMap((rule) => rule.names),
);

interface Sink {
  /** Set by the sink's own onStopRequest, after it closed its stream. */
  result: SinkResult | null;
  bytes: CopiedBytes | null;
  /** file-tee only: the watchdog/chunk guard closes it at the cap; shutdown closes it so the tee stops writing. */
  id: ExchangeId | null;
  output: FileOutputStream | null;
  part: string | null;
  readonly cap: number;
  cappedAt: number | null;
}

interface LiveEntry {
  capture: Capture;
  /** The object the latest topic delivered: an internal redirect (a service worker's interception) keeps the id and replaces the object. */
  channel: HttpChannel;
  site: Site | null;
  sink: Sink | null;
  upload: PendingUpload | null;
  stop: StopFacts | null;
}

export interface Recorder {
  setRoutes(routes: CompiledRoutes): void;
  /** Removes the observers, closes every file tee, and writes an abandoned line for each live capture. */
  stop(reason: AbandonReason): void;
  /** Every capture still live, as an export lists it: in progress, never as complete. */
  readonly snapshot: () => readonly { readonly site: Site | null; readonly live: LiveExchange }[];
  readonly counts: () => {
    readonly live: number;
    readonly overflow: number;
    readonly overBudgetReentries: number;
    readonly startupBufferedPeak: number;
    readonly startupSuspends: number;
    readonly observerErrors: readonly string[];
    /** Main-thread milliseconds spent in each topic's observer, for the harness's cost breakdown. */
    readonly observerMs: Readonly<Record<string, number>>;
  };
  resetGuardCounts(): void;
}

const optional = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

const version = (read: (major: { value?: number }, minor: { value?: number }) => void): string => {
  const major: { value?: number } = {};
  const minor: { value?: number } = {};
  try {
    read(major, minor);
    return `HTTP/${String(major.value ?? 1)}.${String(minor.value ?? 1)}`;
  } catch {
    return "HTTP/1.1";
  }
};

const headersOf = (
  visit: (visitor: HeaderVisitor) => void,
  neverStoreSecrets: boolean,
): Header[] => {
  const headers: Header[] = [];
  try {
    visit({
      visitHeader: (name, value) => {
        headers.push([
          name,
          neverStoreSecrets && SECRET_HEADERS.has(name.toLowerCase()) ? null : value,
        ]);
      },
    });
  } catch {
    // A channel without headers of this kind.
  }
  return headers;
};

const span = (from: number, to: number): number | null =>
  from > 0 && to >= from ? (to - from) / 1000 : null;

const timingsOf = (channel: HttpChannel): Timings => {
  const t = optional(() => channel.QueryInterface(Ci.nsITimedChannel));
  if (t === null)
    return {
      blocked: null,
      dns: null,
      connect: null,
      ssl: null,
      send: null,
      wait: null,
      receive: null,
    };
  const firstAfterOpen =
    [t.domainLookupStartTime, t.connectStartTime, t.requestStartTime].find((v) => v > 0) ?? 0;
  return {
    blocked: span(t.asyncOpenTime, firstAfterOpen),
    dns: span(t.domainLookupStartTime, t.domainLookupEndTime),
    connect: span(t.connectStartTime, t.connectEndTime),
    ssl: span(t.secureConnectionStartTime, t.connectEndTime),
    send: null,
    wait: span(t.requestStartTime, t.responseStartTime),
    receive: span(t.responseStartTime, t.responseEndTime),
  };
};

const stopFactsOf = (channel: HttpChannel): StopFacts => {
  const status = channel.status;
  return {
    status: Components.isSuccessCode(status)
      ? { kind: "ok" }
      : status === NS_BINDING_REDIRECTED
        ? { kind: "redirected" }
        : { kind: "failed", error: errorName(status) as NetError },
    endedAt: Date.now() as EpochMs,
    timings: timingsOf(channel),
    transferSize: (optional(() => channel.transferSize) ?? 0) as ByteCount,
    encodedBodySize: (optional(() => channel.encodedBodySize) ?? 0) as ByteCount,
  };
};

/** Worker channels have no browsing context: null is a value here, never a TypeError. */
const topSiteOfChannel = (channel: HttpChannel): Site | null => {
  const info = channel.loadInfo;
  const context = info.browsingContext;
  const principal = info.loadingPrincipal ?? info.triggeringPrincipal;
  return topSiteOf({
    policyType: info.externalContentPolicyType,
    isAttachment:
      optional(() => channel.contentDisposition === Ci.nsIChannel.DISPOSITION_ATTACHMENT) ?? false,
    channelSite: siteOfUri(channel.URI),
    tabDocumentSite: siteOfUri(context?.top.currentWindowGlobal?.documentURI),
    principalSite: principal.isContentPrincipal ? siteOfHost(principal.asciiHost) : null,
    hasBrowsingContext: context !== null,
  }).site;
};

const gateFactsOf = (channel: HttpChannel, topSite: Site | null): GateFacts => {
  const info = channel.loadInfo;
  return {
    privateBrowsingId: info.originAttributes.privateBrowsingId,
    triggeringIsSystem: info.triggeringPrincipal.isSystemPrincipal,
    browsingContextId: info.browsingContextID,
    loadingScheme: info.loadingPrincipal?.scheme ?? "",
    topSite,
  };
};

const header = (channel: HttpChannel, name: string): string | null => {
  const value = optional(() => channel.getResponseHeader(name));
  return value === null || value === "" ? null : value;
};

export function startRecorder(options: {
  readonly run: RunId;
  readonly routes: CompiledRoutes;
  readonly store: Store;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly timers: Timers;
}): Recorder {
  const { run, store, root, modes, timers } = options;
  let routes = options.routes;
  let stopped = false;
  let overflow = 0;
  let overBudgetReentries = 0;
  let admitted = 0;
  let startupBufferedBytes = 0;
  let startupBufferedPeak = 0;
  let startupSuspends = 0;
  const observerErrors: string[] = [];
  const observerMs: Record<string, number> = {};
  const live = new Map<number, LiveEntry>();
  const watched = new Set<Sink>();
  const pendingStartup = new Set<() => void>();
  const drainChannels = new Map<HttpChannel, () => void>();
  const pauseForDrain = (channel: HttpChannel): void => {
    if (stopped || drainChannels.has(channel) || !store.needsRetentionDrain()) return;
    optional(() => channel.suspend());
    let unsub: () => void = () => undefined;
    const release = (): void => {
      if (!drainChannels.has(channel)) return;
      drainChannels.delete(channel);
      unsub();
      optional(() => channel.resume());
    };
    drainChannels.set(channel, release);
    unsub = store.onRetentionDrain(release);
  };
  let watchdog: { cancel(): void } | null = null;
  const neverStore = (): boolean => store.settings().user.secretStorage === "never-store";

  const tabOf = (channel: HttpChannel): TabKey | null => {
    const browserId = channel.loadInfo.browsingContext?.top.browserId ?? 0;
    return browserId > 0 ? { run, browserId } : null;
  };

  const requestFacts = (entry: LiveEntry, id: ExchangeId, startedAt: EpochMs): RequestFacts => {
    const { channel } = entry;
    const internal = optional(() => channel.QueryInterface(Ci.nsIHttpChannelInternal));
    return {
      id,
      url: channel.URI.spec,
      method: channel.requestMethod,
      httpVersion:
        internal === null ? "HTTP/1.1" : version((a, b) => internal.getRequestVersion(a, b)),
      headers: headersOf((v) => channel.visitRequestHeaders(v), neverStore()),
      startedAt,
      tab: tabOf(channel),
      topSite: entry.site,
      policyType: channel.loadInfo.externalContentPolicyType,
    };
  };

  const responseFacts = (channel: HttpChannel, topic: ExamineTopic): ResponseFacts => {
    const internal = optional(() => channel.QueryInterface(Ci.nsIHttpChannelInternal));
    const status = channel.responseStatus;
    const location = header(channel, "Location");
    const length = channel.contentLength;
    return {
      status,
      statusText: optional(() => channel.responseStatusText) ?? "",
      httpVersion:
        internal === null ? "HTTP/1.1" : version((a, b) => internal.getResponseVersion(a, b)),
      headers: headersOf((v) => channel.visitResponseHeaders(v), neverStore()),
      mimeType: (optional(() => channel.contentType) ?? "").toLowerCase() || null,
      contentLength: length >= 0 ? (length as ByteCount) : null,
      contentEncoding: header(channel, "Content-Encoding")?.trim().toLowerCase() ?? null,
      source: EXAMINE_SOURCE[topic],
      redirectTo:
        location !== null && status >= 300 && status < 400
          ? (optional(() => channel.URI.resolve(location)) ?? null)
          : null,
      remoteAddress: internal === null ? null : optional(() => internal.remoteAddress),
    };
  };

  /** A rewindable upload stream up to 1 MiB, read natively and rewound to where it was. */
  const readUpload = (entry: LiveEntry): UploadOutcome => {
    const stream = optional(() => entry.channel.QueryInterface(Ci.nsIUploadChannel).uploadStream);
    if (stream === null) return { kind: "none" };
    if (neverStore()) return { kind: "not-kept", reason: "upload-never-stored" };
    const seekable = optional(() =>
      (stream as unknown as { QueryInterface(i: XpcomInterface): SeekableStream }).QueryInterface(
        Ci.nsISeekableStream,
      ),
    );
    if (seekable === null) return { kind: "not-kept", reason: "upload-not-rewindable" };
    const position = seekable.tell();
    try {
      seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
      const length = seekable.available();
      if (length > UPLOAD_MAX) return { kind: "not-kept", reason: "upload-too-large" };
      if (length === 0) return { kind: "none" };
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      const buffer = NetUtil.readInputStream(seekable, length);
      const copy = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
        Ci.nsIArrayBufferInputStream,
      );
      copy.setData(buffer, 0, buffer.byteLength);
      const contentType = optional(() => entry.channel.getRequestHeader("Content-Type"));
      const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() || null;
      entry.upload = { stream: copy, length: buffer.byteLength as ByteCount, mimeType };
      return { kind: "none" };
    } catch {
      return { kind: "not-kept", reason: "upload-not-rewindable" };
    } finally {
      optional(() => seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, position));
    }
  };

  const watch = (sink: Sink): void => {
    watched.add(sink);
    watchdog ??= timers.repeat(WATCHDOG_MS, () => {
      for (const each of watched) {
        if (
          each.result !== null ||
          each.part === null ||
          each.output === null ||
          each.id === null
        ) {
          watched.delete(each);
          continue;
        }
        const size = optional(() => localFile(each.part ?? "").fileSize) ?? 0;
        const budget = store.partBudget(each.id, each.cap);
        if (size >= budget) {
          optional(() => each.output?.close());
          each.cappedAt = size;
          watched.delete(each);
        }
        store.updatePart(each.id, size);
      }
      if (watched.size === 0) {
        watchdog?.cancel();
        watchdog = null;
      }
    });
  };

  const commit = (entry: LiveEntry): void => {
    const { capture, stop } = entry;
    if (stop === null) return;
    if (capture.phase === "copying" && entry.sink?.result === null) return;
    live.delete(entry.channel.channelId);
    switch (capture.phase) {
      case "opened": {
        const request = requestFacts(entry, capture.id, capture.startedAt);
        store.commitUnanswered(entry.site, unanswered(capture, request, stop, { kind: "none" }));
        return;
      }
      case "copying":
        store.commit({
          site: entry.site,
          input: {
            capture,
            stop,
            sink: entry.sink?.result ?? { kind: "prepare-failed", why: "other" },
          },
          bytes: entry.sink?.bytes ?? null,
          upload: entry.upload,
        });
        return;
      case "decided":
      case "awaiting-merge":
        store.commit({
          site: entry.site,
          input: { capture, stop, sink: null },
          bytes: null,
          upload: entry.upload,
        });
        return;
    }
  };

  /** Every object is built before the channel is touched: a throw between setNewListener and init hangs the request. */
  const startSink = (
    entry: LiveEntry,
    route: Extract<Route, { readonly kind: "memory-tee" | "file-tee" }>,
    id: ExchangeId,
    expectedBytes: ByteCount | null,
  ): Sink => {
    const traceable = entry.channel.QueryInterface(Ci.nsITraceableChannel);
    const tee = Cc["@mozilla.org/network/stream-listener-tee;1"].createInstance(
      Ci.nsIStreamListenerTee,
    );
    if (route.kind === "memory-tee") {
      const storage = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
      storage.init(STORAGE_SEGMENT, Math.max(route.cap, 1));
      const output = storage.getOutputStream(0);
      const sink: Sink = {
        result: null,
        bytes: null,
        id: null,
        output: null,
        part: null,
        cap: route.cap,
        cappedAt: null,
      };
      const observer: RequestObserver = {
        onStartRequest: () => undefined,
        onStopRequest: () => {
          optional(() => output.close());
          if (stopped) return;
          sink.result = { kind: "closed", bytes: storage.length as ByteCount, cappedAt: null };
          sink.bytes = { kind: "memory", stream: storage.newInputStream(0) };
          commit(entry);
        },
      };
      const original = traceable.setNewListener(tee);
      tee.init(original, output, observer);
      return sink;
    }
    const part = PathUtils.join(root, ...partPath(id));
    const guardFileChunk = (
      channel: HttpChannel,
      streamTee: StreamListener,
      getOriginal: () => StreamListener,
      partId: ExchangeId,
      sink: Sink,
      projectedRef: { value: number },
      closeAtCap: (size: number) => void,
      cappedRef: { value: boolean },
      request: unknown,
      stream: InputStream,
      offset: number,
      count: number,
    ): void => {
      if (cappedRef.value) {
        getOriginal().onDataAvailable(request, stream, offset, count);
        return;
      }
      if (count > 0) {
        const current = optional(() => localFile(part).fileSize) ?? projectedRef.value;
        const budget = store.partBudget(partId, sink.cap);
        if (current >= budget) {
          if (budget > 0 && current > 0) overBudgetReentries += 1;
          closeAtCap(current);
          getOriginal().onDataAvailable(request, stream, offset, count);
          return;
        }
        streamTee.onDataAvailable(request, stream, offset, count);
        const after = optional(() => localFile(part).fileSize) ?? current + count;
        projectedRef.value = after;
        if (after >= budget) {
          closeAtCap(after);
        } else {
          store.updatePart(partId, after);
          pauseForDrain(channel);
        }
        return;
      }
      streamTee.onDataAvailable(request, stream, offset, count);
    };
    const scanDone = store.isScanCompleted();
    const initialBudget = scanDone ? route.cap : store.partBudget(id, route.cap);
    if (store.needsStartupBuffer(expectedBytes) || (!scanDone && initialBudget === 0)) {
      if (
        store.isReady() &&
        !scanDone &&
        initialBudget === 0 &&
        startupBufferedBytes >= STARTUP_TOTAL_BUFFER_MAX
      ) {
        const sink: Sink = {
          result: null,
          bytes: null,
          id: null,
          output: null,
          part: null,
          cap: route.cap,
          cappedAt: 0,
        };
        let original!: StreamListener;
        const passListener: StreamListener = {
          onStartRequest: (request) => original.onStartRequest(request),
          onDataAvailable: (request, stream, offset, count) =>
            original.onDataAvailable(request, stream, offset, count),
          onStopRequest: (request, status) => {
            original.onStopRequest(request, status);
            if (stopped) return;
            sink.result = {
              kind: "closed",
              bytes: 0 as ByteCount,
              cappedAt: 0 as ByteCount,
              cutWhy: "scan-timeout",
            };
            sink.bytes = null;
            commit(entry);
          },
        };
        original = traceable.setNewListener(passListener);
        return sink;
      }
      const storage = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
      storage.init(STORAGE_SEGMENT, Math.max(route.cap, 1));
      const storageOut = storage.getOutputStream(0);
      const sink: Sink = {
        result: null,
        bytes: null,
        id,
        output: null,
        part: null,
        cap: route.cap,
        cappedAt: null,
      };
      let phase: "buffering" | "flushing" | "file" | "done" = "buffering";
      const cappedRef = { value: false };
      let storageClosed = false;
      let cappedStorageBytes: number | null = null;
      let cutWhy: "scan-timeout" | null = null;
      let suspended = false;
      let buffered = 0;
      const projectedRef = { value: 0 };
      let stopPending: { readonly request: unknown; readonly status: number } | null = null;
      let unsubscribeReady: () => void = () => undefined;
      let unsubscribeScan: (() => void) | null = null;
      let unsubscribeDrain: (() => void) | null = null;
      let flushRelease: (() => void) | null = null;
      let flushReservedBytes = 0;
      let flushOverflow: StorageStream | null = null;
      let flushOverflowOut: ReturnType<StorageStream["getOutputStream"]> | null = null;
      let flushOverflowTee: StreamListenerTee | null = null;
      const fileObserver: RequestObserver = {
        onStartRequest: () => undefined,
        onStopRequest: () => {
          optional(() => sink.output?.close());
          watched.delete(sink);
          if (stopped) return;
          const bytes = optional(() => localFile(part).fileSize) ?? projectedRef.value;
          store.updatePart(id, bytes, true);
          sink.result = {
            kind: "closed",
            bytes: bytes as ByteCount,
            cappedAt: (sink.cappedAt ?? (bytes >= sink.cap ? bytes : null)) as ByteCount | null,
          };
          sink.bytes = { kind: "part", id };
          commit(entry);
        },
      };
      const storageTee = Cc["@mozilla.org/network/stream-listener-tee;1"].createInstance(
        Ci.nsIStreamListenerTee,
      );
      let fileTee: StreamListenerTee | null = null;
      const closeStorageOut = (capAt: number | null): void => {
        if (!storageClosed) {
          storageClosed = true;
          optional(() => storageOut.close());
        }
        if (capAt !== null && cappedStorageBytes === null) {
          cappedStorageBytes = capAt;
        }
      };
      const closeAtCap = (size: number): void => {
        cappedRef.value = true;
        if (phase === "buffering") {
          closeStorageOut(size);
        } else {
          optional(() => flushOverflowOut?.close());
          optional(() => sink.output?.close());
          if (phase === "file") store.updatePart(id, size, true);
        }
        sink.cappedAt = size;
        watched.delete(sink);
      };
      const closeAtScanTimeout = (size: number): void => {
        cappedRef.value = true;
        cutWhy = "scan-timeout";
        closeStorageOut(size);
        sink.cappedAt = size;
        watched.delete(sink);
      };
      const releaseFlushReserve = (): void => {
        unsubscribeDrain?.();
        unsubscribeDrain = null;
        flushRelease?.();
        flushRelease = null;
        flushReservedBytes = 0;
      };
      const releaseStartup = (): void => {
        if (buffered > 0) {
          startupBufferedBytes = Math.max(0, startupBufferedBytes - buffered);
        }
        pendingStartup.delete(abortStartup);
        unsubscribeReady();
        unsubscribeScan?.();
        unsubscribeScan = null;
        releaseFlushReserve();
      };
      const abortStartup = (): void => {
        unsubscribeReady();
        unsubscribeScan?.();
        unsubscribeScan = null;
        releaseFlushReserve();
        if (suspended) {
          suspended = false;
          optional(() => entry.channel.resume());
        }
        closeStorageOut(null);
        optional(() => flushOverflowOut?.close());
      };
      const startFileFlush = (): void => {
        if (phase !== "buffering") return;
        if (stopped) {
          phase = "flushing";
          pendingStartup.delete(abortStartup);
          abortStartup();
          return;
        }
        if (cappedRef.value) {
          releaseFlushReserve();
          return;
        }
        const budget = store.partBudget(id, sink.cap);
        if (budget === 0 && !store.isScanCompleted()) {
          if (suspended) {
            suspended = false;
            optional(() => entry.channel.resume());
          }
          if (unsubscribeScan === null) {
            unsubscribeScan = store.onScanComplete(startFileFlush);
          }
          return;
        }
        if (!suspended) {
          suspended = true;
          optional(() => entry.channel.suspend());
        }
        if (buffered > 0) {
          if (flushReservedBytes !== buffered) {
            flushRelease?.();
            flushReservedBytes = buffered;
            flushRelease = store.reserveWrite(flushReservedBytes);
          }
          if (store.needsRetentionDrain()) {
            if (unsubscribeDrain === null) {
              unsubscribeDrain = store.onRetentionDrain(() => {
                unsubscribeDrain = null;
                startFileFlush();
              });
            }
            return;
          }
        }
        phase = "flushing";
        closeStorageOut(null);
        let output: FileOutputStream;
        try {
          output = openOutput(part, false, modes);
        } catch (error) {
          const name = errorName((error as { result?: number }).result ?? 0);
          releaseStartup();
          phase = "done";
          sink.result = { kind: "prepare-failed", why: PREPARE_FAILURES[name] ?? "other" };
          if (suspended) {
            suspended = false;
            optional(() => entry.channel.resume());
          }
          if (stopPending !== null) {
            const pending = stopPending;
            stopPending = null;
            original.onStopRequest(pending.request, pending.status);
          }
          return;
        }
        sink.output = output;
        sink.part = part;
        const tee2 = Cc["@mozilla.org/network/stream-listener-tee;1"].createInstance(
          Ci.nsIStreamListenerTee,
        );
        tee2.init(original, output, fileObserver);
        fileTee = tee2;
        const knownExpected =
          expectedBytes !== null && expectedBytes > 0 ? Math.min(expectedBytes, sink.cap) : 0;
        store.openPart(id, part, Math.max(buffered, knownExpected));
        releaseFlushReserve();
        if (budget === 0) {
          store.updatePart(id, 0, true);
          projectedRef.value = 0;
          cappedRef.value = true;
          sink.cappedAt = 0;
        } else {
          store.updatePart(id, buffered);
          projectedRef.value = buffered;
          if (buffered >= budget) {
            cappedRef.value = true;
            sink.cappedAt = buffered;
          }
        }
        const finishSwitch = (): void => {
          releaseStartup();
          if (stopped) {
            optional(() => output.close());
            if (suspended) {
              suspended = false;
              optional(() => entry.channel.resume());
            }
            return;
          }
          phase = "file";
          if (cappedRef.value) optional(() => output.close());
          else watch(sink);
          if (suspended) {
            suspended = false;
            optional(() => entry.channel.resume());
          }
          if (!cappedRef.value) pauseForDrain(entry.channel);
          if (stopPending !== null) {
            const pending = stopPending;
            stopPending = null;
            tee2.onStopRequest(pending.request, pending.status);
          }
        };
        if (buffered === 0 || budget === 0) {
          finishSwitch();
          return;
        }
        const transport = Cc["@mozilla.org/network/stream-transport-service;1"].getService(
          Ci.nsIEventTarget,
        );
        const copyStreamToOutput = (inputStream: InputStream, done: () => void): void => {
          const copier = Cc["@mozilla.org/network/async-stream-copier;1"].createInstance(
            Ci.nsIAsyncStreamCopier,
          );
          copier.init(inputStream, output, transport, true, false, COPY_CHUNK, true, false);
          copier.asyncCopy(
            {
              onStartRequest: () => undefined,
              onStopRequest: () => done(),
            },
            null,
          );
        };
        const afterInitialCopy = (): void => {
          optional(() => flushOverflowOut?.close());
          const extra = flushOverflow;
          flushOverflow = null;
          flushOverflowOut = null;
          flushOverflowTee = null;
          if (extra === null || extra.length === 0 || stopped || cappedRef.value) {
            finishSwitch();
            return;
          }
          const nextTotal = projectedRef.value + extra.length;
          projectedRef.value = nextTotal;
          store.updatePart(id, nextTotal);
          if (nextTotal >= store.partBudget(id, sink.cap)) {
            cappedRef.value = true;
            sink.cappedAt = nextTotal;
          }
          copyStreamToOutput(extra.newInputStream(0), finishSwitch);
        };
        copyStreamToOutput(storage.newInputStream(0), afterInitialCopy);
      };
      const appendBufferedChunk = (
        request: unknown,
        stream: InputStream,
        offset: number,
        count: number,
      ): void => {
        storageTee.onDataAvailable(request, stream, offset, count);
        const nextLen = storage.length;
        const delta = Math.max(0, nextLen - buffered);
        buffered = nextLen;
        startupBufferedBytes += delta;
        if (startupBufferedBytes > startupBufferedPeak) {
          startupBufferedPeak = startupBufferedBytes;
        }
      };
      const appendFlushOverflowChunk = (
        request: unknown,
        stream: InputStream,
        offset: number,
        count: number,
      ): void => {
        if (flushOverflow === null || flushOverflowTee === null) {
          flushOverflow = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
          flushOverflow.init(STORAGE_SEGMENT, Math.max(sink.cap, 1));
          flushOverflowOut = flushOverflow.getOutputStream(0);
          flushOverflowTee = Cc["@mozilla.org/network/stream-listener-tee;1"].createInstance(
            Ci.nsIStreamListenerTee,
          );
          flushOverflowTee.init(original, flushOverflowOut, {
            onStartRequest: () => undefined,
            onStopRequest: () => undefined,
          });
        }
        flushOverflowTee.onDataAvailable(request, stream, offset, count);
      };
      const guardListener: StreamListener = {
        onStartRequest: (request) => storageTee.onStartRequest(request),
        onDataAvailable: (request, stream, offset, count) => {
          if (phase === "buffering") {
            // Once storageOut is closed, never call storageTee.onDataAvailable: Gecko nsIStorageStream grows length with 0xE5 fill after Close().
            if (cappedRef.value || storageClosed) {
              original.onDataAvailable(request, stream, offset, count);
              return;
            }
            if (count > 0) {
              if (buffered >= sink.cap) {
                closeAtCap(buffered);
                original.onDataAvailable(request, stream, offset, count);
                return;
              }
              const postTimeout = store.isReady() && !store.isScanCompleted();
              if (postTimeout) {
                if (
                  buffered >= STARTUP_PER_STREAM_MAX ||
                  startupBufferedBytes >= STARTUP_TOTAL_BUFFER_MAX
                ) {
                  closeAtScanTimeout(buffered);
                  original.onDataAvailable(request, stream, offset, count);
                  return;
                }
                appendBufferedChunk(request, stream, offset, count);
                if (buffered >= sink.cap) {
                  closeAtCap(buffered);
                } else if (
                  buffered >= STARTUP_PER_STREAM_MAX ||
                  startupBufferedBytes >= STARTUP_TOTAL_BUFFER_MAX
                ) {
                  closeAtScanTimeout(buffered);
                }
                return;
              }
              const budget = store.isScanCompleted() ? store.partBudget(id, sink.cap) : sink.cap;
              if (buffered >= budget) {
                if (budget > 0 && buffered > 0) overBudgetReentries += 1;
                closeAtCap(buffered);
                original.onDataAvailable(request, stream, offset, count);
                return;
              }
              appendBufferedChunk(request, stream, offset, count);
              if (buffered >= budget) {
                closeAtCap(buffered);
              } else if (
                !suspended &&
                (buffered >= STARTUP_PER_STREAM_MAX ||
                  startupBufferedBytes >= STARTUP_TOTAL_BUFFER_MAX)
              ) {
                suspended = true;
                startupSuspends += 1;
                optional(() => entry.channel.suspend());
              }
              return;
            }
            storageTee.onDataAvailable(request, stream, offset, count);
            return;
          }
          if (phase === "flushing" || fileTee === null) {
            if (cappedRef.value) {
              original.onDataAvailable(request, stream, offset, count);
              return;
            }
            if (count > 0) {
              appendFlushOverflowChunk(request, stream, offset, count);
              return;
            }
            original.onDataAvailable(request, stream, offset, count);
            return;
          }
          guardFileChunk(
            entry.channel,
            fileTee,
            () => original,
            id,
            sink,
            projectedRef,
            closeAtCap,
            cappedRef,
            request,
            stream,
            offset,
            count,
          );
        },
        onStopRequest: (request, status) => {
          if (phase === "buffering") {
            phase = "done";
            const savedBytes = cappedStorageBytes ?? storage.length;
            const closedBeforeStop = storageClosed;
            closeStorageOut(null);
            releaseStartup();
            if (closedBeforeStop) original.onStopRequest(request, status);
            else storageTee.onStopRequest(request, status);
            if (stopped) return;
            if (cutWhy === "scan-timeout") {
              sink.result = {
                kind: "closed",
                bytes: savedBytes as ByteCount,
                cappedAt: savedBytes as ByteCount,
                cutWhy: "scan-timeout",
              };
              sink.bytes =
                savedBytes === 0
                  ? null
                  : {
                      kind: "buffer",
                      id,
                      stream: storage.newInputStream(0),
                      length: savedBytes,
                    };
              commit(entry);
              return;
            }
            sink.result = {
              kind: "closed",
              bytes: savedBytes as ByteCount,
              cappedAt: (sink.cappedAt ??
                (savedBytes >= sink.cap ? savedBytes : null)) as ByteCount | null,
            };
            sink.bytes = {
              kind: "buffer",
              id,
              stream: storage.newInputStream(0),
              length: savedBytes,
            };
            commit(entry);
            return;
          }
          if (phase === "flushing") {
            stopPending = { request, status };
            return;
          }
          (fileTee ?? storageTee).onStopRequest(request, status);
        },
      };
      const original = traceable.setNewListener(guardListener);
      storageTee.init(original, storageOut, {
        onStartRequest: () => undefined,
        onStopRequest: () => undefined,
      });
      pendingStartup.add(abortStartup);
      if (store.isReady() && !store.isScanCompleted()) {
        unsubscribeScan = store.onScanComplete(startFileFlush);
      } else {
        unsubscribeReady = store.onReady(startFileFlush);
      }
      return sink;
    }
    let output: FileOutputStream;
    try {
      output = openOutput(part, false, modes);
    } catch (error) {
      const name = errorName((error as { result?: number }).result ?? 0);
      return {
        result: { kind: "prepare-failed", why: PREPARE_FAILURES[name] ?? "other" },
        bytes: null,
        id: null,
        output: null,
        part: null,
        cap: route.cap,
        cappedAt: null,
      };
    }
    store.openPart(
      id,
      part,
      expectedBytes !== null ? Math.min(expectedBytes, route.cap) : undefined,
    );
    const sink: Sink = {
      result: null,
      bytes: null,
      id,
      output,
      part,
      cap: route.cap,
      cappedAt: null,
    };
    const cappedRef = { value: false };
    const closeAtCap = (size: number): void => {
      cappedRef.value = true;
      optional(() => output.close());
      sink.cappedAt = size;
      watched.delete(sink);
      store.updatePart(id, size, true);
    };
    const observer: RequestObserver = {
      onStartRequest: () => undefined,
      onStopRequest: () => {
        optional(() => output.close());
        watched.delete(sink);
        if (stopped) return;
        const bytes = optional(() => localFile(part).fileSize) ?? 0;
        store.updatePart(id, bytes, true);
        sink.result = {
          kind: "closed",
          bytes: bytes as ByteCount,
          // A part stopped at either the per-body cap or the remaining ledger budget keeps its first part.
          cappedAt: (sink.cappedAt ?? (bytes >= sink.cap ? bytes : null)) as ByteCount | null,
        };
        sink.bytes = { kind: "part", id };
        commit(entry);
      },
    };
    const projectedRef = { value: 0 };
    const guardListener: StreamListener = {
      onStartRequest: (request) => tee.onStartRequest(request),
      onDataAvailable: (request, stream, offset, count) =>
        guardFileChunk(
          entry.channel,
          tee,
          () => original,
          id,
          sink,
          projectedRef,
          closeAtCap,
          cappedRef,
          request,
          stream,
          offset,
          count,
        ),
      onStopRequest: (request, status) => tee.onStopRequest(request, status),
    };
    const original = traceable.setNewListener(guardListener);
    tee.init(original, output, observer);
    watch(sink);
    pauseForDrain(entry.channel);
    return sink;
  };

  const admit = (channel: HttpChannel): LiveEntry | null => {
    if (!(channel.URI.schemeIs("http") || channel.URI.schemeIs("https"))) return null;
    if (firstGate(gateFactsOf(channel, null), routes.excluded) !== null) return null;
    const key = parseChannelKey(String(channel.channelId));
    if (key === null) return null;
    if (live.size >= MAX_LIVE) {
      overflow += 1;
      return null;
    }
    admitted += 1;
    if (admitted % SWEEP_EVERY === 0) {
      for (const [id, each] of live) {
        if (
          each.capture.phase === "opened" &&
          optional(() => each.channel.status) === NS_BINDING_REDIRECTED
        )
          live.delete(id);
      }
    }
    const entry: LiveEntry = {
      capture: open(exchangeId(run, key), Date.now() as EpochMs),
      channel,
      site: null,
      sink: null,
      upload: null,
      stop: null,
    };
    live.set(channel.channelId, entry);
    return entry;
  };

  const onExamine = (channel: HttpChannel, topic: ExamineTopic): void => {
    const entry = live.get(channel.channelId) ?? admit(channel);
    if (entry === null) return;
    entry.channel = channel;
    const before = entry.capture;
    if (!EXAMINE_ACCEPTS[before.phase].topics.includes(topic)) return;
    const site = topSiteOfChannel(channel);
    if (firstGate(gateFactsOf(channel, site), routes.excluded) !== null) {
      live.delete(channel.channelId);
      return;
    }
    entry.site = site;
    const id = before.id;
    const response = responseFacts(channel, topic);
    const startedAt = before.phase === "opened" ? before.startedAt : before.facts.request.startedAt;
    const facts: ExchangeFacts = { request: requestFacts(entry, id, startedAt), response };
    const route = chooseRoute(routes, {
      method: channel.requestMethod,
      status: response.status,
      source: response.source,
      mimeType: response.mimeType,
      contentLength: response.contentLength,
      hasLocation: header(channel, "Location") !== null,
    });
    const upload = before.phase === "opened" ? readUpload(entry) : before.upload;
    const next = examine(before, topic, facts, route, upload);
    if (next.phase === "copying" && before.phase !== "copying") {
      const copy = next.route;
      entry.sink =
        copy.kind === "memory-tee" || copy.kind === "file-tee"
          ? startSink(entry, copy, id, response.contentLength)
          : {
              result: { kind: "prepare-failed", why: "other" },
              bytes: null,
              id: null,
              output: null,
              part: null,
              cap: 0,
              cappedAt: null,
            };
    }
    entry.capture = next;
  };

  const onStop = (channel: HttpChannel): void => {
    const entry = live.get(channel.channelId);
    if (entry === undefined) return;
    entry.channel = channel;
    if (entry.capture.phase === "opened") entry.site = topSiteOfChannel(channel);
    entry.stop = stopFactsOf(channel);
    commit(entry);
  };

  const observer: Observer = {
    observe: (subject, topic) => {
      const startedAt = ChromeUtils.now();
      const channel = optional(() => (subject as HttpChannel).QueryInterface(Ci.nsIHttpChannel));
      if (channel === null) return;
      try {
        if (topic === OPENING) admit(channel);
        else if (topic === STOP) onStop(channel);
        else if (isExamineTopic(topic)) onExamine(channel, topic);
      } catch (error) {
        if (observerErrors.length < MAX_ERRORS_KEPT)
          observerErrors.push(`${topic}: ${String(error)}`);
      } finally {
        observerMs[topic] = (observerMs[topic] ?? 0) + ChromeUtils.now() - startedAt;
      }
    },
  };
  for (const topic of TOPICS) Services.obs.addObserver(observer, topic);

  return {
    setRoutes: (next) => {
      routes = next;
    },
    stop: (reason) => {
      if (stopped) return;
      stopped = true;
      for (const topic of TOPICS) optional(() => Services.obs.removeObserver(observer, topic));
      watchdog?.cancel();
      watchdog = null;
      for (const abort of pendingStartup) abort();
      pendingStartup.clear();
      for (const release of drainChannels.values()) release();
      const abandoned = [...live.values()].map((entry) => {
        optional(() => entry.sink?.output?.close());
        const { capture } = entry;
        const request =
          capture.phase === "opened"
            ? requestFacts(entry, capture.id, capture.startedAt)
            : capture.facts.request;
        const site = entry.site ?? optional(() => topSiteOfChannel(entry.channel));
        return { site, exchange: abandon(capture, request, reason) };
      });
      live.clear();
      store.commitAbandoned(abandoned);
    },
    snapshot: () =>
      [...live.values()].map((entry) => {
        const { capture } = entry;
        const request =
          capture.phase === "opened"
            ? requestFacts(entry, capture.id, capture.startedAt)
            : capture.facts.request;
        const response = capture.phase === "opened" ? null : capture.facts.response;
        return { site: entry.site, live: { request, response, phase: capture.phase } };
      }),
    counts: () => ({
      live: live.size,
      overflow,
      overBudgetReentries,
      startupBufferedPeak,
      startupSuspends,
      observerErrors,
      observerMs,
    }),
    resetGuardCounts: () => {
      overBudgetReentries = 0;
      startupBufferedPeak = 0;
      startupSuspends = 0;
    },
  };
}
