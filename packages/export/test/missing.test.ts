import { buildHarEntry } from "@hark/har/build";
import { isoDateTimeFromEpochMs, toHarUrl, type HarEntryExtension } from "@hark/har/model";
import { classifyEntryBodyState } from "@hark/har/summarize";
import { describe, expect, it } from "vite-plus/test";
import {
  BODY_PLACES,
  CUT_SHORT_REASONS,
  MISSING_REASONS,
  SOURCE_FAILURES,
  cutShortComment,
  type CutShortReason,
  type MissingReason,
} from "../src/missing.ts";
import { T0 } from "./fixtures.ts";

describe("the loss tables", () => {
  it("every row has plain copy for both body places, without emoji or dashes", () => {
    const copy = [
      ...Object.values(MISSING_REASONS).flatMap((row) => [
        row.reportLabel,
        ...BODY_PLACES.map((p) => row.comment[p]),
      ]),
      ...Object.values(CUT_SHORT_REASONS).flatMap((row) => [
        row.reportLabel,
        ...BODY_PLACES.map((p) => row.comment[p]),
      ]),
      ...Object.values(SOURCE_FAILURES).flatMap((row) => [row.name, row.list, row.load]),
    ];
    for (const text of copy) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[–—]|\p{Extended_Pictographic}/u);
    }
  });

  it("a cut-short comment says the body is incomplete and how many bytes it holds", () => {
    for (const reason of Object.keys(CUT_SHORT_REASONS) as CutShortReason[]) {
      for (const place of BODY_PLACES) {
        expect(cutShortComment(reason, place, 27)).toMatch(/incomplete: only the first 27 bytes /u);
        expect(cutShortComment(reason, place, 1)).toContain("first 1 byte ");
      }
    }
  });

  it("gives each reason its coarse HAR body state", () => {
    const states = Object.fromEntries(
      Object.entries(MISSING_REASONS).map(([reason, row]) => [reason, row.harState]),
    );
    expect(states).toEqual({
      "media-setting": "media-skipped",
      "streaming-response": "not-included",
      "not-recordable-here": "unavailable",
      "network-aborted": "aborted",
      "write-failed": "unavailable",
      "scan-timeout": "unavailable",
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
      "upload-too-large": "size-limit",
      "upload-not-rewindable": "unavailable",
      "upload-never-stored": "not-included",
    });
  });

  it("agrees with @hark/har/summarize classifyEntryBodyState on every reason and on a body cut short", () => {
    const entry = (ext: HarEntryExtension) =>
      buildHarEntry({
        startedDateTime: isoDateTimeFromEpochMs(T0),
        request: { method: "GET", url: toHarUrl("https://app.example/")! },
        response: { status: 200, content: { size: 3, mimeType: "text/plain", text: "abc" } },
        _harExport: ext,
      });
    for (const [reason, row] of Object.entries(MISSING_REASONS) as [
      MissingReason,
      (typeof MISSING_REASONS)[MissingReason],
    ][]) {
      expect(
        classifyEntryBodyState(entry({ bodyState: row.harState, bodyMissing: reason })),
        reason,
      ).toEqual({
        state: "missing",
        reason: row.harState,
      });
    }
    expect(
      classifyEntryBodyState(
        entry({ bodyState: "unavailable", bodyMissing: "source-error", bodyIncomplete: true }),
      ).state,
    ).not.toBe("present");
  });
});
