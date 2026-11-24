// What the export did, counted as it streams. Shown in the popup result, written into log.comment and log._harExport.report.

import type { HarLogRedactionExtension } from "@hark/har/model";
import type { ByteCount } from "@hark/recording/ids";
import type { MergedEntry } from "./merge.ts";
import {
  CUT_SHORT_REASONS,
  MISSING_REASONS,
  SOURCE_FAILURES,
  type BodyPlace,
  type CutShortReason,
  type MissingReason,
} from "./missing.ts";
import type { RedactionChoice } from "./redaction.ts";
import type { SourceName } from "./source.ts";

/** What one body place of one entry ended as. Exactly one per place per entry. */
export type BodyOutcome =
  | {
      readonly kind: "included";
      readonly from: "stored" | "devtools";
      readonly unchecked: boolean;
      readonly lossy: number;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "cut-short"; readonly reason: CutShortReason; readonly lossy: number }
  | { readonly kind: "missing"; readonly reason: MissingReason };

export interface PlaceTally {
  readonly included: number;
  readonly empty: number;
  readonly cutShort: { readonly [R in CutShortReason]?: number };
  readonly missing: { readonly [R in MissingReason]?: number };
  /** Bodies holding U+FFFD where DevTools' text had a lone surrogate. */
  readonly lossyText: number;
}

export interface ExportReport {
  readonly requests: number;
  readonly sources: {
    readonly both: number;
    readonly recordingOnly: number;
    readonly devtoolsOnly: number;
  };
  /** Items that had no key and so could not be paired. Each appears once per source. */
  readonly unpaired: number;
  /** Rows a source listed more than once under one key. Each key is written once. */
  readonly duplicates: { readonly [S in SourceName]: number };
  /** Requests the recorder still held, written with their head and marked in progress. */
  readonly inProgress: number;
  /** data:, blob:, about: and other rows that are not network requests, by scheme. Not written as entries. */
  readonly notNetwork: { readonly [scheme: string]: number };
  readonly sourceErrors: {
    /** Sources whose listing threw. The export went on with the other source. */
    readonly list: readonly SourceName[];
    /** Entries for which this source's details threw while loading. */
    readonly load: { readonly [S in SourceName]: number };
  };
  readonly bodies: {
    readonly response: PlaceTally & {
      /** Bodies that came from a different source than the headers, such as one DevTools had discarded. */
      readonly filledIn: number;
      /** Bodies stored with only the tee's own count behind them (BodyCheck sink-only). */
      readonly unchecked: number;
    };
    readonly request: PlaceTally;
  };
  readonly redaction: {
    readonly choice: RedactionChoice;
    /** @hark/har's own report for the file, unchanged. null when nothing was redacted. */
    readonly report: HarLogRedactionExtension | null;
  };
  readonly fileBytes: ByteCount;
}

const emptyPlace = (): PlaceTally => ({
  included: 0,
  empty: 0,
  cutShort: {},
  missing: {},
  lossyText: 0,
});

export function emptyReport(
  choice: RedactionChoice,
  unpaired: number,
  duplicates: { readonly [S in SourceName]: number },
  notNetwork: { readonly [scheme: string]: number },
  listFailed: readonly SourceName[],
): ExportReport {
  return {
    requests: 0,
    sources: { both: 0, recordingOnly: 0, devtoolsOnly: 0 },
    unpaired,
    duplicates: { ...duplicates },
    inProgress: 0,
    notNetwork: { ...notNetwork },
    sourceErrors: { list: [...listFailed], load: { recording: 0, devtools: 0 } },
    bodies: {
      response: { ...emptyPlace(), filledIn: 0, unchecked: 0 },
      request: emptyPlace(),
    },
    redaction: { choice, report: null },
    fileBytes: 0 as ByteCount,
  };
}

/** A one-sided entry's head and body come from the one source, so only a pair can be filled in. */
function isFilledIn(merged: MergedEntry, from: "stored" | "devtools"): boolean {
  return merged.responseHeadFrom !== (from === "stored" ? "recording" : "devtools");
}

function bump<K extends string>(
  counts: { readonly [R in K]?: number },
  key: K,
): { readonly [R in K]?: number } {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

function tallyPlace<T extends PlaceTally>(place: T, outcome: BodyOutcome): T {
  switch (outcome.kind) {
    case "included":
      return {
        ...place,
        included: place.included + 1,
        lossyText: place.lossyText + (outcome.lossy > 0 ? 1 : 0),
      };
    case "empty":
      return { ...place, empty: place.empty + 1 };
    case "cut-short":
      return {
        ...place,
        cutShort: bump(place.cutShort, outcome.reason),
        lossyText: place.lossyText + (outcome.lossy > 0 ? 1 : 0),
      };
    case "missing":
      return { ...place, missing: bump(place.missing, outcome.reason) };
  }
}

/** Called once per written entry with what was actually written. */
export function tally(
  report: ExportReport,
  merged: MergedEntry,
  written: {
    readonly response: BodyOutcome;
    readonly request: BodyOutcome;
    readonly loadFailed: readonly SourceName[];
  },
): ExportReport {
  const response = tallyPlace(report.bodies.response, written.response);
  const included = written.response.kind === "included" ? written.response : null;
  return {
    ...report,
    requests: report.requests + 1,
    sources: {
      both: report.sources.both + (merged.sources === "both" ? 1 : 0),
      recordingOnly: report.sources.recordingOnly + (merged.sources === "recording-only" ? 1 : 0),
      devtoolsOnly: report.sources.devtoolsOnly + (merged.sources === "devtools-only" ? 1 : 0),
    },
    inProgress: report.inProgress + (merged.inProgress ? 1 : 0),
    sourceErrors: {
      list: report.sourceErrors.list,
      load: {
        recording:
          report.sourceErrors.load.recording + (written.loadFailed.includes("recording") ? 1 : 0),
        devtools:
          report.sourceErrors.load.devtools + (written.loadFailed.includes("devtools") ? 1 : 0),
      },
    },
    bodies: {
      response: {
        ...response,
        filledIn: response.filledIn + (included && isFilledIn(merged, included.from) ? 1 : 0),
        unchecked: response.unchecked + (included?.unchecked ? 1 : 0),
      },
      request: tallyPlace(report.bodies.request, written.request),
    },
  };
}

const PLACE_NOUN: { readonly [P in BodyPlace]: readonly [string, string] } = {
  response: ["body", "bodies"],
  request: ["request body", "request bodies"],
};

function plural(count: number, forms: readonly [string, string]): string {
  return `${String(count)} ${count === 1 ? forms[0] : forms[1]}`;
}

function lossSentences(place: BodyPlace, tallyOf: PlaceTally): string[] {
  const sentences: string[] = [];
  const missing = (Object.entries(tallyOf.missing) as [MissingReason, number][]).filter(
    ([, count]) => count > 0,
  );
  if (missing.length > 0) {
    const total = missing.reduce((sum, [, count]) => sum + count, 0);
    const details = missing.map(
      ([reason, count]) => `${String(count)} ${MISSING_REASONS[reason].reportLabel}`,
    );
    sentences.push(`${plural(total, PLACE_NOUN[place])} not available: ${details.join(", ")}.`);
  }
  const cutShort = (Object.entries(tallyOf.cutShort) as [CutShortReason, number][]).filter(
    ([, count]) => count > 0,
  );
  if (cutShort.length > 0) {
    const total = cutShort.reduce((sum, [, count]) => sum + count, 0);
    const details = cutShort.map(
      ([reason, count]) => `${String(count)} ${CUT_SHORT_REASONS[reason].reportLabel}`,
    );
    sentences.push(`${plural(total, PLACE_NOUN[place])} cut short: ${details.join(", ")}.`);
  }
  return sentences;
}

/** Plain sentences built from the loss tables, such as "22 bodies not available: 14 removed by storage limits." */
export function reportComment(report: ExportReport): string {
  const sentences: string[] = [
    `Exported ${plural(report.requests, ["request", "requests"])}.`,
    ...report.sourceErrors.list.map((source) => SOURCE_FAILURES[source].list),
    ...lossSentences("response", report.bodies.response),
    ...lossSentences("request", report.bodies.request),
  ];
  for (const source of ["recording", "devtools"] as const) {
    const count = report.sourceErrors.load[source];
    if (count > 0) {
      sentences.push(
        `Details from ${SOURCE_FAILURES[source].name} could not be read for ${plural(count, ["request", "requests"])}.`,
      );
    }
  }
  if (report.inProgress > 0) {
    sentences.push(`${plural(report.inProgress, ["request", "requests"])} still in progress.`);
  }
  const notNetwork = Object.entries(report.notNetwork).filter(([, count]) => count > 0);
  if (notNetwork.length > 0) {
    const total = notNetwork.reduce((sum, [, count]) => sum + count, 0);
    const schemes = notNetwork.map(([scheme, count]) => `${String(count)} ${scheme}`);
    sentences.push(
      `Left out ${plural(total, ["non-network row", "non-network rows"])} (${schemes.join(", ")}).`,
    );
  }
  return sentences.join(" ");
}
