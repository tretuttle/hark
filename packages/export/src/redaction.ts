// The export applies @hark/har/redact and decides nothing about secrets itself. Each complete entry is
// redacted as the last step before it is written, and the log's own fields once at the end. The document's report is
// har's report for the log, with each entry's counts and records added as redactHar would add them.

import type {
  HarCreator,
  HarEntry,
  HarLogExtension,
  HarPage,
  HarLogRedactionExtension,
  HarRedactionPlace,
  HarRedactionRecord,
  RedactionLevel,
} from "@hark/har/model";
import { REDACTION_LEVELS } from "@hark/har/model";
import { finalizeRedactionReport, redactHar, redactHarEntry } from "@hark/har/redact";

/** `none` writes every value as the sources gave it. The other two are @hark/har's levels, by name. */
export type RedactionChoice = "none" | RedactionLevel;
export const REDACTION_CHOICES: readonly RedactionChoice[] = ["none", ...REDACTION_LEVELS];

/** The log's fields other than its entries, which are redacted one at a time as they are written. */
export interface LogFields {
  readonly version: string;
  readonly creator: HarCreator;
  readonly pages: readonly HarPage[];
  readonly comment: string;
  readonly _harExport: HarLogExtension;
}

export interface DocumentRedaction {
  /** The entry as written. Its removals count toward the document's report. */
  entry(entry: HarEntry, index: number): HarEntry;
  /** The same redaction, not counted: for deciding how to write a body before the entry is complete. */
  preview(entry: HarEntry, index: number): HarEntry;
  /** The log without its entries, redacted, and the report for the whole document. */
  finish(log: LogFields): {
    readonly log: { readonly [field: string]: unknown };
    readonly report: HarLogRedactionExtension | null;
  };
}

const PAGE_FIELD_PREFIX = "log.pages[]";

export function documentRedaction(choice: RedactionChoice): DocumentRedaction {
  if (choice === "none") {
    return {
      entry: (entry) => entry,
      preview: (entry) => entry,
      finish: (log) => ({ log: { ...log }, report: null }),
    };
  }
  const level = choice;
  const counts = new Map<HarRedactionPlace, number>();
  const unexaminedPlaces = new Set<HarRedactionPlace>();
  const entryRecords: HarRedactionRecord[] = [];
  let entriesAffected = 0;
  return {
    entry(entry, index) {
      const result = redactHarEntry(entry, { level }, index);
      for (const place of result.places) {
        if (place.count > 0) counts.set(place.place, (counts.get(place.place) ?? 0) + place.count);
        if (level === "standard" && place.status === "kept-not-examined" && place.count > 0) {
          unexaminedPlaces.add(place.place);
        }
      }
      if (result.records.length > 0) entriesAffected += 1;
      entryRecords.push(...result.records);
      return result.entry;
    },
    preview: (entry, index) => redactHarEntry(entry, { level }, index).entry,
    finish(log) {
      const { document, report } = redactHar({ log: { ...log, entries: [] } }, { level });
      const pageRecords = report.records.filter((r) => r.field.startsWith(PAGE_FIELD_PREFIX));
      const logRecords = report.records.filter((r) => !r.field.startsWith(PAGE_FIELD_PREFIX));
      const records = [...pageRecords, ...entryRecords, ...logRecords];
      const merged = finalizeRedactionReport(
        report,
        counts,
        unexaminedPlaces,
        records,
        report.entriesAffected + entriesAffected,
      );
      const { entries: _entries, ...rest } = document.log;
      return {
        log: { ...rest, _harExport: { ...rest._harExport, redaction: merged } },
        report: merged,
      };
    },
  };
}
