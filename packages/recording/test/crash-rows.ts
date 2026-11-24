// The crash table as typed test data. Each row is a point where the process can die, the directory it leaves, the
// plan the next start must make, and how the exchange reads in an export afterwards. Every entry is built from a
// layout path and read back by parseArchiveName.

import type { ExchangeId, LogSegmentId, RunId, Site } from "../src/ids.ts";
import {
  bodyFilePath,
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  packId,
  packPath,
  parseArchiveName,
  partPath,
  type ArchiveName,
} from "../src/layout.ts";
import type {
  DirSnapshot,
  LogEntry,
  ReadsAs,
  ReconcileStep,
  SnapshotEntry,
  SummaryEntry,
} from "../src/reconcile.ts";

const OLD = "mhz01" as RunId;
const NOW = "mhz02" as RunId;
const SITE = "example.com" as Site;
const GONE = "excluded.example" as Site;
/** 68 characters: its directory name is cut to 55, `~` and a hash, and cannot be read back as a Site. */
const LONG = `${"a".repeat(60)}.example` as Site;
const SEG = logSegmentId(SITE, OLD, 0);
const SEG_GONE = logSegmentId(GONE, OLD, 0);
const SEG_LONG = logSegmentId(LONG, OLD, 0);
const X = `${OLD}.15032385539` as ExchangeId;
const Y = `${OLD}.15032385540` as ExchangeId;

function entryAt<K extends ArchiveName["kind"]>(kind: K, path: readonly string[]) {
  const name = parseArchiveName(path);
  const is = (n: ArchiveName | null): n is Extract<ArchiveName, { readonly kind: K }> =>
    n?.kind === kind;
  if (!is(name)) throw new Error(`${path.join("/")} does not parse as ${kind}`);
  return { path: path.join("/"), name };
}

const part = (id: ExchangeId): SnapshotEntry => entryAt("part", partPath(id));
const body = (id: ExchangeId, site: Site = SITE): SnapshotEntry =>
  entryAt("body", bodyFilePath(site, id));
const pack = (): SnapshotEntry => entryAt("pack", packPath(packId(SITE, OLD, 0)));
const settingsTmp: SnapshotEntry = entryAt("tmp", [`${LAYOUT.settings}${LAYOUT.tmpSuffix}`]);
const summaryTmp = (segment: LogSegmentId = SEG): SnapshotEntry => {
  const path = logSummaryPath(segment);
  return entryAt("tmp", [...path.slice(0, -1), `${path.at(-1) ?? ""}${LAYOUT.tmpSuffix}`]);
};
const log = (
  bytes: number,
  validBytes: number = bytes,
  namesBodies: readonly ExchangeId[] = [],
  segment: LogSegmentId = SEG,
): LogEntry => ({ ...entryAt("log", logSegmentPath(segment)), bytes, validBytes, namesBodies });
const summary = (valid: boolean, segment: LogSegmentId = SEG): SummaryEntry => ({
  ...entryAt("summary", logSummaryPath(segment)),
  valid,
});

const dir = (over: Partial<DirSnapshot>): DirSnapshot => ({
  current: NOW,
  excluded: [],
  entries: [],
  unfinishedExports: [],
  ...over,
});
const openSegment: readonly SnapshotEntry[] = [log(2_266)];
const sealedSegment: readonly SnapshotEntry[] = [log(2_266), summary(true)];

export interface CrashRow {
  readonly n: number;
  readonly diedDuring: string;
  readonly onDisk: string;
  readonly snapshot: DirSnapshot;
  readonly plan: readonly ReconcileStep["kind"][];
  readonly readsAs: ReadsAs;
  /** What the other columns leave unsaid. */
  readonly note?: string;
}

export const CRASH_ROWS: readonly CrashRow[] = [
  {
    n: 1,
    diedDuring: "a file tee, streaming (kill)",
    onDisk: "old-run part in incoming/, no line",
    snapshot: dir({ entries: [part(X), ...openSegment] }),
    plan: ["delete-part", "summarize-log"],
    readsAs: "absent",
  },
  {
    n: 2,
    diedDuring: "after the tee closed, before the rename",
    onDisk: "old-run part, no line",
    snapshot: dir({ entries: [part(X), ...sealedSegment] }),
    plan: ["delete-part"],
    readsAs: "absent",
  },
  {
    n: 3,
    diedDuring: "after the rename, before the line flushed (kill)",
    onDisk: "old-run body file, no line names it",
    snapshot: dir({ entries: [body(X), ...openSegment] }),
    plan: ["delete-orphan-body", "summarize-log"],
    readsAs: "absent",
  },
  {
    n: 4,
    diedDuring: "after the line flushed",
    onDisk: "body file and its line",
    snapshot: dir({ entries: [body(X), log(2_266, 2_266, [X])] }),
    plan: ["summarize-log"],
    readsAs: "available",
  },
  {
    n: 5,
    diedDuring: "a memory sink, before its batch was appended",
    onDisk: "nothing for this exchange",
    snapshot: dir({ entries: openSegment }),
    plan: ["summarize-log"],
    readsAs: "absent",
  },
  {
    n: 6,
    diedDuring: "after the pack append, before the line append (kill)",
    onDisk: "unreferenced bytes at the pack's end",
    snapshot: dir({ entries: [pack(), ...openSegment] }),
    plan: ["summarize-log"],
    readsAs: "absent",
  },
  {
    n: 7,
    diedDuring: "a torn line append",
    onDisk: "segment ends mid-line",
    snapshot: dir({ entries: [log(2_334, 2_266)] }),
    plan: ["truncate-log", "summarize-log"],
    readsAs: "lines-before-the-tear",
  },
  {
    n: 8,
    diedDuring: "a power loss that kept a line but lost its pack bytes",
    onDisk: "pack shorter than a line's range",
    snapshot: dir({ entries: [pack(), ...openSegment] }),
    plan: ["summarize-log"],
    readsAs: "interrupted-by-crash",
  },
  {
    n: 9,
    diedDuring: "a clean seal, before its summary was written",
    onDisk: "old-run segment, no summary",
    snapshot: dir({ entries: openSegment }),
    plan: ["summarize-log"],
    readsAs: "available",
  },
  {
    n: 10,
    diedDuring: "with a pack open",
    onDisk: "old-run pack. Only the current run appends, so it is sealed by being old",
    snapshot: dir({ entries: [pack(), ...sealedSegment] }),
    plan: [],
    readsAs: "available",
    note: "Only the current run appends to a pack, so recovery has no pack step",
  },
  {
    n: 11,
    diedDuring: "a settings write",
    onDisk: "settings.json.tmp beside the old file",
    snapshot: dir({ entries: [settingsTmp, ...sealedSegment] }),
    plan: ["delete-tmp"],
    readsAs: "not-applicable",
  },
  {
    n: 12,
    diedDuring: "retention, mid-run",
    onDisk: "some planned files deleted",
    snapshot: dir({ entries: sealedSegment }),
    plan: [],
    readsAs: "available",
    note: "The next retention pass recomputes",
  },
  {
    n: 13,
    diedDuring: "an export, mid-write (kill)",
    onDisk: "<folder>/<name>.har.part, journal says started",
    snapshot: dir({
      entries: sealedSegment,
      unfinishedExports: [{ path: "/home/u/Downloads/a.har.part", at: "ours" }],
    }),
    plan: ["delete-export-part"],
    readsAs: "not-applicable",
  },
  {
    n: 14,
    diedDuring: "an exclusion, after settings, during the directory delete (kill)",
    onDisk: "part of sites/<site>/, the site in excludedSites",
    snapshot: dir({
      excluded: [GONE],
      entries: [log(900, 900, [Y], SEG_GONE), body(Y, GONE), ...sealedSegment],
    }),
    plan: ["delete-excluded-site"],
    readsAs: "site-gone",
  },
  {
    n: 15,
    diedDuring: "an exclusion, before settings were written",
    onDisk: "everything as it was",
    snapshot: dir({ entries: sealedSegment }),
    plan: [],
    readsAs: "available",
    note: "The options page shows the site as not excluded",
  },
  {
    n: 16,
    diedDuring: "a summary write (kill during the .tmp write)",
    onDisk: "<segment>.summary.json.tmp, no summary",
    snapshot: dir({ entries: [summaryTmp(), ...openSegment] }),
    plan: ["delete-tmp", "summarize-log"],
    readsAs: "available",
    note: "Summaries are written through .tmp and a rename",
  },
  {
    n: 17,
    diedDuring: "a summary that is present but unreadable, or no longer matches its segment",
    onDisk: "summary.json that does not decode",
    snapshot: dir({ entries: [summary(false), ...openSegment] }),
    plan: ["delete-invalid-summary", "summarize-log"],
    readsAs: "available",
    note: "A summary counts only when it decodes and matches its segment's size",
  },
  {
    n: 18,
    diedDuring: "an exclusion while a tee for that site streamed",
    onDisk: "old-run part in incoming/, the site partly deleted",
    snapshot: dir({
      excluded: [GONE],
      entries: [part(Y), log(900, 900, [], SEG_GONE), ...sealedSegment],
    }),
    plan: ["delete-excluded-site", "delete-part"],
    readsAs: "site-gone",
    note: "Parts live in incoming/, outside every site directory",
  },
  {
    n: 19,
    diedDuring: "a clean quit, disable or update with a tee streaming",
    onDisk: "the abandoned line (browser-closed or recording-stopped), its part, a sealed segment",
    snapshot: dir({ entries: [part(X), ...sealedSegment] }),
    plan: ["delete-part"],
    readsAs: "absent",
    note: "The abandoned line names the true reason",
  },
  {
    n: 20,
    diedDuring: "nothing: this run's own part while recovery runs",
    onDisk: "a part of the current run",
    snapshot: dir({ entries: [part(`${NOW}.7` as ExchangeId), ...sealedSegment] }),
    plan: [],
    readsAs: "not-applicable",
    note: "Files of the current run are never in a plan",
  },
  {
    n: 21,
    diedDuring: "a torn line append, on a site whose directory name is cut",
    onDisk: "sites/<55 characters>~<hash>/: a body file, the segment that names it ends mid-line",
    snapshot: dir({ entries: [body(X, LONG), log(2_334, 2_266, [X], SEG_LONG)] }),
    plan: ["truncate-log", "summarize-log"],
    readsAs: "lines-before-the-tear",
    note: "The cut directory name still ties the body file to its segment, so the body is no orphan",
  },
  {
    n: 22,
    diedDuring: "an exclusion, after the segment was deleted and before its summary",
    onDisk: "an excluded site's summary.json without its segment",
    snapshot: dir({ excluded: [GONE], entries: [summary(false, SEG_GONE), ...sealedSegment] }),
    plan: ["delete-excluded-site"],
    readsAs: "site-gone",
    note: "The site's directory goes whole; its summary is not planned as invalid on its own",
  },
];
