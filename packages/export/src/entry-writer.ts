// One complete entry from the merge and what each body turned out to be. The entry is redacted after this and written
// as JSON.stringify gives it. A body longer than one window is the only part not held in memory: the entry carries a
// sentinel in its place, and the run writes the redacted entry's JSON around it while the body streams.

import type { HarEntry, HarEntryExtension, HarPostData, PageId } from "@hark/har/model";
import type { BodyCheck } from "@hark/recording/exchange";
import type { MergedEntry } from "./merge.ts";
import { MISSING_REASONS, SOURCE_FAILURES, cutShortComment, type BodyPlace } from "./missing.ts";
import type { BodyOutcome } from "./report.ts";
import type { SourceName } from "./source.ts";

/** One body place as it goes into the entry. */
export interface BodyWrite {
  readonly outcome: BodyOutcome;
  /** The text field's value. null writes no text. */
  readonly text: string | null;
  readonly encoding: "base64" | null;
  /** Decoded bytes the text holds. */
  readonly size: number;
  /** Bytes read off the wire before content decoding, for `content.compression`. */
  readonly wireBytes: number | null;
  readonly check: BodyCheck | null;
}

export const NO_BODY: BodyWrite = {
  outcome: { kind: "empty" },
  text: null,
  encoding: null,
  size: 0,
  wireBytes: null,
  check: null,
};

export function missingBody(
  outcome: Extract<BodyOutcome, { readonly kind: "missing" }>,
): BodyWrite {
  return { ...NO_BODY, outcome, size: -1 };
}

function lossComment(write: BodyWrite, place: BodyPlace): string | undefined {
  switch (write.outcome.kind) {
    case "missing":
      return MISSING_REASONS[write.outcome.reason].comment[place];
    case "cut-short":
      return cutShortComment(write.outcome.reason, place, write.size);
    case "included":
    case "empty":
      return undefined;
  }
}

function lossReason(write: BodyWrite): string | undefined {
  return write.outcome.kind === "missing" || write.outcome.kind === "cut-short"
    ? write.outcome.reason
    : undefined;
}

function lossy(write: BodyWrite): number {
  return write.outcome.kind === "included" || write.outcome.kind === "cut-short"
    ? write.outcome.lossy
    : 0;
}

function bodyState(write: BodyWrite): NonNullable<HarEntryExtension["bodyState"]> {
  switch (write.outcome.kind) {
    case "included":
      return "present";
    case "empty":
      return "empty";
    case "cut-short":
      return "unavailable";
    case "missing":
      return MISSING_REASONS[write.outcome.reason].harState;
  }
}

function compression(write: BodyWrite): number | undefined {
  if (write.outcome.kind !== "included" || write.wireBytes === null) return undefined;
  return write.wireBytes === write.size ? undefined : write.size - write.wireBytes;
}

function postData(merged: MergedEntry, upload: BodyWrite): HarPostData | undefined {
  if (upload.text === null) return undefined;
  const declared = merged.entry.request.postData;
  return {
    mimeType: declared?.mimeType ?? "",
    params: declared?.params ?? [],
    text: upload.text,
    ...(upload.encoding !== null ? { encoding: upload.encoding } : {}),
  };
}

function hasBytes(write: BodyWrite): boolean {
  return write.outcome.kind === "included" || write.outcome.kind === "cut-short";
}

export function buildEntry(
  merged: MergedEntry,
  pageref: PageId,
  response: BodyWrite,
  request: BodyWrite,
  loadFailed: readonly SourceName[],
): HarEntry {
  const req = merged.entry.request;
  const res = merged.entry.response;
  const upload = postData(merged, request);
  const requestComment = lossComment(request, "request");
  const responseComment = lossComment(response, "response");
  const responseCompression = compression(response);
  const responseLossy = lossy(response);
  const requestLossy = lossy(request);
  const extension: HarEntryExtension = {
    source: merged.sources,
    bodyState: bodyState(response),
    ...(lossReason(response) !== undefined ? { bodyMissing: lossReason(response) } : {}),
    ...(response.outcome.kind === "cut-short" ? { bodyIncomplete: true } : {}),
    ...(response.outcome.kind === "included" && response.check !== null
      ? { bodyCheck: response.check }
      : {}),
    ...(responseLossy > 0 ? { lossyText: responseLossy } : {}),
    ...(merged.inProgress ? { inProgress: true } : {}),
    ...(lossReason(request) !== undefined ? { uploadMissing: lossReason(request) } : {}),
    ...(request.outcome.kind === "cut-short" ? { uploadIncomplete: true } : {}),
    ...(requestLossy > 0 ? { uploadLossyText: requestLossy } : {}),
    ...(merged.headersMissing !== undefined ? { headersMissing: merged.headersMissing } : {}),
    ...(merged.headersNeverStored ? { headersNeverStored: true } : {}),
    ...(merged.timingsMissing !== undefined ? { timingsMissing: merged.timingsMissing } : {}),
    ...(loadFailed.length > 0 ? { loadFailed: [...loadFailed] } : {}),
  };
  const missingNotes = [
    ...(merged.headersMissing !== undefined
      ? [
          merged.headersMissing === "never-stored"
            ? "Headers unavailable: secret header values never stored (settings)."
            : `Headers unavailable: ${MISSING_REASONS[merged.headersMissing].reportLabel}.`,
        ]
      : []),
    ...(merged.headersNeverStored ? ["Secret header values never stored (settings)."] : []),
    ...(merged.timingsMissing !== undefined
      ? [`Timings unavailable: ${MISSING_REASONS[merged.timingsMissing].reportLabel}.`]
      : []),
  ];
  const comment =
    loadFailed.length > 0
      ? loadFailed.map((source) => SOURCE_FAILURES[source].load).join(" ")
      : missingNotes.join(" ");
  const { postData: _declared, ...requestHead } = req;
  return {
    pageref,
    ...merged.entry,
    request: {
      ...requestHead,
      ...(upload !== undefined ? { postData: upload } : {}),
      bodySize: hasBytes(request) ? request.size : request.outcome.kind === "empty" ? 0 : -1,
      ...(requestComment !== undefined ? { comment: requestComment } : {}),
    },
    response: {
      ...res,
      content: {
        mimeType: res.content.mimeType,
        ...(response.encoding !== null ? { encoding: response.encoding } : {}),
        ...(response.text !== null ? { text: response.text } : {}),
        size: response.size,
        ...(responseCompression !== undefined ? { compression: responseCompression } : {}),
        ...(responseComment !== undefined ? { comment: responseComment } : {}),
      },
    },
    ...(comment !== "" ? { comment } : {}),
    _harExport: extension,
  };
}

/**
 * The JSON before and after the sentinel's text. null when the sentinel is not in it, which means redaction removed
 * the body's text.
 */
export function splitAtSentinel(
  json: string,
  sentinel: string,
): { readonly head: string; readonly tail: string } | null {
  const encoded = JSON.stringify(sentinel);
  const at = json.indexOf(encoded);
  if (at === -1) return null;
  return { head: json.slice(0, at + 1), tail: json.slice(at + encoded.length - 1) };
}

/** A sentinel for a streamed body: the k-th one is tried when page data happens to hold the (k-1)-th. */
export function streamSentinel(k: number): string {
  return `\u0000hark streamed body ${String(k)}\u0000`;
}
