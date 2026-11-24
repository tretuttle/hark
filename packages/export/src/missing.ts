// Everything an export can lose, with the words the file, the popup and the report use for it.

import type { HarMissingBodyReason } from "@hark/har/model";
import type { MissingBodyReason } from "@hark/recording/exchange";
import type { SourceName } from "./source.ts";

/** The two bodies one entry can carry: `response.content.text` and `request.postData.text`. */
export type BodyPlace = "response" | "request";
export const BODY_PLACES: readonly BodyPlace[] = ["response", "request"];

export type MissingReason =
  | MissingBodyReason
  | "over-body-cap"
  | "no-response"
  | "in-progress"
  | "devtools-discarded"
  | "devtools-truncated"
  | "not-recorded"
  | "omitted-by-choice"
  | "source-error"
  | "upload-too-large"
  | "upload-not-rewindable"
  | "upload-never-stored";

/** Why a body whose first bytes are in the file has no more. */
export type CutShortReason =
  | "over-body-cap"
  | "scan-timeout"
  | "source-error"
  | "over-export-window";

export interface PlaceCopy {
  readonly response: string;
  readonly request: string;
}

export interface MissingRow {
  /** Written into `response.content.comment` or `request.comment` when the body is absent. */
  readonly comment: PlaceCopy;
  readonly reportLabel: string;
  readonly settings: "storage" | "media" | "secrets" | null;
  readonly harState: HarMissingBodyReason;
}

export const MISSING_REASONS: { readonly [R in MissingReason]: MissingRow } = {
  "media-setting": {
    comment: {
      response: "Body not kept: audio and video bodies are off in settings.",
      request: "Request body not kept: audio and video bodies are off in settings.",
    },
    reportLabel: "audio and video, off in settings",
    settings: "media",
    harState: "media-skipped",
  },
  "streaming-response": {
    comment: {
      response: "Body not kept: this response streams without an end.",
      request: "Request body not kept: this request streams without an end.",
    },
    reportLabel: "streaming without an end",
    settings: null,
    harState: "not-included",
  },
  "not-recordable-here": {
    comment: {
      response: "Body not kept: this browser does not let extensions read this body.",
      request: "Request body not kept: this browser does not let extensions read it.",
    },
    reportLabel: "not readable in this browser",
    settings: null,
    harState: "unavailable",
  },
  "network-aborted": {
    comment: {
      response: "Body not saved: the request did not finish.",
      request: "Request body not saved: the request did not finish.",
    },
    reportLabel: "request did not finish",
    settings: null,
    harState: "aborted",
  },
  "write-failed": {
    comment: {
      response: "Body not saved: writing it to disk failed.",
      request: "Request body not saved: writing it to disk failed.",
    },
    reportLabel: "disk write failed",
    settings: null,
    harState: "unavailable",
  },
  "scan-timeout": {
    comment: {
      response: "Body not saved: the storage check at startup took too long.",
      request: "Request body not saved: the storage check at startup took too long.",
    },
    reportLabel: "storage check at startup timed out",
    settings: null,
    harState: "unavailable",
  },
  "over-body-cap": {
    comment: {
      response:
        "Body not saved: it passed the largest size kept for one body, a quarter of the storage limit in settings.",
      request:
        "Request body not saved: it passed the largest size kept for one body, a quarter of the storage limit in settings.",
    },
    reportLabel: "larger than one body may be",
    settings: "storage",
    harState: "size-limit",
  },
  "browser-closed": {
    comment: {
      response: "Body not saved: the browser closed while it was downloading.",
      request: "Request body not saved: the browser closed while it was being sent.",
    },
    reportLabel: "browser closed during download",
    settings: null,
    harState: "aborted",
  },
  "recording-stopped": {
    comment: {
      response: "Body not saved: Hark was turned off, removed or updated while it was downloading.",
      request:
        "Request body not saved: Hark was turned off, removed or updated while it was being sent.",
    },
    reportLabel: "extension stopped during download",
    settings: null,
    harState: "aborted",
  },
  "removed-by-retention": {
    comment: {
      response: "Body removed by the storage limits in settings.",
      request: "Request body removed by the storage limits in settings.",
    },
    reportLabel: "removed by storage limits",
    settings: "storage",
    harState: "evicted",
  },
  "interrupted-by-crash": {
    comment: {
      response: "Body lost: the browser stopped before it was saved.",
      request: "Request body lost: the browser stopped before it was saved.",
    },
    reportLabel: "lost when the browser stopped",
    settings: null,
    harState: "unavailable",
  },
  "no-response": {
    comment: {
      response: "No response: the request failed before a response arrived.",
      request: "Request body not saved: the request failed before a response arrived.",
    },
    reportLabel: "no response",
    settings: null,
    harState: "unavailable",
  },
  "in-progress": {
    comment: {
      response: "Body not included: the response was still arriving when this file was saved.",
      request:
        "Request body not included: the request was still in progress when this file was saved.",
    },
    reportLabel: "still in progress",
    settings: null,
    harState: "not-included",
  },
  "devtools-discarded": {
    comment: {
      response: "DevTools no longer had this body, and the background recording did not have it.",
      request:
        "DevTools no longer had this request body, and the background recording did not have it.",
    },
    reportLabel: "no longer in DevTools",
    settings: null,
    harState: "discarded",
  },
  "devtools-truncated": {
    comment: {
      response:
        "DevTools kept only the first part of this body, and the background recording did not have it.",
      request:
        "DevTools kept only the first part of this request body, and the background recording did not have it.",
    },
    reportLabel: "cut off by DevTools",
    settings: null,
    harState: "size-limit",
  },
  "not-recorded": {
    comment: {
      response:
        "The background recording does not cover this request, and DevTools had no body for it.",
      request:
        "The background recording does not cover this request, and DevTools had no request body for it.",
    },
    reportLabel: "not in the background recording",
    settings: null,
    harState: "unavailable",
  },
  "omitted-by-choice": {
    comment: {
      response: "Bodies were left out of this export.",
      request: "Request bodies were left out of this export.",
    },
    reportLabel: "left out by choice",
    settings: null,
    harState: "not-included",
  },
  "source-error": {
    comment: {
      response: "Body not available: reading it failed.",
      request: "Request body not available: reading it failed.",
    },
    reportLabel: "could not be read",
    settings: null,
    harState: "unavailable",
  },
  "upload-too-large": {
    comment: {
      response: "Body not kept: it was larger than 1 MB.",
      request: "Request body not kept: it was larger than 1 MB.",
    },
    reportLabel: "larger than 1 MB",
    settings: null,
    harState: "size-limit",
  },
  "upload-not-rewindable": {
    comment: {
      response: "Body not kept: the browser did not allow it to be read again.",
      request: "Request body not kept: the browser did not allow it to be read again.",
    },
    reportLabel: "not readable a second time",
    settings: null,
    harState: "unavailable",
  },
  "upload-never-stored": {
    comment: {
      response: "Body not stored: settings say never to store secrets and request bodies.",
      request: "Request body not stored: settings say never to store secrets and request bodies.",
    },
    reportLabel: "never stored (settings)",
    settings: "secrets",
    harState: "not-included",
  },
};

export interface CutShortRow {
  /** `{bytes}` is replaced by the number of bytes the file holds. */
  readonly comment: PlaceCopy;
  readonly reportLabel: string;
}

export const CUT_SHORT_REASONS: { readonly [R in CutShortReason]: CutShortRow } = {
  "over-body-cap": {
    comment: {
      response:
        "Body incomplete: only the first {bytes} were kept. The rest passed the largest size kept for one body, a quarter of the storage limit in settings.",
      request:
        "Request body incomplete: only the first {bytes} were kept. The rest passed the largest size kept for one body, a quarter of the storage limit in settings.",
    },
    reportLabel: "larger than one body may be",
  },
  "scan-timeout": {
    comment: {
      response:
        "Body incomplete: only the first {bytes} were kept. The storage check at startup took too long.",
      request:
        "Request body incomplete: only the first {bytes} were kept. The storage check at startup took too long.",
    },
    reportLabel: "storage check at startup timed out",
  },
  "source-error": {
    comment: {
      response: "Body incomplete: only the first {bytes} are here. Reading the rest failed.",
      request: "Request body incomplete: only the first {bytes} are here. Reading the rest failed.",
    },
    reportLabel: "reading the rest failed",
  },
  "over-export-window": {
    comment: {
      response:
        "Body incomplete: only the first {bytes} are here. An export writes at most 3 MiB of one request body.",
      request:
        "Request body incomplete: only the first {bytes} are here. An export writes at most 3 MiB of one request body.",
    },
    reportLabel: "larger than 3 MiB",
  },
};

export function cutShortComment(reason: CutShortReason, place: BodyPlace, bytes: number): string {
  const amount = bytes === 1 ? "1 byte" : `${String(bytes)} bytes`;
  return CUT_SHORT_REASONS[reason].comment[place].replace("{bytes}", amount);
}

export interface SourceFailureRow {
  readonly name: string;
  /** The entry's comment when this source's details for it could not be read. */
  readonly load: string;
  /** A sentence of log.comment when this source's listing could not be read. */
  readonly list: string;
}

export const SOURCE_FAILURES: { readonly [S in SourceName]: SourceFailureRow } = {
  recording: {
    name: "the background recording",
    load: "The background recording's details for this request could not be read.",
    list: "The background recording's list of requests could not be read, so its requests are not in this file.",
  },
  devtools: {
    name: "DevTools",
    load: "DevTools' details for this request could not be read.",
    list: "DevTools' list of requests could not be read, so requests only DevTools saw are not in this file.",
  },
};
