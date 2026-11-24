import { describe, expect, it } from "vite-plus/test";

import {
  applyActivity,
  countWindows,
  currentRunKeys,
  emptyActivity,
  firstMinuteOfTab,
  pageSessions,
  pageSites,
  parseHistoryCursor,
  segmentsFor,
  SESSION_GAP_MINUTES,
  type ActivityIndex,
  type ActivityKey,
  type Window,
  windowOf,
} from "../src/activity.ts";
import type { SettledExchange } from "../src/exchange.ts";
import type {
  ByteCount,
  EpochMs,
  ExchangeId,
  LogSegmentId,
  Minute,
  RunId,
  Site,
  TabKey,
} from "../src/ids.ts";
import { summarize } from "../src/log.ts";
import { random } from "./random.ts";
import { request, response, stop } from "./fixtures.ts";

const MINUTE = 60_000;
const BASE = 1_794_799_980_000;
const RUN = "mhz02" as RunId;
const OLD = "mhz01" as RunId;
const at = (minute: number, second = 0) => (BASE + minute * MINUTE + second * 1000) as EpochMs;
const m = (minute: number) => (BASE + minute * MINUTE) as Minute;
const window = (key: ActivityKey, from: number, to: number): Window => {
  const w = windowOf(key, m(from), m(to));
  if (w === null) throw new Error(`window ${from} to ${to} is empty`);
  return w;
};
const tab = (run: RunId, browserId: number): TabKey => ({ run, browserId });

interface Made {
  readonly exchange: SettledExchange;
  readonly segment: LogSegmentId;
  readonly bodyBytes: number;
}

function exchange(o: {
  run: RunId;
  channel: number;
  startedAt: EpochMs;
  tab: TabKey | null;
  site: Site;
  policyType: number;
  bodyBytes: number;
}): SettledExchange {
  const req = {
    ...request,
    id: `${o.run}.${o.channel}` as ExchangeId,
    startedAt: o.startedAt,
    tab: o.tab,
    topSite: o.site,
    policyType: o.policyType,
  };
  return o.bodyBytes === 0
    ? { kind: "unanswered", request: req, stop, upload: { kind: "none" } }
    : {
        kind: "answered",
        request: req,
        response,
        stop,
        route: "small",
        body: {
          kind: "stored",
          at: { kind: "file", site: o.site, id: req.id, length: o.bodyBytes as ByteCount },
          encoding: null,
          check: "length-matched",
        },
        upload: { kind: "none" },
      };
}

function build(seed: number): {
  readonly index: ActivityIndex;
  readonly made: readonly Made[];
  readonly viaLines: ReadonlySet<LogSegmentId>;
} {
  const r = random(seed);
  const sites = ["a.example", "b.example", "c.example"] as Site[];
  const tabs = [tab(RUN, 1), tab(RUN, 2), tab(OLD, 1), null];
  const made: Made[] = [];
  let index = emptyActivity(RUN);
  for (let i = 0; i < 400; i++) {
    const run = r.pick([RUN, OLD]);
    const site = r.pick(sites);
    const segment = `${site}/${run}-${r.int(2)}` as LogSegmentId;
    const bodyBytes = r.pick([0, 14, 20_000]);
    const e = exchange({
      run,
      channel: i,
      startedAt: at(r.int(180), r.int(60)),
      tab: r.pick(tabs),
      site,
      policyType: r.pick([6, 11, 20, 3]),
      bodyBytes,
    });
    made.push({ exchange: e, segment, bodyBytes });
  }
  const segments = [...new Set(made.map((x) => x.segment))];
  const viaLines = new Set<LogSegmentId>();
  for (const segment of segments) {
    const lines = made
      .filter((x) => x.segment === segment)
      .map((x) => ({ v: 2 as const, exchange: x.exchange }));
    if (r.int(2) === 0) {
      viaLines.add(segment);
      for (const line of lines)
        index = applyActivity(index, { kind: "settled", segment, exchange: line.exchange });
      if (r.int(2) === 0)
        index = applyActivity(index, {
          kind: "segment-summarized",
          summary: summarize(segment, lines, 1 as ByteCount),
        });
    } else {
      index = applyActivity(index, {
        kind: "segment-summarized",
        summary: summarize(segment, lines, 1 as ByteCount),
      });
    }
  }
  return { index, made, viaLines };
}

const matches = (e: SettledExchange, w: Window): boolean => {
  const minute = Math.floor(e.request.startedAt / MINUTE) * MINUTE;
  if (minute < w.from || minute >= w.to) return false;
  if (w.key === "all") return true;
  if ("site" in w.key) return e.request.topSite === w.key.site;
  return (
    e.request.tab !== null &&
    e.request.tab.run === w.key.tab.run &&
    e.request.tab.browserId === w.key.tab.browserId
  );
};

describe("counts against a brute-force count over the same lines", () => {
  const keys: readonly ActivityKey[] = [
    "all",
    { site: "a.example" as Site },
    { tab: tab(RUN, 1) },
    { tab: tab(OLD, 1) },
  ];
  it.each([1, 2, 3, 4, 5])("seed %i", (seed) => {
    const { index, made } = build(seed);
    const r = random(seed * 7919);
    for (let trial = 0; trial < 60; trial++) {
      const windows: Window[] = Array.from({ length: 1 + r.int(3) }, () => {
        const from = r.int(180);
        return window(r.pick(keys), from, from + 1 + r.int(60));
      });
      const hit = made.filter((x) => windows.some((w) => matches(x.exchange, w)));
      expect(countWindows(index, windows)).toEqual({
        requests: hit.length,
        fetchOrXhr: hit.filter((x) => [11, 20].includes(x.exchange.request.policyType)).length,
        bodyBytesAtMost: hit.reduce((sum, x) => sum + x.bodyBytes, 0),
        first:
          hit.length === 0
            ? null
            : Math.min(
                ...hit.map((x) => Math.floor(x.exchange.request.startedAt / MINUTE) * MINUTE),
              ),
      });
      expect(new Set(segmentsFor(index, windows))).toEqual(new Set(hit.map((x) => x.segment)));
    }
  });

  it("the current run's keys for a tab, or for every tab, are the channels of this run's settled lines", () => {
    const { index, made, viaLines } = build(9);
    const thisRun = made.filter(
      (x) => viaLines.has(x.segment) && x.exchange.request.id.startsWith(`${RUN}.`),
    );
    const channels = (xs: typeof made) =>
      new Set(xs.map((x) => x.exchange.request.id.slice(RUN.length + 1)));
    for (const t of [tab(RUN, 1), tab(RUN, 2), tab(OLD, 1)]) {
      const want = thisRun.filter(
        (x) => JSON.stringify(x.exchange.request.tab) === JSON.stringify(t),
      );
      expect(want.length > 0 || t.run === OLD).toBe(true);
      expect(currentRunKeys(index, t)).toEqual(channels(want));
    }
    const tabless = thisRun.filter((x) => x.exchange.request.tab === null);
    expect(tabless.length > 0 && tabless.length < thisRun.length).toBe(true);
    expect(currentRunKeys(index, null)).toEqual(channels(thisRun));
  });
});

describe("windows", () => {
  it.each([
    [0, 1, true],
    [5, 5, false],
    [6, 5, false],
  ])("from minute %i to %i builds a window: %s", (from, to, built) => {
    expect(windowOf("all", m(from), m(to)) !== null).toBe(built);
  });
});

describe("events", () => {
  const e1 = exchange({
    run: RUN,
    channel: 1,
    startedAt: at(0),
    tab: tab(RUN, 1),
    site: "a.example" as Site,
    policyType: 6,
    bodyBytes: 14,
  });
  const e2 = exchange({
    run: RUN,
    channel: 2,
    startedAt: at(5),
    tab: tab(RUN, 1),
    site: "b.example" as Site,
    policyType: 20,
    bodyBytes: 0,
  });
  const seg = "a.example/mhz02-0" as LogSegmentId;
  const segB = "b.example/mhz02-0" as LogSegmentId;
  const fresh = () => {
    let index = emptyActivity(RUN);
    index = applyActivity(index, { kind: "settled", segment: seg, exchange: e1 });
    return applyActivity(index, { kind: "settled", segment: segB, exchange: e2 });
  };
  const all: readonly Window[] = [window("all", -10, 100)];

  it("a summary replaces what the segment's lines added, so applying it twice counts once", () => {
    let index = fresh();
    const summary = summarize(seg, [{ v: 2, exchange: e1 }], 1 as ByteCount);
    index = applyActivity(index, { kind: "segment-summarized", summary });
    index = applyActivity(index, { kind: "segment-summarized", summary });
    expect(countWindows(index, all).requests).toBe(2);
    expect(currentRunKeys(index, tab(RUN, 1))).toEqual(new Set(["1", "2"]));
  });

  it("a removed segment and a forgotten site leave the counts and the run's keys", () => {
    let index = applyActivity(fresh(), { kind: "segment-removed", segment: seg });
    expect(countWindows(index, all)).toMatchObject({ requests: 1, first: m(5) });
    expect(currentRunKeys(index, tab(RUN, 1))).toEqual(new Set(["2"]));
    index = applyActivity(index, { kind: "site-forgotten", site: "b.example" as Site });
    expect(countWindows(index, all)).toEqual({
      requests: 0,
      fetchOrXhr: 0,
      bodyBytesAtMost: 0,
      first: null,
    });
    expect(currentRunKeys(index, tab(RUN, 1)).size).toBe(0);
    expect(segmentsFor(index, all)).toEqual([]);
  });

  it("the first minute of a tab", () => {
    expect(firstMinuteOfTab(fresh(), tab(RUN, 1))).toBe(m(0));
    expect(firstMinuteOfTab(fresh(), tab(RUN, 9))).toBeNull();
  });
});

describe("sessions", () => {
  const site = "a.example" as Site;
  const index = (minutes: readonly number[]) =>
    minutes.reduce(
      (acc, minute, i) =>
        applyActivity(acc, {
          kind: "settled",
          segment: "a.example/mhz02-0" as LogSegmentId,
          exchange: exchange({
            run: RUN,
            channel: i,
            startedAt: at(minute, 30),
            tab: tab(RUN, 1 + (i % 2)),
            site,
            policyType: 3,
            bodyBytes: 10,
          }),
        }),
      emptyActivity(RUN),
    );

  it(`a gap of exactly ${SESSION_GAP_MINUTES} minutes stays one session; one more minute splits it`, () => {
    expect(pageSessions(index([0, 30]), site, null, 10).rows).toEqual([
      { site, from: m(0), to: m(31), requests: 2, bodyBytesAtMost: 20, tabs: 2 },
    ]);
    expect(pageSessions(index([0, 31]), site, null, 10).rows).toEqual([
      { site, from: m(31), to: m(32), requests: 1, bodyBytesAtMost: 10, tabs: 1 },
      { site, from: m(0), to: m(1), requests: 1, bodyBytesAtMost: 10, tabs: 1 },
    ]);
  });

  it("pages most recent first, and a page does not move when new activity arrives", () => {
    const minutes = [0, 40, 80, 120, 160];
    const first = pageSessions(index(minutes), site, null, 2);
    expect(first.rows.map((s) => s.from)).toEqual([m(160), m(120)]);
    const later = pageSessions(index([...minutes, 170, 300]), site, first.next, 2);
    expect(later.rows.map((s) => s.from)).toEqual([m(80), m(40)]);
    const last = pageSessions(index(minutes), site, later.next, 2);
    expect(last).toEqual({ rows: [expect.objectContaining({ from: m(0) })], next: null });
  });
});

describe("sites", () => {
  const add = (acc: ActivityIndex, site: string, minute: number, channel: number) =>
    applyActivity(acc, {
      kind: "settled",
      segment: `${site}/mhz02-0` as LogSegmentId,
      exchange: exchange({
        run: RUN,
        channel,
        startedAt: at(minute),
        tab: null,
        site: site as Site,
        policyType: 3,
        bodyBytes: 5,
      }),
    });
  const midnight = m(14 * 1440);
  const index = [
    ["a.example", 14 * 1440 + 10],
    ["a.example", 13 * 1440 + 5],
    ["b.example", 14 * 1440 + 10],
    ["c.example", 2 * 1440],
    ["d.example", 0],
  ].reduce(
    (acc, [site, minute], i) => add(acc, site as string, minute as number, i),
    emptyActivity(RUN),
  );

  it("most recent first, ties by name, with requests per day for the last 14 days", () => {
    const page = pageSites(index, null, 10, midnight);
    expect(page.rows.map((s) => [s.site, s.requests, s.bodyBytesAtMost])).toEqual([
      ["a.example", 2, 10],
      ["b.example", 1, 5],
      ["c.example", 1, 5],
      ["d.example", 1, 5],
    ]);
    expect(page.rows[0]!.days).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(page.rows[2]!.days).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(page.rows[3]!.days).toEqual(new Array(14).fill(0));
  });

  it("a keyset cursor resumes after the last row it returned", () => {
    const first = pageSites(index, null, 2, midnight);
    expect(first.rows.map((s) => s.site)).toEqual(["a.example", "b.example"]);
    const next = pageSites(index, first.next, 2, midnight);
    expect(next).toMatchObject({
      rows: [{ site: "c.example" }, { site: "d.example" }],
      next: null,
    });
    expect(parseHistoryCursor(first.next)).toBe(first.next);
  });

  it.each([42, "", "s:12", "s:x:a.example", "s:12:Bad Site", "n:", "n:1.5", "q:1"])(
    "%j is not a history cursor",
    (raw) => {
      expect(parseHistoryCursor(raw)).toBeNull();
    },
  );
});
