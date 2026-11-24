// What the user asked to export. Never names a source.

import { windowOf, type ActivityKey, type Window } from "@hark/recording/activity";
import {
  addMinutes,
  parsePositiveMinutes,
  parseSite,
  parseTabId,
  type Minute,
  type NonEmpty,
  type PositiveMinutes,
  type RunId,
  type Site,
  type TabId,
  type TabKey,
} from "@hark/recording/ids";
import { isPlainRecord } from "./internal.ts";

declare const orderedRange: unique symbol;
/** from < to. Only parseSelection builds one, so an inverted or empty range cannot reach resolveSelection. */
export type MinuteSpan = { readonly from: Minute; readonly to: Minute } & {
  readonly [orderedRange]: true;
};

export type Range =
  | { readonly kind: "last"; readonly minutes: PositiveMinutes }
  | { readonly kind: "today" }
  | { readonly kind: "since-tab-opened" }
  | { readonly kind: "everything" }
  | { readonly kind: "between"; readonly span: MinuteSpan };

/** A history-page session the user ticked. */
export interface SessionRef {
  readonly site: Site;
  readonly span: MinuteSpan;
}

/** fetch-and-xhr drops images, fonts, styles, scripts and media: the API calls k6 and Postman users want. */
export type Include = "all" | "fetch-and-xhr";

export type Selection =
  | {
      readonly scope: "tab";
      readonly tabId: TabId;
      readonly range: Range;
      readonly include: Include;
    }
  | {
      readonly scope: "site";
      readonly site: Site;
      readonly range: Range;
      readonly include: Include;
    }
  | { readonly scope: "everything"; readonly range: Range; readonly include: Include }
  | {
      readonly scope: "sessions";
      readonly sessions: NonEmpty<SessionRef>;
      readonly include: Include;
    };

export type PresetId = "this-tab-everything" | "this-tab-recent" | "this-site" | "everything";

/** The popup's four rows. One table, so the parent counts and the popup labels the same rows. */
export const PRESETS: readonly {
  readonly id: PresetId;
  readonly selection: (tabId: TabId | null, site: Site | null) => Selection | null;
}[] = [
  {
    id: "this-tab-everything",
    selection: (tabId) =>
      tabId === null
        ? null
        : { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
  },
  {
    id: "this-tab-recent",
    selection: (tabId) =>
      tabId === null
        ? null
        : {
            scope: "tab",
            tabId,
            range: { kind: "last", minutes: 15 as PositiveMinutes },
            include: "all",
          },
  },
  {
    id: "this-site",
    selection: (_tabId, site) =>
      site === null ? null : { scope: "site", site, range: { kind: "everything" }, include: "all" },
  },
  {
    id: "everything",
    selection: () => ({ scope: "everything", range: { kind: "everything" }, include: "all" }),
  },
];

/** The parent resolves tabId to a TabKey once, at request time. `tabId` stays for the DevTools lookup. */
export interface ResolvedSelection {
  readonly windows: NonEmpty<Window>;
  readonly tabId: TabId | null;
  readonly include: Include;
}

export interface SelectionContext {
  readonly now: Minute;
  readonly localMidnight: Minute;
  readonly tab: TabKey | null;
  readonly tabFirstSeen: Minute | null;
  /** Oldest DevTools item for the tab, so private or excluded tabs are covered. */
  readonly devtoolsFirst: Minute | null;
}

const MINUTE_MS = 60_000;
const EPOCH_MINUTE = 0 as Minute;
// Unresolvable tab keys cannot match any real recorded TabKey (runId is non-empty, browserId >= 0).
const NO_TAB_KEY: TabKey = { run: "" as RunId, browserId: -1 };

function earlierMinute(a: Minute | null, b: Minute | null): Minute | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

type RangeBounds = { readonly from: Minute; readonly to: Minute };

export const RANGE_RULES: {
  readonly [K in Range["kind"]]: (
    range: Extract<Range, { readonly kind: K }>,
    context: SelectionContext,
  ) => RangeBounds;
} = {
  last: (range, context) => ({
    from: addMinutes(context.now, -range.minutes),
    to: addMinutes(context.now, 1),
  }),
  today: (_range, context) => ({
    from: (context.localMidnight <= context.now ? context.localMidnight : context.now) as Minute,
    to: addMinutes(context.now, 1),
  }),
  "since-tab-opened": (_range, context) => {
    const earliest = earlierMinute(context.tabFirstSeen, context.devtoolsFirst);
    const start = earliest !== null && earliest <= context.now ? earliest : context.now;
    return { from: start, to: addMinutes(context.now, 1) };
  },
  everything: (_range, context) => ({
    from: (context.now < EPOCH_MINUTE ? context.now : EPOCH_MINUTE) as Minute,
    to: addMinutes(context.now, 1),
  }),
  between: (range) => ({
    from: range.span.from,
    to: range.span.to,
  }),
};

function boundsOf(range: Range, context: SelectionContext): RangeBounds {
  const rule = RANGE_RULES[range.kind] as (r: Range, ctx: SelectionContext) => RangeBounds;
  return rule(range, context);
}

function buildWindow(key: ActivityKey, from: Minute, to: Minute): Window {
  const w = windowOf(key, from, to);
  if (w === null) {
    throw new RangeError(`Expected non-empty window, got ${String(from)}..${String(to)}`);
  }
  return w;
}

/**
 * since-tab-opened starts at the earlier of tabFirstSeen and devtoolsFirst, else now. today starts at local
 * midnight. Every window ends at the minute after now, so from < to holds for every window built here.
 */
export function resolveSelection(sel: Selection, context: SelectionContext): ResolvedSelection {
  if (sel.scope === "sessions") {
    const windows = sel.sessions.map((s) =>
      buildWindow({ site: s.site }, s.span.from, s.span.to),
    ) as unknown as NonEmpty<Window>;
    return { windows, tabId: null, include: sel.include };
  }
  const { from, to } = boundsOf(sel.range, context);
  const key: ActivityKey =
    sel.scope === "tab"
      ? { tab: context.tab ?? NO_TAB_KEY }
      : sel.scope === "site"
        ? { site: sel.site }
        : "all";
  return {
    windows: [buildWindow(key, from, to)],
    tabId: sel.scope === "tab" ? sel.tabId : null,
    include: sel.include,
  };
}

const sameTab = (a: TabKey | null, b: TabKey): boolean =>
  a !== null && a.run === b.run && a.browserId === b.browserId;

function inWindow(
  item: { readonly startedMinute: Minute; readonly tab: TabKey | null; readonly site: Site | null },
  w: Window,
): boolean {
  if (item.startedMinute < w.from || item.startedMinute >= w.to) return false;
  if (w.key === "all") return true;
  return "tab" in w.key ? sameTab(item.tab, w.key.tab) : item.site === w.key.site;
}

/** The one membership test both sources apply to their items. */
export function inSelection(
  sel: ResolvedSelection,
  item: {
    readonly startedMinute: Minute;
    readonly tab: TabKey | null;
    readonly site: Site | null;
    readonly fetchOrXhr: boolean;
  },
): boolean {
  if (sel.include === "fetch-and-xhr" && !item.fetchOrXhr) return false;
  return sel.windows.some((w) => inWindow(item, w));
}

function parseMinute(raw: unknown): Minute | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw % MINUTE_MS === 0
    ? (raw as Minute)
    : null;
}

function parseMinuteSpan(raw: unknown): MinuteSpan | null {
  if (!isPlainRecord(raw)) return null;
  const from = parseMinute(raw["from"]);
  const to = parseMinute(raw["to"]);
  if (from === null || to === null || from >= to) return null;
  return { from, to } as MinuteSpan;
}

function parseInclude(raw: unknown): Include | null {
  return raw === "all" || raw === "fetch-and-xhr" ? raw : null;
}

const RANGE_PARSERS: {
  readonly [K in Range["kind"]]: (raw: Record<string, unknown>) => Range | null;
} = {
  last: (raw) => {
    const minutes = parsePositiveMinutes(raw["minutes"]);
    return minutes === null ? null : { kind: "last", minutes };
  },
  today: () => ({ kind: "today" }),
  "since-tab-opened": () => ({ kind: "since-tab-opened" }),
  everything: () => ({ kind: "everything" }),
  between: (raw) => {
    const span = parseMinuteSpan(raw["span"]);
    return span === null ? null : { kind: "between", span };
  },
};

function parseRange(raw: unknown): Range | null {
  if (!isPlainRecord(raw)) return null;
  const kind = raw["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(RANGE_PARSERS, kind)) return null;
  return RANGE_PARSERS[kind as Range["kind"]](raw);
}

function parseSessionRef(raw: unknown): SessionRef | null {
  if (!isPlainRecord(raw)) return null;
  const site = parseSite(raw["site"]);
  const span = parseMinuteSpan(raw["span"]);
  return site === null || span === null ? null : { site, span };
}

const SCOPE_PARSERS: {
  readonly [S in Selection["scope"]]: (
    raw: Record<string, unknown>,
    include: Include,
  ) => Selection | null;
} = {
  tab: (raw, include) => {
    const tabId = parseTabId(raw["tabId"]);
    const range = parseRange(raw["range"]);
    return tabId === null || range === null ? null : { scope: "tab", tabId, range, include };
  },
  site: (raw, include) => {
    const site = parseSite(raw["site"]);
    const range = parseRange(raw["range"]);
    return site === null || range === null ? null : { scope: "site", site, range, include };
  },
  everything: (raw, include) => {
    const range = parseRange(raw["range"]);
    return range === null ? null : { scope: "everything", range, include };
  },
  sessions: (raw, include) => {
    const rawSessions = raw["sessions"];
    if (!Array.isArray(rawSessions) || rawSessions.length === 0) return null;
    const sessions: SessionRef[] = [];
    for (const entry of rawSessions) {
      const parsed = parseSessionRef(entry);
      if (parsed === null) return null;
      sessions.push(parsed);
    }
    return {
      scope: "sessions",
      sessions: sessions as unknown as NonEmpty<SessionRef>,
      include,
    };
  },
};

/** The one parser for preview and startExport input. Rejects inverted spans, zero or negative minutes, empty session lists, bad tab ids. */
export function parseSelection(raw: unknown): Selection | null {
  if (!isPlainRecord(raw)) return null;
  const include = parseInclude(raw["include"]);
  if (include === null) return null;
  const scope = raw["scope"];
  if (typeof scope !== "string" || !Object.hasOwn(SCOPE_PARSERS, scope)) return null;
  return SCOPE_PARSERS[scope as Selection["scope"]](raw, include);
}
