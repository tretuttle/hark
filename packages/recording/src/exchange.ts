// One request and its response, from the moment the channel opens to its one line in the log. A state machine:
// opened, then decided, copying or awaiting-merge at examine, then answered at stop. A channel that stops without any
// examine is unanswered, and a capture still live at shutdown is abandoned. A 304 waits for its merged response.

import type { ByteCount, EpochMs, ExchangeId, PackId, Brand, Site, TabKey } from "./ids.ts";
import type { BodyRouteId, NotKeptReason, ResponseSource, Route } from "./routes.ts";

/** value null: never stored, because settings.secretStorage is "never-store" and the name is in the secret table. */
export type Header = readonly [name: string, value: string | null];

export interface RequestFacts {
  readonly id: ExchangeId;
  readonly url: string;
  readonly method: string;
  readonly httpVersion: string;
  readonly headers: readonly Header[];
  readonly startedAt: EpochMs;
  /** null for channels with no tab, such as a service worker's own network fetches. */
  readonly tab: TabKey | null;
  /** From TOP_SITE_RULES. null only when no rule can name one; such a channel joins no site's directory. */
  readonly topSite: Site | null;
  /** loadInfo.externalContentPolicyType. Type 6 starts a HAR page; the export maps it to `_resourceType`. */
  readonly policyType: number;
}

export interface ResponseFacts {
  readonly status: number;
  readonly statusText: string;
  readonly httpVersion: string;
  readonly headers: readonly Header[];
  /** Lowercased, parameters stripped. */
  readonly mimeType: string | null;
  /** Wire length. null when the channel reports -1. */
  readonly contentLength: ByteCount | null;
  /** Lowercased Content-Encoding. Stored bytes keep it; the export decodes. */
  readonly contentEncoding: string | null;
  readonly source: ResponseSource;
  /** The Location target of a redirect hop, resolved against the request URL. */
  readonly redirectTo: string | null;
  readonly remoteAddress: string | null;
}

/** HAR timing phases in ms; null where Gecko reports nothing (reused connection, cache hit). */
export interface Timings {
  readonly blocked: number | null;
  readonly dns: number | null;
  readonly connect: number | null;
  readonly ssl: number | null;
  readonly send: number | null;
  readonly wait: number | null;
  readonly receive: number | null;
}

/** ChromeUtils.getXPCOMErrorName of the stop status, such as NS_ERROR_CONNECTION_REFUSED. */
export type NetError = Brand<string, "NetError">;

/** NS_BINDING_REDIRECTED (0x804b0003) is a redirect hop's normal end, not a failure. */
export type StopStatus =
  | { readonly kind: "ok" }
  | { readonly kind: "redirected" }
  | { readonly kind: "failed"; readonly error: NetError };

export interface StopFacts {
  readonly status: StopStatus;
  readonly endedAt: EpochMs;
  readonly timings: Timings;
  readonly transferSize: ByteCount;
  /** 0 on service-worker channels and redirect hops. */
  readonly encodedBodySize: ByteCount;
}

/** Where copied bytes live. Both kinds hold wire bytes; the outcome's `encoding` says how to decode them. */
export type BodyLocation =
  | {
      readonly kind: "pack";
      readonly pack: PackId;
      readonly offset: number;
      readonly length: ByteCount;
    }
  | {
      readonly kind: "file";
      readonly site: Site;
      readonly id: ExchangeId;
      readonly length: ByteCount;
    };

/** What the sink reported after its own onStopRequest closed it. The adapter builds it; settle trusts it. */
export type SinkResult =
  | {
      readonly kind: "closed";
      readonly bytes: ByteCount;
      readonly cappedAt: ByteCount | null;
      readonly cutWhy?: "scan-timeout";
    }
  | { readonly kind: "prepare-failed"; readonly why: "disk-full" | "access-denied" | "other" };

export type IncompleteReason = "network-aborted" | "write-failed" | "scan-timeout";
/** isAppShutdown true is the browser closing; false is a disable, uninstall or update of this add-on. */
export type AbandonReason = "browser-closed" | "recording-stopped";

/**
 * How a stored body was checked at stop. length-matched: the count equals encodedBodySize, or Content-Length where
 * that is 0. sink-only: neither exists (a service-worker body of unknown length). first-part: the watchdog
 * closed the file at the body cap, so these are the body's first bytes and the rest was never kept. scan-timeout:
 * startup retention scan timed out and the RAM buffer capped out before disk budget could open.
 */
export type BodyCheck = "length-matched" | "sink-only" | "first-part" | "scan-timeout";

/** The protocol has no body: HEAD, 1xx, 204, 205, a redirect hop, a 304 that was not merged, or zero bytes. */
type EmptyBody = { readonly kind: "empty" };
type NotKeptBody<R extends NotKeptReason = NotKeptReason> = {
  readonly kind: "not-kept";
  readonly reason: R;
};
/** What a copy settles to at stop: its bytes, nothing for a declared empty body, or why the copy failed. */
export type CopiedBody =
  | EmptyBody
  | {
      readonly kind: "stored";
      readonly at: BodyLocation;
      readonly encoding: string | null;
      readonly check: BodyCheck;
    }
  | { readonly kind: "incomplete"; readonly reason: IncompleteReason };
export type SettledBody = CopiedBody | NotKeptBody;

/**
 * The bodies a route can settle to. A route decided at examine settles to its own outcome; a copy route to what the
 * copy gave. Derived from Route, so a row's id pairs only with the bodies that row can produce.
 */
type BodyOf<R> = R extends { readonly kind: "empty" | "awaiting-merge" }
  ? EmptyBody
  : R extends { readonly kind: "not-kept"; readonly reason: infer N extends NotKeptReason }
    ? NotKeptBody<N>
    : CopiedBody;
/** A route and the body it settled to, as the answered line stores them. */
export type RoutedBody = {
  [Id in BodyRouteId]: {
    readonly route: Id;
    readonly body: BodyOf<Extract<Route, { readonly id: Id }>>;
  };
}[BodyRouteId];

/**
 * An abandoned exchange never stored a body: "abandoned but complete" cannot be built. An interrupted body carries
 * no reason of its own; the exchange's `reason` says why, so the two cannot disagree.
 */
export type AbandonedBody = EmptyBody | NotKeptBody | { readonly kind: "incomplete" };

export type UploadOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "stored"; readonly at: BodyLocation; readonly mimeType: string | null }
  | {
      readonly kind: "not-kept";
      readonly reason: "upload-too-large" | "upload-not-rewindable" | "upload-never-stored";
    };

export interface ExchangeFacts {
  readonly request: RequestFacts;
  readonly response: ResponseFacts;
}

type CopyRoute = Extract<Route, { readonly kind: "memory-tee" | "file-tee" | "stream-filter" }>;
type DecidedRoute = Extract<Route, { readonly kind: "empty" | "not-kept" }>;

/** In-flight state, held only in the recorder's live map. The channel object stays in the adapter, never here. */
export type Capture =
  | { readonly phase: "opened"; readonly id: ExchangeId; readonly startedAt: EpochMs }
  /** A 304 from the network. Its status and headers are kept for the HAR; the body arrives with the merged topic. */
  | {
      readonly phase: "awaiting-merge";
      readonly id: ExchangeId;
      readonly facts: ExchangeFacts;
      readonly upload: UploadOutcome;
    }
  | {
      readonly phase: "decided";
      readonly id: ExchangeId;
      readonly facts: ExchangeFacts;
      readonly route: DecidedRoute;
      readonly upload: UploadOutcome;
    }
  | {
      readonly phase: "copying";
      readonly id: ExchangeId;
      readonly facts: ExchangeFacts;
      readonly route: CopyRoute;
      readonly upload: UploadOutcome;
    };

export type CapturePhase = Capture["phase"];

/** The four topics that deliver a response head. */
export type ExamineTopic =
  | "http-on-examine-response"
  | "http-on-examine-cached-response"
  | "http-on-examine-merged-response"
  | "service-worker-synthesized-response";

/**
 * Which examine topics each live phase accepts. Everything else is ignored, so a channel is decided once, except a
 * 304 that is decided again when its merged response arrives.
 * @public
 */
export const EXAMINE_ACCEPTS: {
  readonly [P in CapturePhase]: { readonly topics: readonly ExamineTopic[]; readonly why: string };
} = {
  opened: {
    topics: [
      "http-on-examine-response",
      "http-on-examine-cached-response",
      "http-on-examine-merged-response",
      "service-worker-synthesized-response",
    ],
    why: "The first response head decides the route.",
  },
  "awaiting-merge": {
    topics: ["http-on-examine-merged-response"],
    why: "A 304 from the network is merged into the cached entry and delivered once more with the full length; a tee attaches there.",
  },
  decided: {
    topics: [],
    why: "Decided once. A later topic on the same channel cannot change what was kept.",
  },
  copying: {
    topics: [],
    why: "A tee is attached and cannot be moved: a late setNewListener fails.",
  },
};

/** opened, at http-on-opening-request. Holds no facts: the request is read at examine or, if none comes, at stop. */
export function open(id: ExchangeId, startedAt: EpochMs): Capture {
  return { phase: "opened", id, startedAt };
}

/** A merged 304 keeps the 304's head for the HAR and takes the fields that describe the body from the merged head. */
function mergedResponse(revalidation: ResponseFacts, merged: ResponseFacts): ResponseFacts {
  return {
    ...revalidation,
    mimeType: merged.mimeType,
    contentLength: merged.contentLength,
    contentEncoding: merged.contentEncoding,
    source: merged.source,
  };
}

/**
 * Applies EXAMINE_ACCEPTS and returns the same capture for an ignored topic. For awaiting-merge the route comes from
 * the merged head and the upload read at the first examine stays.
 */
export function examine(
  capture: Capture,
  topic: ExamineTopic,
  facts: ExchangeFacts,
  route: Route,
  upload: UploadOutcome,
): Capture {
  if (!EXAMINE_ACCEPTS[capture.phase].topics.includes(topic)) return capture;
  const next =
    capture.phase === "awaiting-merge"
      ? {
          id: capture.id,
          facts: {
            request: capture.facts.request,
            response: mergedResponse(capture.facts.response, facts.response),
          },
          upload: capture.upload,
        }
      : { id: capture.id, facts, upload };
  switch (route.kind) {
    case "awaiting-merge":
      return capture.phase === "awaiting-merge" ? capture : { phase: "awaiting-merge", ...next };
    case "empty":
    case "not-kept":
      return { phase: "decided", ...next, route };
    case "memory-tee":
    case "file-tee":
    case "stream-filter":
      return { phase: "copying", ...next, route };
  }
}

/** What settle may be given: never an "opened" capture, which settles through unanswered. */
export type ExaminedCapture = Exclude<Capture, { readonly phase: "opened" }>;
type CopyingCapture = Extract<Capture, { readonly phase: "copying" }>;

/** A copying capture always has its sink's report; a decided or awaiting capture never had a sink. */
export type SettleInput =
  | {
      readonly capture: Exclude<ExaminedCapture, CopyingCapture>;
      readonly stop: StopFacts;
      readonly sink: null;
    }
  | { readonly capture: CopyingCapture; readonly stop: StopFacts; readonly sink: SinkResult };
export type CopySettleInput = Extract<SettleInput, { readonly sink: SinkResult }>;

/**
 * The rows settle applies to a copying capture, first match wins. A decided capture settles to its route's own
 * outcome and an unmerged 304 to empty, before any row.
 */
export interface SettleRule {
  readonly id: string;
  readonly when: (i: CopySettleInput) => boolean;
  /** `at` is where the store put the copied bytes; null when nothing was copied. */
  readonly body: (i: CopySettleInput, at: BodyLocation | null) => CopiedBody;
  readonly why: string;
}

/** encodedBodySize when above 0, else Content-Length when known, else null. */
const expectedLength = (i: CopySettleInput): number | null =>
  i.stop.encodedBodySize > 0 ? i.stop.encodedBodySize : i.capture.facts.response.contentLength;
const sinkBytes = (i: CopySettleInput): number | null =>
  i.sink.kind === "closed" ? i.sink.bytes : null;
const storedAt = (i: CopySettleInput, at: BodyLocation | null, check: BodyCheck): CopiedBody =>
  at === null
    ? { kind: "incomplete", reason: "write-failed" }
    : { kind: "stored", at, encoding: i.capture.facts.response.contentEncoding, check };

const SINK_ONLY: SettleRule = {
  id: "sink-only",
  when: () => true,
  body: (i, at) => storedAt(i, at, "sink-only"),
  why: "No length to compare with: a service-worker body of unknown length.",
};

/** First match wins. The last row matches anything. */
export const SETTLE_RULES: readonly SettleRule[] = [
  {
    id: "capped",
    when: (i) => i.sink.kind === "closed" && i.sink.cappedAt !== null,
    body: (i, at) => {
      if (i.sink.kind === "closed" && i.sink.cutWhy === "scan-timeout") {
        return i.sink.bytes === 0
          ? { kind: "incomplete", reason: "scan-timeout" }
          : storedAt(i, at, "scan-timeout");
      }
      return storedAt(i, at, "first-part");
    },
    why: "The watchdog closed the file at the body cap or scan-timeout buffer limit and the page was not affected. Any kept prefix is stored with its true reason, however the request ended.",
  },
  {
    id: "stop-failed",
    when: (i) => i.stop.status.kind !== "ok",
    body: () => ({ kind: "incomplete", reason: "network-aborted" }),
    why: "The request did not finish.",
  },
  {
    id: "prepare-failed",
    when: (i) => i.sink.kind === "prepare-failed",
    body: () => ({ kind: "incomplete", reason: "write-failed" }),
    why: "The sink could not be created.",
  },
  {
    id: "count-differs",
    when: (i) => expectedLength(i) !== null && sinkBytes(i) !== expectedLength(i),
    body: () => ({ kind: "incomplete", reason: "write-failed" }),
    why: "The native tee drops a sink whose write fails and lets the page finish, so a short count is a failed write.",
  },
  {
    id: "zero-bytes",
    when: (i) => expectedLength(i) === 0 && sinkBytes(i) === 0,
    body: () => ({ kind: "empty" }),
    why: "A declared empty body.",
  },
  {
    id: "length-matched",
    when: (i) => expectedLength(i) !== null,
    body: (i, at) => storedAt(i, at, "length-matched"),
    why: "The count equals the wire length.",
  },
  SINK_ONLY,
];

/** A route decided at examine settles to its own outcome. One case per row, so each id keeps its own reason. */
function decidedBody(route: Extract<Route, { readonly kind: "empty" | "not-kept" }>): RoutedBody {
  switch (route.id) {
    case "no-body":
    case "redirect":
      return { route: route.id, body: { kind: "empty" } };
    case "streaming":
      return { route: route.id, body: { kind: "not-kept", reason: route.reason } };
    case "media-details":
      return { route: route.id, body: { kind: "not-kept", reason: route.reason } };
    case "small":
    case "large-or-unknown":
      return { route: route.id, body: { kind: "not-kept", reason: route.reason } };
  }
}

const isCopying = (input: SettleInput): input is CopySettleInput =>
  input.capture.phase === "copying";

function routedBody(input: SettleInput, at: BodyLocation | null): RoutedBody {
  if (isCopying(input)) {
    const rule = SETTLE_RULES.find((r) => r.when(input)) ?? SINK_ONLY;
    return { route: input.capture.route.id, body: rule.body(input, at) };
  }
  return input.capture.phase === "awaiting-merge"
    ? { route: "awaiting-merge", body: { kind: "empty" } }
    : decidedBody(input.capture.route);
}

export function settle(input: SettleInput, at: BodyLocation | null): AnsweredExchange {
  const { capture } = input;
  return {
    kind: "answered",
    request: capture.facts.request,
    response: capture.facts.response,
    stop: input.stop,
    upload: capture.upload,
    ...routedBody(input, at),
  };
}

/** A channel that stopped with no response head: connection refused, DNS, TLS, an abort before headers. */
export function unanswered(
  _capture: Extract<Capture, { readonly phase: "opened" }>,
  request: RequestFacts,
  stop: StopFacts,
  upload: UploadOutcome,
): UnansweredExchange {
  return { kind: "unanswered", request, stop, upload };
}

/**
 * Shutdown before stop. A capture that read its facts at examine keeps them; `request` serves one that never got a
 * head. opened, copying and awaiting-merge become incomplete(reason); decided keeps its route outcome.
 */
export function abandon(
  capture: Capture,
  request: RequestFacts,
  reason: AbandonReason,
): AbandonedExchange {
  if (capture.phase === "opened")
    return {
      kind: "abandoned",
      request,
      response: null,
      reason,
      body: { kind: "incomplete" },
      upload: { kind: "none" },
    };
  const { facts, upload } = capture;
  const body: AbandonedBody =
    capture.phase !== "decided"
      ? { kind: "incomplete" }
      : capture.route.kind === "empty"
        ? { kind: "empty" }
        : { kind: "not-kept", reason: capture.route.reason };
  return {
    kind: "abandoned",
    request: facts.request,
    response: facts.response,
    reason,
    body,
    upload,
  };
}

export type AnsweredExchange = {
  readonly kind: "answered";
  readonly request: RequestFacts;
  readonly response: ResponseFacts;
  readonly stop: StopFacts;
  readonly upload: UploadOutcome;
} & RoutedBody;
export interface UnansweredExchange {
  readonly kind: "unanswered";
  readonly request: RequestFacts;
  readonly stop: StopFacts;
  readonly upload: UploadOutcome;
}
export type AbandonedExchange = {
  readonly kind: "abandoned";
  readonly request: RequestFacts;
  readonly reason: AbandonReason;
} & (
  | {
      /** Shut down before the response head arrived: no route was decided and no upload was read. */
      readonly response: null;
      readonly body: { readonly kind: "incomplete" };
      readonly upload: { readonly kind: "none" };
    }
  | {
      readonly response: ResponseFacts;
      readonly body: AbandonedBody;
      readonly upload: UploadOutcome;
    }
);

/** One line in a site's log. Written once at stop (or at shutdown), never rewritten. */
export type SettledExchange = AnsweredExchange | UnansweredExchange | AbandonedExchange;

/** A request the recorder still holds when an export starts. Exported marked in progress, never as complete. */
export interface LiveExchange {
  readonly request: RequestFacts;
  readonly response: ResponseFacts | null;
  readonly phase: CapturePhase;
}

export type MissingBodyReason =
  | NotKeptReason
  | IncompleteReason
  | AbandonReason
  | "no-response"
  | "removed-by-retention"
  | "interrupted-by-crash";

/** The derived fate of a body. `disk` answers from the store's inventory; nothing here touches a file. */
export type BodyAvailability =
  | {
      readonly kind: "available";
      readonly at: BodyLocation;
      readonly encoding: string | null;
      readonly check: BodyCheck;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "missing"; readonly reason: MissingBodyReason };

export interface DiskInventory {
  hasPackRange(pack: PackId, endOffset: number): "present" | "pack-short" | "pack-gone";
  hasFile(site: Site, file: ExchangeId): boolean;
}

function locationAvailability(
  at: BodyLocation,
  disk: DiskInventory,
): "present" | "removed-by-retention" | "interrupted-by-crash" {
  if (at.kind === "file") return disk.hasFile(at.site, at.id) ? "present" : "removed-by-retention";
  const range = disk.hasPackRange(at.pack, at.offset + at.length);
  return range === "present"
    ? "present"
    : range === "pack-short"
      ? "interrupted-by-crash"
      : "removed-by-retention";
}

/**
 * A stored body is available when its file or pack range exists, removed-by-retention when the file or pack is gone,
 * and interrupted-by-crash when the pack ends before the range (a torn pack append). Pure.
 */
export function bodyAvailability(settled: SettledExchange, disk: DiskInventory): BodyAvailability {
  if (settled.kind === "unanswered") return { kind: "missing", reason: "no-response" };
  if (settled.kind === "abandoned") {
    const { body } = settled;
    if (body.kind === "incomplete") return { kind: "missing", reason: settled.reason };
    return body.kind === "empty" ? body : { kind: "missing", reason: body.reason };
  }
  const { body } = settled;
  switch (body.kind) {
    case "empty":
      return body;
    case "not-kept":
    case "incomplete":
      return { kind: "missing", reason: body.reason };
    case "stored": {
      const found = locationAvailability(body.at, disk);
      return found === "present"
        ? { kind: "available", at: body.at, encoding: body.encoding, check: body.check }
        : { kind: "missing", reason: found };
    }
  }
}
