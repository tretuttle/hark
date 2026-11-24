// The in-memory index behind every count the UI shows: popup rows, the custom count card, the history page's sites
// and sessions. Derived from segment summaries plus the open segments' lines and never written to disk, so it cannot
// drift from the log.

import type { BodyLocation, SettledExchange, UploadOutcome } from "./exchange.ts";
import {
  addMinutes,
  parseExchangeId,
  parseSite,
  toMinute,
  type ByteCount,
  type ChannelKey,
  type LogSegmentId,
  type Minute,
  type RunId,
  type Site,
  type TabKey,
} from "./ids.ts";
import type { SegmentSummary } from "./log.ts";

/** Requests that started in one minute for one tab and site. */
export interface ActivityBucket {
  readonly minute: Minute;
  readonly tab: TabKey | null;
  readonly site: Site | null;
  readonly requests: number;
  /** Subset with policy type fetch or XHR, so the "fetch and XHR only" filter counts exactly. */
  readonly fetchOrXhr: number;
  /**
   * Body bytes recorded, request bodies included. Retention may have removed some since and the index is not told
   * which, so the popup shows this as "up to": never more than the export can contain.
   */
  readonly bodyBytesRecorded: ByteCount;
  /** The URL of the first request in the bucket. */
  readonly topUrl: string;
}

export interface ActivityIndex {
  readonly __activity: unique symbol;
}

export type ActivityEvent =
  | { readonly kind: "segment-summarized"; readonly summary: SegmentSummary }
  | { readonly kind: "settled"; readonly segment: LogSegmentId; readonly exchange: SettledExchange }
  | { readonly kind: "segment-removed"; readonly segment: LogSegmentId }
  | { readonly kind: "site-forgotten"; readonly site: Site };

/** loadInfo.externalContentPolicyType values of XMLHttpRequest (11) and fetch (20). */
const FETCH_OR_XHR_POLICY_TYPES: readonly number[] = [11, 20];

interface RunKey {
  readonly tab: string;
  readonly site: Site | null;
}
interface SegmentRecord {
  buckets: Map<string, ActivityBucket>;
  readonly keys: Map<ChannelKey, RunKey>;
}
interface IndexState {
  readonly run: RunId;
  readonly segments: Map<LogSegmentId, SegmentRecord>;
}

const state = (index: ActivityIndex): IndexState => index as unknown as IndexState;
const tabName = (tab: TabKey | null): string => (tab === null ? "" : `${tab.run}:${tab.browserId}`);
const bucketName = (b: ActivityBucket): string => `${b.minute}|${tabName(b.tab)}|${b.site ?? ""}`;
const storedBytes = (at: BodyLocation | null): number => (at === null ? 0 : at.length);
const uploadBytes = (upload: UploadOutcome): number =>
  upload.kind === "stored" ? upload.at.length : 0;

export function emptyActivity(run: RunId): ActivityIndex {
  const fresh: IndexState = { run, segments: new Map() };
  return fresh as unknown as ActivityIndex;
}

export function bucketOf(exchange: SettledExchange): ActivityBucket {
  const { request } = exchange;
  const body =
    exchange.kind === "answered" && exchange.body.kind === "stored" ? exchange.body.at : null;
  return {
    minute: toMinute(request.startedAt),
    tab: request.tab,
    site: request.topSite,
    requests: 1,
    fetchOrXhr: FETCH_OR_XHR_POLICY_TYPES.includes(request.policyType) ? 1 : 0,
    bodyBytesRecorded: (storedBytes(body) + uploadBytes(exchange.upload)) as ByteCount,
    topUrl: request.url,
  };
}

/** Buckets with the same minute, tab and site become one, keeping the first one's topUrl. */
export function mergeBuckets(
  buckets: Iterable<ActivityBucket>,
  into: Map<string, ActivityBucket> = new Map(),
): ActivityBucket[] {
  for (const b of buckets) {
    const name = bucketName(b);
    const had = into.get(name);
    into.set(
      name,
      had === undefined
        ? b
        : {
            ...had,
            requests: had.requests + b.requests,
            fetchOrXhr: had.fetchOrXhr + b.fetchOrXhr,
            bodyBytesRecorded: (had.bodyBytesRecorded + b.bodyBytesRecorded) as ByteCount,
          },
    );
  }
  return [...into.values()];
}

function record(index: IndexState, segment: LogSegmentId): SegmentRecord {
  const existing = index.segments.get(segment);
  if (existing !== undefined) return existing;
  const created: SegmentRecord = { buckets: new Map(), keys: new Map() };
  index.segments.set(segment, created);
  return created;
}

/**
 * The only way the index changes. It updates the index in place and returns it: the store holds the only reference
 * and applies events in the order it writes files, on its one write chain. A summary replaces what lines added.
 */
export function applyActivity(index: ActivityIndex, event: ActivityEvent): ActivityIndex {
  const s = state(index);
  switch (event.kind) {
    case "settled": {
      const target = record(s, event.segment);
      const settled = event.exchange;
      mergeBuckets([bucketOf(settled)], target.buckets);
      const id = parseExchangeId(settled.request.id);
      if (id !== null && id.run === s.run)
        target.keys.set(id.channel, {
          tab: tabName(settled.request.tab),
          site: settled.request.topSite,
        });
      break;
    }
    case "segment-summarized":
      record(s, event.summary.segment).buckets = new Map(
        event.summary.buckets.map((b) => [bucketName(b), b]),
      );
      break;
    case "segment-removed":
      s.segments.delete(event.segment);
      break;
    case "site-forgotten":
      for (const [segment, r] of s.segments) {
        for (const [name, b] of r.buckets) if (b.site === event.site) r.buckets.delete(name);
        for (const [key, k] of r.keys) if (k.site === event.site) r.keys.delete(key);
        if (r.buckets.size === 0 && r.keys.size === 0) s.segments.delete(segment);
      }
      break;
  }
  return index;
}

const allBuckets = function* (index: ActivityIndex): Generator<ActivityBucket> {
  for (const r of state(index).segments.values()) yield* r.buckets.values();
};

/**
 * The channel keys this run recorded for one tab, or for every tab (and no tab) when `tab` is null. DevTools items are
 * always of the current run, so this set is all a preview needs to count both, recording-only and DevTools-only
 * exactly, without reading disk.
 */
export function currentRunKeys(index: ActivityIndex, tab: TabKey | null): ReadonlySet<ChannelKey> {
  const wanted = tab === null ? null : tabName(tab);
  const keys = new Set<ChannelKey>();
  for (const r of state(index).segments.values())
    for (const [key, k] of r.keys) if (wanted === null || k.tab === wanted) keys.add(key);
  return keys;
}

/** One stretch of minutes for one key. A selection resolves to one window (popup) or several (history multi-select). */
export type ActivityKey = { readonly tab: TabKey } | { readonly site: Site } | "all";
declare const nonEmpty: unique symbol;
export interface Window {
  readonly key: ActivityKey;
  /** Inclusive start minute, exclusive end minute. */
  readonly from: Minute;
  readonly to: Minute;
  /** Built only by windowOf, so from < to: an empty or inverted window cannot be passed. */
  readonly [nonEmpty]: true;
}

export function windowOf(key: ActivityKey, from: Minute, to: Minute): Window | null {
  return from < to ? ({ key, from, to } as Window) : null;
}

export interface Counts {
  readonly requests: number;
  readonly fetchOrXhr: number;
  readonly bodyBytesAtMost: ByteCount;
  readonly first: Minute | null;
}

const sameTab = (a: TabKey | null, b: TabKey): boolean =>
  a !== null && a.run === b.run && a.browserId === b.browserId;

function inWindow(b: ActivityBucket, w: Window): boolean {
  if (b.minute < w.from || b.minute >= w.to) return false;
  if (w.key === "all") return true;
  return "tab" in w.key ? sameTab(b.tab, w.key.tab) : b.site === w.key.site;
}

/** Exact request counts over the union of windows; a minute counted by two windows counts once. */
export function countWindows(index: ActivityIndex, windows: readonly Window[]): Counts {
  let requests = 0;
  let fetchOrXhr = 0;
  let bytes = 0;
  let first: Minute | null = null;
  for (const b of allBuckets(index)) {
    if (!windows.some((w) => inWindow(b, w))) continue;
    requests += b.requests;
    fetchOrXhr += b.fetchOrXhr;
    bytes += b.bodyBytesRecorded;
    first = first === null || b.minute < first ? b.minute : first;
  }
  return { requests, fetchOrXhr, bodyBytesAtMost: bytes as ByteCount, first };
}

/** Segments whose summary, or whose open lines, overlap any window. Reconcile re-summarized unreadable ones first. */
export function segmentsFor(
  index: ActivityIndex,
  windows: readonly Window[],
): readonly LogSegmentId[] {
  const found: LogSegmentId[] = [];
  for (const [segment, r] of state(index).segments) {
    if ([...r.buckets.values()].some((b) => windows.some((w) => inWindow(b, w))))
      found.push(segment);
  }
  return found;
}

export function firstMinuteOfTab(index: ActivityIndex, tab: TabKey): Minute | null {
  let first: Minute | null = null;
  for (const b of allBuckets(index))
    if (sameTab(b.tab, tab) && (first === null || b.minute < first)) first = b.minute;
  return first;
}

/** A session: a stretch of activity on one site with no gap longer than SESSION_GAP_MINUTES. The history page lists these. */
export interface Session {
  readonly site: Site;
  readonly from: Minute;
  /** Exclusive: the minute after the session's last active minute. */
  readonly to: Minute;
  readonly requests: number;
  readonly bodyBytesAtMost: ByteCount;
  readonly tabs: number;
}
/** Two active minutes belong to one session when the later one starts at most this many minutes after the earlier. */
export const SESSION_GAP_MINUTES = 30;
const DAY_MINUTES = 1440;
const SITE_DAYS = 14;

export interface SiteSummary {
  readonly site: Site;
  readonly requests: number;
  readonly bodyBytesAtMost: ByteCount;
  readonly last: Minute;
  /** Requests per day for the last 14 days, newest last. Each day is 24 hours back from `localMidnight`. */
  readonly days: readonly number[];
}

export type HistoryCursor = string & { readonly __historyCursor: unique symbol };
export interface Page<T> {
  readonly rows: readonly T[];
  readonly next: HistoryCursor | null;
}

const SITES_CURSOR = /^s:(-?[0-9]+):(.+)$/;
const SESSIONS_CURSOR = /^n:(-?[0-9]+)$/;

/** Cursors come back from extension pages, so the contract parses them here, where their format lives. */
export function parseHistoryCursor(raw: unknown): HistoryCursor | null {
  if (typeof raw !== "string") return null;
  const site = SITES_CURSOR.exec(raw);
  if (site !== null)
    return parseSite(site[2]) === site[2] && Number.isSafeInteger(Number(site[1]))
      ? (raw as HistoryCursor)
      : null;
  return SESSIONS_CURSOR.test(raw) && Number.isSafeInteger(Number(raw.slice(2)))
    ? (raw as HistoryCursor)
    : null;
}

function page<T>(
  ordered: readonly T[],
  after: (row: T) => boolean,
  limit: number,
  cursorOf: (row: T) => string,
): Page<T> {
  const rest = ordered.filter(after);
  const rows = rest.slice(0, Math.max(0, limit));
  const last = rows.at(-1);
  return {
    rows,
    next:
      rest.length > rows.length && last !== undefined ? (cursorOf(last) as HistoryCursor) : null,
  };
}

/** Most recent first, ties by site. Keyset cursor, so new activity does not shift later pages. */
export function pageSites(
  index: ActivityIndex,
  cursor: HistoryCursor | null,
  limit: number,
  localMidnight: Minute,
): Page<SiteSummary> {
  const sites = new Map<Site, { requests: number; bytes: number; last: Minute; days: number[] }>();
  const oldestDay = addMinutes(localMidnight, -(SITE_DAYS - 1) * DAY_MINUTES);
  for (const b of allBuckets(index)) {
    if (b.site === null) continue;
    const s = sites.get(b.site) ?? {
      requests: 0,
      bytes: 0,
      last: b.minute,
      days: new Array<number>(SITE_DAYS).fill(0),
    };
    s.requests += b.requests;
    s.bytes += b.bodyBytesRecorded;
    s.last = b.minute > s.last ? b.minute : s.last;
    const day = Math.floor((b.minute - oldestDay) / (DAY_MINUTES * 60_000));
    if (day >= 0 && day < SITE_DAYS) s.days[day] = (s.days[day] ?? 0) + b.requests;
    sites.set(b.site, s);
  }
  const ordered = [...sites]
    .map(([site, s]): SiteSummary => ({
      site,
      requests: s.requests,
      bodyBytesAtMost: s.bytes as ByteCount,
      last: s.last,
      days: s.days,
    }))
    .sort((a, b) => b.last - a.last || (a.site < b.site ? -1 : 1));
  const at = cursor === null ? null : SITES_CURSOR.exec(cursor);
  const after = (row: SiteSummary): boolean =>
    at === null ||
    row.last < Number(at[1]) ||
    (row.last === Number(at[1]) && row.site > (at[2] ?? ""));
  return page(ordered, after, limit, (row) => `s:${row.last}:${row.site}`);
}

/** Most recent first. A session's start stays put as new activity arrives, so it is the keyset cursor. */
export function pageSessions(
  index: ActivityIndex,
  site: Site,
  cursor: HistoryCursor | null,
  limit: number,
): Page<Session> {
  const minutes = new Map<Minute, ActivityBucket[]>();
  for (const b of allBuckets(index))
    if (b.site === site) minutes.set(b.minute, [...(minutes.get(b.minute) ?? []), b]);
  const sessions: Session[] = [];
  let open: {
    from: Minute;
    last: Minute;
    requests: number;
    bytes: number;
    tabs: Set<string>;
  } | null = null;
  const close = (): void => {
    if (open !== null)
      sessions.push({
        site,
        from: open.from,
        to: addMinutes(open.last, 1),
        requests: open.requests,
        bodyBytesAtMost: open.bytes as ByteCount,
        tabs: open.tabs.size,
      });
  };
  for (const minute of [...minutes.keys()].sort((a, b) => a - b)) {
    if (open === null || minute > addMinutes(open.last, SESSION_GAP_MINUTES)) {
      close();
      open = { from: minute, last: minute, requests: 0, bytes: 0, tabs: new Set() };
    }
    open.last = minute;
    for (const b of minutes.get(minute) ?? []) {
      open.requests += b.requests;
      open.bytes += b.bodyBytesRecorded;
      if (b.tab !== null) open.tabs.add(tabName(b.tab));
    }
  }
  close();
  const at = cursor === null ? null : SESSIONS_CURSOR.exec(cursor);
  const ordered = sessions.reverse();
  return page(
    ordered,
    (row) => at === null || row.from < Number(at[1]),
    limit,
    (row) => `n:${row.from}`,
  );
}
