// The log line format and the per-segment summary. Both are read back from disk, so their decoders are the boundary:
// a line or summary that is torn, foreign or of another version decodes to null instead of a half-typed value.

import { bucketOf, mergeBuckets, type ActivityBucket } from "./activity.ts";
import type {
  AbandonedBody,
  AbandonReason,
  BodyCheck,
  BodyLocation,
  CopiedBody,
  Header,
  IncompleteReason,
  NetError,
  RequestFacts,
  ResponseFacts,
  RoutedBody,
  SettledExchange,
  StopFacts,
  StopStatus,
  Timings,
  UploadOutcome,
} from "./exchange.ts";
import {
  asciiJson,
  byteCount,
  epochMs,
  fields,
  finite,
  integer,
  list,
  member,
  members,
  nullable,
  parsed,
  readJson,
  reject,
  text,
} from "./fields.ts";
import {
  exchangeId,
  parseExchangeId,
  parseRunId,
  parseSite,
  toMinute,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
  type LogSegmentId,
  type Minute,
  type TabKey,
} from "./ids.ts";
import { parseLogSegmentId, parsePackId } from "./layout.ts";
import { BODY_ROUTES, type NotKeptReason, type ResponseSource } from "./routes.ts";

/** Version 2. No released version wrote v1 lines, so nothing reads them. */
export interface LogLine {
  readonly v: 2;
  readonly exchange: SettledExchange;
}

/**
 * One whole line, newline included: the newline is the commit point. Lines are ASCII (every code unit above 0x7e is
 * a \u escape), so a byte offset in a segment is a string offset and a torn tail never splits a character.
 */
export function encodeLine(line: LogLine): string {
  return `${asciiJson(line)}\n`;
}

const NOT_KEPT = members<NotKeptReason>({
  "media-setting": true,
  "streaming-response": true,
  "not-recordable-here": true,
});
const INCOMPLETE = members<IncompleteReason>({
  "network-aborted": true,
  "write-failed": true,
  "scan-timeout": true,
});
const ABANDON = members<AbandonReason>({ "browser-closed": true, "recording-stopped": true });
const CHECKS = members<BodyCheck>({
  "length-matched": true,
  "sink-only": true,
  "first-part": true,
  "scan-timeout": true,
});
const SOURCES = members<ResponseSource>({
  network: true,
  cache: true,
  revalidated: true,
  "service-worker": true,
});
const UPLOAD_NOT_KEPT = members<Extract<UploadOutcome, { readonly kind: "not-kept" }>["reason"]>({
  "upload-too-large": true,
  "upload-not-rewindable": true,
  "upload-never-stored": true,
});
const TIMING_PHASES = members<keyof Timings>({
  blocked: true,
  dns: true,
  connect: true,
  ssl: true,
  send: true,
  wait: true,
  receive: true,
});

const anExchangeId = (raw: unknown): ExchangeId => {
  const id = parseExchangeId(text(raw)) ?? reject();
  return exchangeId(id.run, id.channel);
};
const aSite = parsed(parseSite);
const header = (raw: unknown): Header => {
  const [name, value, ...rest] = list(raw, (v) => v);
  return rest.length === 0 ? [text(name), nullable(text)(value)] : reject();
};
const tabKey = (raw: unknown): TabKey => {
  const f = fields(raw);
  return { run: parsed(parseRunId)(f["run"]), browserId: integer(f["browserId"]) };
};

function request(raw: unknown): RequestFacts {
  const f = fields(raw);
  return {
    id: anExchangeId(f["id"]),
    url: text(f["url"]),
    method: text(f["method"]),
    httpVersion: text(f["httpVersion"]),
    headers: list(f["headers"], header),
    startedAt: epochMs(f["startedAt"]),
    tab: nullable(tabKey)(f["tab"]),
    topSite: nullable(aSite)(f["topSite"]),
    policyType: integer(f["policyType"]),
  };
}

function response(raw: unknown): ResponseFacts {
  const f = fields(raw);
  return {
    status: integer(f["status"]),
    statusText: text(f["statusText"]),
    httpVersion: text(f["httpVersion"]),
    headers: list(f["headers"], header),
    mimeType: nullable(text)(f["mimeType"]),
    contentLength: nullable(byteCount)(f["contentLength"]),
    contentEncoding: nullable(text)(f["contentEncoding"]),
    source: member(SOURCES)(f["source"]),
    redirectTo: nullable(text)(f["redirectTo"]),
    remoteAddress: nullable(text)(f["remoteAddress"]),
  };
}

function stopStatus(raw: unknown): StopStatus {
  const f = fields(raw);
  if (f["kind"] === "ok" || f["kind"] === "redirected") return { kind: f["kind"] };
  return f["kind"] === "failed"
    ? { kind: "failed", error: text(f["error"]) as NetError }
    : reject();
}

function stop(raw: unknown): StopFacts {
  const f = fields(raw);
  const t = fields(f["timings"]);
  const timings = Object.fromEntries(
    TIMING_PHASES.map((phase) => [phase, nullable(finite)(t[phase])]),
  ) as { [P in keyof Timings]: number | null };
  return {
    status: stopStatus(f["status"]),
    endedAt: epochMs(f["endedAt"]),
    timings,
    transferSize: byteCount(f["transferSize"]),
    encodedBodySize: byteCount(f["encodedBodySize"]),
  };
}

function location(raw: unknown): BodyLocation {
  const f = fields(raw);
  const length = byteCount(f["length"]);
  if (f["kind"] === "pack")
    return {
      kind: "pack",
      pack: parsed(parsePackId)(f["pack"]),
      offset: byteCount(f["offset"]),
      length,
    };
  return f["kind"] === "file"
    ? { kind: "file", site: aSite(f["site"]), id: anExchangeId(f["id"]), length }
    : reject();
}

const empty = (raw: unknown): { readonly kind: "empty" } =>
  fields(raw)["kind"] === "empty" ? { kind: "empty" } : reject();
const notKept =
  <R extends NotKeptReason>(reasons: readonly R[]) =>
  (raw: unknown): { readonly kind: "not-kept"; readonly reason: R } => {
    const f = fields(raw);
    return f["kind"] === "not-kept"
      ? { kind: "not-kept", reason: member(reasons)(f["reason"]) }
      : reject();
  };

function copiedBody(raw: unknown): CopiedBody {
  const f = fields(raw);
  switch (f["kind"]) {
    case "empty":
      return { kind: "empty" };
    case "stored":
      return {
        kind: "stored",
        at: location(f["at"]),
        encoding: nullable(text)(f["encoding"]),
        check: member(CHECKS)(f["check"]),
      };
    case "incomplete":
      return { kind: "incomplete", reason: member(INCOMPLETE)(f["reason"]) };
    default:
      return reject();
  }
}

/** The runtime twin of RoutedBody: each route reads only the bodies its row can settle to. */
function routedBody(rawRoute: unknown, rawBody: unknown): RoutedBody {
  const route = member(ROUTE_IDS)(rawRoute);
  switch (route) {
    case "no-body":
    case "redirect":
    case "awaiting-merge":
      return { route, body: empty(rawBody) };
    case "streaming":
      return { route, body: notKept(["streaming-response"] as const)(rawBody) };
    case "media-details":
      return { route, body: notKept(["media-setting"] as const)(rawBody) };
    case "small":
    case "large-or-unknown":
      return {
        route,
        body:
          fields(rawBody)["kind"] === "not-kept"
            ? notKept(["not-recordable-here"] as const)(rawBody)
            : copiedBody(rawBody),
      };
  }
}

/** An interrupted body names no reason; the exchange's own reason is the only one. */
function interrupted(raw: unknown): { readonly kind: "incomplete" } {
  const f = fields(raw);
  return f["kind"] === "incomplete" && !("reason" in f) ? { kind: "incomplete" } : reject();
}

function abandonedBody(raw: unknown): AbandonedBody {
  const f = fields(raw);
  if (f["kind"] === "empty") return { kind: "empty" };
  return f["kind"] === "not-kept" ? notKept(NOT_KEPT)(raw) : interrupted(raw);
}

const noUpload = (raw: unknown): { readonly kind: "none" } =>
  fields(raw)["kind"] === "none" ? { kind: "none" } : reject();

function upload(raw: unknown): UploadOutcome {
  const f = fields(raw);
  if (f["kind"] === "none") return { kind: "none" };
  if (f["kind"] === "stored")
    return { kind: "stored", at: location(f["at"]), mimeType: nullable(text)(f["mimeType"]) };
  return f["kind"] === "not-kept"
    ? { kind: "not-kept", reason: member(UPLOAD_NOT_KEPT)(f["reason"]) }
    : reject();
}

const ROUTE_IDS = BODY_ROUTES.map((r) => r.id);

function exchange(raw: unknown): SettledExchange {
  const f = fields(raw);
  switch (f["kind"]) {
    case "answered":
      return {
        kind: "answered",
        request: request(f["request"]),
        response: response(f["response"]),
        stop: stop(f["stop"]),
        upload: upload(f["upload"]),
        ...routedBody(f["route"], f["body"]),
      };
    case "unanswered":
      return {
        kind: "unanswered",
        request: request(f["request"]),
        stop: stop(f["stop"]),
        upload: upload(f["upload"]),
      };
    case "abandoned": {
      const head = {
        kind: "abandoned",
        request: request(f["request"]),
        reason: member(ABANDON)(f["reason"]),
      } as const;
      return f["response"] === null
        ? { ...head, response: null, body: interrupted(f["body"]), upload: noUpload(f["upload"]) }
        : {
            ...head,
            response: response(f["response"]),
            body: abandonedBody(f["body"]),
            upload: upload(f["upload"]),
          };
    }
    default:
      return reject();
  }
}

/** Torn, foreign or future-version lines return null. Readers skip them; reconcile truncates a torn tail. */
export function decodeLine(line: string): LogLine | null {
  return readJson(line, (raw) => {
    const f = fields(raw);
    return f["v"] === 2 ? { v: 2, exchange: exchange(f["exchange"]) } : reject();
  });
}

/** Splits a chunk read from disk into whole lines plus the carry for the next chunk. Pure, for streaming scans. */
export function splitLines(
  carry: string,
  chunk: string,
): { readonly lines: readonly string[]; readonly carry: string } {
  const pieces = `${carry}${chunk}`.split("\n");
  const rest = pieces.pop() ?? "";
  return { lines: pieces, carry: rest };
}

/** Written when a segment seals, and by reconcile for a crashed run. Enough to answer counts, sites and sessions. */
export interface SegmentSummary {
  readonly segment: LogSegmentId;
  /** null for a segment with no whole line, such as one whose only append was torn and truncated. */
  readonly firstStartedAt: EpochMs | null;
  readonly lastStartedAt: EpochMs | null;
  readonly lines: number;
  readonly bytes: ByteCount;
  readonly buckets: readonly ActivityBucket[];
}

export function summarize(
  segment: LogSegmentId,
  lines: Iterable<LogLine>,
  bytes: ByteCount,
): SegmentSummary {
  let first: EpochMs | null = null;
  let last: EpochMs | null = null;
  let count = 0;
  const buckets: ActivityBucket[] = [];
  for (const line of lines) {
    const { startedAt } = line.exchange.request;
    first = first === null || startedAt < first ? startedAt : first;
    last = last === null || startedAt > last ? startedAt : last;
    count += 1;
    buckets.push(bucketOf(line.exchange));
  }
  return {
    segment,
    firstStartedAt: first,
    lastStartedAt: last,
    lines: count,
    bytes,
    buckets: mergeBuckets(buckets),
  };
}

export function encodeSummary(s: SegmentSummary): string {
  return asciiJson(s);
}

const minute = (raw: unknown): Minute => {
  const value = integer(raw);
  const start = toMinute(value as EpochMs);
  return start === value ? start : reject();
};

const atLeast =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (raw: unknown): number => {
    const value = integer(raw);
    return value >= min && value <= max ? value : reject();
  };

/** A bucket holds at least the one request that made it, and fetch or XHR requests are a subset of its requests. */
function bucket(raw: unknown): ActivityBucket {
  const f = fields(raw);
  const requests = atLeast(1)(f["requests"]);
  return {
    minute: minute(f["minute"]),
    tab: nullable(tabKey)(f["tab"]),
    site: nullable(aSite)(f["site"]),
    requests,
    fetchOrXhr: atLeast(0, requests)(f["fetchOrXhr"]),
    bodyBytesRecorded: byteCount(f["bodyBytesRecorded"]),
    topUrl: text(f["topUrl"]),
  };
}

/** What summarize guarantees: one request per line across the buckets, and start times exactly when there are lines. */
const consistent = (s: SegmentSummary): boolean =>
  s.buckets.reduce((sum, b) => sum + b.requests, 0) === s.lines &&
  (s.lines === 0
    ? s.firstStartedAt === null && s.lastStartedAt === null
    : s.firstStartedAt !== null && s.lastStartedAt !== null && s.firstStartedAt <= s.lastStartedAt);

/**
 * null for a summary that does not decode or whose `bytes` differs from the segment's size on disk. Reconcile then
 * deletes it and summarizes again, so a damaged summary can never hide its segment.
 */
export function decodeSummary(raw: string, segmentBytes: ByteCount): SegmentSummary | null {
  return readJson(raw, (value) => {
    const f = fields(value);
    const summary: SegmentSummary = {
      segment: parsed(parseLogSegmentId)(f["segment"]),
      firstStartedAt: nullable(epochMs)(f["firstStartedAt"]),
      lastStartedAt: nullable(epochMs)(f["lastStartedAt"]),
      lines: atLeast(0)(f["lines"]),
      bytes: byteCount(f["bytes"]),
      buckets: list(f["buckets"], bucket),
    };
    return summary.bytes === segmentBytes && consistent(summary) ? summary : reject();
  });
}
