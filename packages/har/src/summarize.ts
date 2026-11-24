import { extractUrlHost, utf8ByteLength } from "./internal.ts";
import {
  isoDateTimeFromEpochMs,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarMissingBodyReason,
  type IsoDateTime,
} from "./model.ts";

export interface HarByteTotals {
  readonly requestHeaders: number;
  readonly requestBody: number;
  readonly responseHeaders: number;
  readonly responseBodyWire: number;
  readonly responseBodyDecoded: number;
  readonly includedResponseTextBytes: number;
}

export interface HarBodySummary {
  readonly withBody: number;
  readonly withoutBody: number;
  readonly empty: number;
  readonly missing: number;
  readonly missingByReason: Record<HarMissingBodyReason, number>;
  readonly incomplete: number;
  readonly incompleteByReason: Record<HarMissingBodyReason, number>;
}

export type HarBodyClass =
  | { readonly state: "present" }
  | { readonly state: "empty" }
  | { readonly state: "incomplete"; readonly reason: HarMissingBodyReason }
  | { readonly state: "missing"; readonly reason: HarMissingBodyReason };

export interface HarStatusBuckets {
  readonly failed: number;
  readonly informational: number;
  readonly success: number;
  readonly redirect: number;
  readonly clientError: number;
  readonly serverError: number;
}

export interface HarTimeRange {
  readonly start: IsoDateTime;
  readonly end: IsoDateTime;
}

export interface HarRedactionSummary {
  readonly applied: boolean;
  readonly totalRemoved: number;
  readonly entriesAffected: number;
}

export interface HarSummary {
  readonly pageCount: number;
  readonly entryCount: number;
  readonly hosts: readonly string[];
  readonly timeRange: HarTimeRange | null;
  readonly wallSpanMs: number;
  readonly sumEntryTimeMs: number;
  readonly bytes: HarByteTotals;
  readonly bodies: HarBodySummary;
  readonly statusBuckets: HarStatusBuckets;
  readonly redaction: HarRedactionSummary;
}

export interface SummarizeOptions {
  // The report `redactHar` returned for this export. A report read from the document itself is not
  // trusted, because any file can carry one.
  readonly redaction?: HarLogRedactionExtension | undefined;
}

export interface SummarizeEntriesOptions extends SummarizeOptions {
  readonly pageCount?: number | undefined;
}

const MISSING_REASONS: readonly HarMissingBodyReason[] = [
  "not-included",
  "evicted",
  "discarded",
  "aborted",
  "media-skipped",
  "size-limit",
  "unavailable",
  "unknown",
];

const BODY_MISSING_TO_REASON: Readonly<Record<string, HarMissingBodyReason>> = {
  "media-setting": "media-skipped",
  "streaming-response": "not-included",
  "not-recordable-here": "unavailable",
  "network-aborted": "aborted",
  "write-failed": "unavailable",
  "over-body-cap": "size-limit",
  "browser-closed": "aborted",
  "recording-stopped": "aborted",
  "removed-by-retention": "evicted",
  "interrupted-by-crash": "unavailable",
  "no-response": "unavailable",
  "in-progress": "not-included",
  "devtools-discarded": "discarded",
  "devtools-truncated": "size-limit",
  "not-recorded": "unavailable",
  "omitted-by-choice": "not-included",
  "source-error": "unavailable",
  "scan-timeout": "unavailable",
  "upload-too-large": "size-limit",
  "upload-not-rewindable": "unavailable",
  "upload-never-stored": "not-included",
};

function createEmptyMissingByReason(): Record<HarMissingBodyReason, number> {
  return {
    "not-included": 0,
    evicted: 0,
    discarded: 0,
    aborted: 0,
    "media-skipped": 0,
    "size-limit": 0,
    unavailable: 0,
    unknown: 0,
  };
}

function base64DecodedLength(encoded: string): number {
  const clean = encoded.replace(/\s+/gu, "");
  if (clean.length === 0) {
    return 0;
  }
  let padding = 0;
  if (clean.endsWith("==")) {
    padding = 2;
  } else if (clean.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function isMissingReason(state: unknown): state is HarMissingBodyReason {
  return typeof state === "string" && MISSING_REASONS.includes(state as HarMissingBodyReason);
}

function resolveBodyMissingReason(raw: string): HarMissingBodyReason {
  if (isMissingReason(raw)) {
    return raw;
  }
  return BODY_MISSING_TO_REASON[raw] ?? "unavailable";
}

// `bodyIncomplete` and `bodyMissing` are read before `content.text`: a body cut short keeps its first
// bytes in `text`, and must still count as incomplete, never as present.
export function classifyEntryBodyState(entry: HarEntry): HarBodyClass {
  const { content, status, bodySize } = entry.response;
  const exportMeta = entry._harExport;
  const annotated = exportMeta?.bodyState;
  const bodyMissing = exportMeta?.bodyMissing;
  const annotatedReason = isMissingReason(annotated)
    ? annotated
    : typeof bodyMissing === "string" && bodyMissing.length > 0
      ? resolveBodyMissingReason(bodyMissing)
      : undefined;

  if (exportMeta?.bodyIncomplete === true) {
    return {
      state: "incomplete",
      reason: annotatedReason ?? (status === 0 ? "aborted" : "unavailable"),
    };
  }
  if (typeof bodyMissing === "string" && bodyMissing.length > 0 && annotatedReason) {
    return { state: "missing", reason: annotatedReason };
  }

  if (status === 204 || status === 304) {
    if (content.text === undefined || content.text.length === 0) {
      return { state: "empty" };
    }
  }
  if (content.text !== undefined) {
    return { state: "present" };
  }

  if (annotated === "empty") {
    return { state: "empty" };
  }
  if (isMissingReason(annotated)) {
    return { state: "missing", reason: annotated };
  }
  if (status === 0) {
    return { state: "missing", reason: "aborted" };
  }
  if (content.size === 0 || (content.size === -1 && bodySize === 0)) {
    return { state: "empty" };
  }
  return { state: "missing", reason: "unknown" };
}

function addNonNegative(current: number, value: number): number {
  return value >= 0 ? current + value : current;
}

function summarizeRedaction(redaction: HarLogRedactionExtension | undefined): HarRedactionSummary {
  return redaction
    ? {
        applied: true,
        totalRemoved: redaction.totalRemoved,
        entriesAffected: redaction.entriesAffected,
      }
    : { applied: false, totalRemoved: 0, entriesAffected: 0 };
}

export function summarizeEntries(
  entries: readonly HarEntry[],
  options?: SummarizeEntriesOptions,
): HarSummary {
  const hosts = new Set<string>();
  const missingByReason = createEmptyMissingByReason();
  const incompleteByReason = createEmptyMissingByReason();

  let requestHeaders = 0;
  let requestBody = 0;
  let responseHeaders = 0;
  let responseBodyWire = 0;
  let responseBodyDecoded = 0;
  let includedResponseTextBytes = 0;

  let withBody = 0;
  let withoutBody = 0;
  let empty = 0;
  let missing = 0;
  let incomplete = 0;

  let sumEntryTimeMs = 0;
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;

  let failed = 0;
  let informational = 0;
  let success = 0;
  let redirect = 0;
  let clientError = 0;
  let serverError = 0;

  for (const entry of entries) {
    const host = extractUrlHost(entry.request.url);
    if (host !== null) {
      hosts.add(host);
    }

    const startMs = Date.parse(entry.startedDateTime);
    if (Number.isFinite(startMs)) {
      if (startMs < minStartMs) {
        minStartMs = startMs;
      }
      const endMs = startMs + Math.max(0, entry.time);
      if (endMs > maxEndMs) {
        maxEndMs = endMs;
      }
    }

    sumEntryTimeMs += Math.max(0, entry.time);
    requestHeaders = addNonNegative(requestHeaders, entry.request.headersSize);
    requestBody = addNonNegative(requestBody, entry.request.bodySize);
    responseHeaders = addNonNegative(responseHeaders, entry.response.headersSize);
    responseBodyWire = addNonNegative(responseBodyWire, entry.response.bodySize);
    responseBodyDecoded = addNonNegative(responseBodyDecoded, entry.response.content.size);

    const body = classifyEntryBodyState(entry);
    if (body.state === "present" || body.state === "incomplete") {
      const text = entry.response.content.text ?? "";
      includedResponseTextBytes +=
        entry.response.content.encoding === "base64"
          ? base64DecodedLength(text)
          : utf8ByteLength(text);
    }
    if (body.state === "present") {
      withBody += 1;
    } else if (body.state === "incomplete") {
      incomplete += 1;
      incompleteByReason[body.reason] += 1;
    } else {
      withoutBody += 1;
      if (body.state === "empty") {
        empty += 1;
      } else {
        missing += 1;
        missingByReason[body.reason] += 1;
      }
    }

    const status = entry.response.status;
    if (status === 0) {
      failed += 1;
    } else if (status >= 100 && status < 200) {
      informational += 1;
    } else if (status >= 200 && status < 300) {
      success += 1;
    } else if (status >= 300 && status < 400) {
      redirect += 1;
    } else if (status >= 400 && status < 500) {
      clientError += 1;
    } else if (status >= 500) {
      serverError += 1;
    }
  }

  const timeRange: HarTimeRange | null =
    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
      ? {
          start: isoDateTimeFromEpochMs(minStartMs),
          end: isoDateTimeFromEpochMs(maxEndMs),
        }
      : null;

  const wallSpanMs =
    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
      ? Math.max(0, maxEndMs - minStartMs)
      : 0;

  return {
    pageCount: options?.pageCount ?? 0,
    entryCount: entries.length,
    hosts: [...hosts].sort(),
    timeRange,
    wallSpanMs,
    sumEntryTimeMs,
    bytes: {
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBodyWire,
      responseBodyDecoded,
      includedResponseTextBytes,
    },
    bodies: {
      withBody,
      withoutBody,
      empty,
      missing,
      missingByReason,
      incomplete,
      incompleteByReason,
    },
    statusBuckets: {
      failed,
      informational,
      success,
      redirect,
      clientError,
      serverError,
    },
    redaction: summarizeRedaction(options?.redaction),
  };
}

export function summarizeHar(document: HarDocument, options?: SummarizeOptions): HarSummary {
  return summarizeEntries(document.log.entries, {
    pageCount: document.log.pages?.length ?? 0,
    redaction: options?.redaction,
  });
}
