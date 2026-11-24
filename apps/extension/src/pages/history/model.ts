// What the history page shows and the export it asks for. Pure: the store makes the calls.

import { parseExportRequest, type ExportJob, type ExportRequest } from "@hark/export/jobs";
import type { Session, SiteSummary } from "@hark/recording/activity";
import type { Site } from "@hark/recording/ids";
import type { SettingsView } from "../../../experiment/contract.ts";

/** A ticked session. Its start does not move as new activity arrives, so site and start name it. */
export const sessionKey = (session: Pick<Session, "site" | "from">): string =>
  `${session.site} ${String(session.from)}`;

export type Ticked = ReadonlyMap<string, Session>;

export interface HistoryState {
  /** null until the first list arrives. */
  readonly sites: readonly SiteSummary[] | null;
  readonly site: Site | null;
  /** The shown site's sessions; null while they load. */
  readonly sessions: readonly Session[] | null;
  /** Ticked sessions of every site, kept while the user moves between sites. */
  readonly ticked: Ticked;
  /** The site whose exclusion waits for its one confirmation. */
  readonly confirming: Site | null;
  /** The site excluded last, for the line that says its data is gone. */
  readonly excluded: Site | null;
  readonly settings: SettingsView | null;
  readonly search: string;
  /** The export this page started last. */
  readonly job: ExportJob | null;
  readonly notice: "copied" | "gone" | null;
  /** Why the last read of the lists failed; null once one succeeds. */
  readonly failed: string | null;
  /** When the lists were read, so day names and the week chart agree with the counts shown. */
  readonly readAt: number;
}

export const EMPTY_HISTORY: HistoryState = {
  sites: null,
  site: null,
  sessions: null,
  ticked: new Map(),
  confirming: null,
  excluded: null,
  settings: null,
  search: "",
  job: null,
  notice: null,
  failed: null,
  readAt: 0,
};

export function toggled(ticked: Ticked, session: Session): Ticked {
  const next = new Map(ticked);
  const key = sessionKey(session);
  if (next.has(key)) next.delete(key);
  else next.set(key, session);
  return next;
}

const defaultsOf = (settings: SettingsView | null) => {
  const defaults = settings?.user.exportDefaults ?? { bodies: "include", secrets: "remove" };
  return {
    bodies: defaults.bodies,
    redaction: defaults.secrets === "remove" ? "standard" : "none",
  } as const;
};

/**
 * The export for these sessions, through the same parser the API runs, or null. An empty list does not parse, so an
 * empty selection has no request to send.
 */
export const sessionsExport = (
  sessions: readonly Session[],
  settings: SettingsView | null,
): ExportRequest | null =>
  parseExportRequest({
    selection: {
      scope: "sessions",
      sessions: sessions.map((s) => ({ site: s.site, span: { from: s.from, to: s.to } })),
      include: "all",
    },
    ...defaultsOf(settings),
    packaging: "har",
    fileName: null,
  });

export const siteExport = (site: Site, settings: SettingsView | null): ExportRequest | null =>
  parseExportRequest({
    selection: { scope: "site", site, range: { kind: "everything" }, include: "all" },
    ...defaultsOf(settings),
    packaging: "har",
    fileName: null,
  });

export interface Totals {
  readonly sessions: number;
  readonly sites: number;
  readonly requests: number;
  readonly bytesAtMost: number;
}

export function totals(sessions: Iterable<Session>): Totals {
  const sites = new Set<Site>();
  let count = 0;
  let requests = 0;
  let bytesAtMost = 0;
  for (const s of sessions) {
    count += 1;
    sites.add(s.site);
    requests += s.requests;
    bytesAtMost += s.bodyBytesAtMost;
  }
  return { sessions: count, sites: sites.size, requests, bytesAtMost };
}

const DAY_MS = 86_400_000;
const midnight = (ms: number): number => {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

const DAY_NAME = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE_NAME = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** Today, Yesterday, then the weekday and date. */
function dayLabel(ms: number, now: number): string {
  const days = Math.round((midnight(now) - midnight(ms)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return DATE_NAME.format(ms);
}

/** Sessions under their start day's heading, in the order given (newest first). */
export function byDay(
  sessions: readonly Session[],
  now: number,
): readonly { readonly label: string; readonly sessions: readonly Session[] }[] {
  const groups: { label: string; sessions: Session[] }[] = [];
  for (const session of sessions) {
    const label = dayLabel(session.from, now);
    const last = groups.at(-1);
    if (last?.label === label) last.sessions.push(session);
    else groups.push({ label, sessions: [session] });
  }
  return groups;
}

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "14:02 to 14:47". `to` is the minute after the last active one. */
export const timeSpan = (session: Pick<Session, "from" | "to">): string =>
  `${TIME.format(session.from)} to ${TIME.format(session.to - 60_000)}`;

/**
 * The last seven of the site's daily counts, oldest first, each with its weekday. The site summary's days end at today.
 */
export function lastWeek(
  days: readonly number[],
  now: number,
): readonly { readonly day: string; readonly requests: number; readonly today: boolean }[] {
  const week = days.slice(-7);
  return week.map((requests, index) => ({
    day: DAY_NAME.format(midnight(now) - (week.length - 1 - index) * DAY_MS + DAY_MS / 2),
    requests,
    today: index === week.length - 1,
  }));
}

/** The sidebar's sites whose name holds the search text. */
export const matching = (sites: readonly SiteSummary[], search: string): readonly SiteSummary[] => {
  const needle = search.trim().toLowerCase();
  return needle === "" ? sites : sites.filter((s) => s.site.includes(needle));
};
