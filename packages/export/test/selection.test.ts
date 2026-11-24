import {
  addMinutes,
  parsePositiveMinutes,
  parseSite,
  parseTabId,
  type Minute,
  type RunId,
  type Site,
  type TabId,
  type TabKey,
} from "@hark/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import {
  PRESETS,
  RANGE_RULES,
  inSelection,
  parseSelection,
  resolveSelection,
  type MinuteSpan,
  type Selection,
  type SelectionContext,
} from "../src/selection.ts";
import { importAltered } from "./alter.ts";

const MIN = 60_000;
const m = (iso: string): Minute => (Math.floor(Date.parse(iso) / MIN) * MIN) as Minute;
const TAB_ID = parseTabId(7)!;
const TAB_KEY: TabKey = { run: "mhz02" as RunId, browserId: 7 };
const SITE = parseSite("bank.example")!;
const OTHER_SITE = parseSite("cdn.example")!;

describe("selection range table and minute edges", () => {
  const now = m("2026-11-16T12:15:00.000Z");
  const localMidnight = m("2026-11-16T05:00:00.000Z");

  it("last N minutes resolves [now - N, now + 1) and checks minute edges", () => {
    const sel: Selection = {
      scope: "everything",
      range: { kind: "last", minutes: parsePositiveMinutes(15)! },
      include: "all",
    };
    const resolved = resolveSelection(sel, {
      now,
      localMidnight,
      tab: null,
      tabFirstSeen: null,
      devtoolsFirst: null,
    });
    expect(resolved.windows).toHaveLength(1);
    expect(resolved.windows[0]!.from).toBe(m("2026-11-16T12:00:00.000Z"));
    expect(resolved.windows[0]!.to).toBe(m("2026-11-16T12:16:00.000Z"));

    expect(
      inSelection(resolved, {
        startedMinute: m("2026-11-16T11:59:00.000Z"),
        tab: null,
        site: SITE,
        fetchOrXhr: false,
      }),
    ).toBe(false);
    expect(
      inSelection(resolved, {
        startedMinute: m("2026-11-16T12:00:00.000Z"),
        tab: null,
        site: SITE,
        fetchOrXhr: false,
      }),
    ).toBe(true);
    expect(
      inSelection(resolved, {
        startedMinute: m("2026-11-16T12:15:00.000Z"),
        tab: null,
        site: SITE,
        fetchOrXhr: false,
      }),
    ).toBe(true);
    expect(
      inSelection(resolved, {
        startedMinute: m("2026-11-16T12:16:00.000Z"),
        tab: null,
        site: SITE,
        fetchOrXhr: false,
      }),
    ).toBe(false);
  });

  it("today resolves from localMidnight, including 23-hour spring-forward and 25-hour fall-back DST days", () => {
    // 2026-03-08 America/New_York spring forward (UTC-5 -> UTC-4): local midnight is 05:00Z, 23:00 local is 03:00Z next day (22h span).
    const springMidnight = m("2026-03-08T05:00:00.000Z");
    const springLate = m("2026-03-09T03:59:00.000Z");
    const springResolved = resolveSelection(
      { scope: "everything", range: { kind: "today" }, include: "all" },
      {
        now: springLate,
        localMidnight: springMidnight,
        tab: null,
        tabFirstSeen: null,
        devtoolsFirst: null,
      },
    );
    expect(springResolved.windows[0]!.from).toBe(springMidnight);
    expect(springResolved.windows[0]!.to).toBe(addMinutes(springLate, 1));
    expect((springResolved.windows[0]!.to - springResolved.windows[0]!.from) / MIN).toBe(23 * 60);

    // 2026-11-01 America/New_York fall back (UTC-4 -> UTC-5): local midnight is 04:00Z, 23:59 local is 04:59Z next day (25h span).
    const fallMidnight = m("2026-11-01T04:00:00.000Z");
    const fallLate = m("2026-11-02T04:59:00.000Z");
    const fallResolved = resolveSelection(
      { scope: "everything", range: { kind: "today" }, include: "all" },
      {
        now: fallLate,
        localMidnight: fallMidnight,
        tab: null,
        tabFirstSeen: null,
        devtoolsFirst: null,
      },
    );
    expect(fallResolved.windows[0]!.from).toBe(fallMidnight);
    expect(fallResolved.windows[0]!.to).toBe(addMinutes(fallLate, 1));
    expect((fallResolved.windows[0]!.to - fallResolved.windows[0]!.from) / MIN).toBe(25 * 60);
  });

  it("since-tab-opened uses devtoolsFirst for a private tab and the earlier of tabFirstSeen and devtoolsFirst otherwise", () => {
    const dtFirst = m("2026-11-16T11:40:00.000Z");
    const recFirst = m("2026-11-16T11:50:00.000Z");
    const sel: Selection = {
      scope: "tab",
      tabId: TAB_ID,
      range: { kind: "since-tab-opened" },
      include: "all",
    };

    // Private tab: recording never saw it (tabFirstSeen null), devtoolsFirst sets the window start.
    const privateResolved = resolveSelection(sel, {
      now,
      localMidnight,
      tab: TAB_KEY,
      tabFirstSeen: null,
      devtoolsFirst: dtFirst,
    });
    expect(privateResolved.windows[0]!.from).toBe(dtFirst);
    expect(privateResolved.tabId).toBe(TAB_ID);

    // Both present: earlier wins.
    const earlierDt = resolveSelection(sel, {
      now,
      localMidnight,
      tab: TAB_KEY,
      tabFirstSeen: recFirst,
      devtoolsFirst: dtFirst,
    });
    expect(earlierDt.windows[0]!.from).toBe(dtFirst);

    const earlierRec = resolveSelection(sel, {
      now,
      localMidnight,
      tab: TAB_KEY,
      tabFirstSeen: dtFirst,
      devtoolsFirst: recFirst,
    });
    expect(earlierRec.windows[0]!.from).toBe(dtFirst);

    // Neither seen: falls back to now.
    const neither = resolveSelection(sel, {
      now,
      localMidnight,
      tab: null,
      tabFirstSeen: null,
      devtoolsFirst: null,
    });
    expect(neither.windows[0]!.from).toBe(now);
    expect(neither.windows[0]!.to).toBe(addMinutes(now, 1));
  });

  it("fetch-and-xhr and site/sessions filters exclude non-matching items", () => {
    const span = (
      parseSelection({
        scope: "sessions",
        sessions: [{ site: SITE, span: { from: now, to: addMinutes(now, 5) } }],
        include: "fetch-and-xhr",
      }) as Extract<Selection, { readonly scope: "sessions" }>
    ).sessions[0].span;
    const resolved = resolveSelection(
      {
        scope: "sessions",
        sessions: [{ site: SITE, span: span as MinuteSpan }],
        include: "fetch-and-xhr",
      },
      { now, localMidnight, tab: null, tabFirstSeen: null, devtoolsFirst: null },
    );
    expect(
      inSelection(resolved, { startedMinute: now, tab: null, site: SITE, fetchOrXhr: true }),
    ).toBe(true);
    expect(
      inSelection(resolved, { startedMinute: now, tab: null, site: SITE, fetchOrXhr: false }),
    ).toBe(false);
    expect(
      inSelection(resolved, {
        startedMinute: now,
        tab: null,
        site: OTHER_SITE,
        fetchOrXhr: true,
      }),
    ).toBe(false);
  });

  it("PRESETS yields null for tab rows when tabId is null and for this-site when site is null", () => {
    expect(Object.keys(RANGE_RULES).sort()).toEqual([
      "between",
      "everything",
      "last",
      "since-tab-opened",
      "today",
    ]);
    expect(PRESETS.map((p) => p.selection(null, null) !== null)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(PRESETS.map((p) => p.selection(TAB_ID, SITE) !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("parseSelection rejection table", () => {
  const validSpan = { from: m("2026-11-16T12:00:00.000Z"), to: m("2026-11-16T12:10:00.000Z") };

  it.each([
    ["null", null],
    ["array", []],
    ["missing include", { scope: "everything", range: { kind: "everything" } }],
    ["bad include", { scope: "everything", range: { kind: "everything" }, include: "images" }],
    ["unknown scope", { scope: "window", range: { kind: "everything" }, include: "all" }],
    ["tab -1", { scope: "tab", tabId: -1, range: { kind: "everything" }, include: "all" }],
    ["tab 1.5", { scope: "tab", tabId: 1.5, range: { kind: "everything" }, include: "all" }],
    ["tab string", { scope: "tab", tabId: "7", range: { kind: "everything" }, include: "all" }],
    [
      "site with URL",
      { scope: "site", site: "https://a.example/", range: { kind: "everything" }, include: "all" },
    ],
    [
      "last 0 minutes",
      { scope: "everything", range: { kind: "last", minutes: 0 }, include: "all" },
    ],
    [
      "last -15 minutes",
      { scope: "everything", range: { kind: "last", minutes: -15 }, include: "all" },
    ],
    [
      "between inverted",
      {
        scope: "everything",
        range: { kind: "between", span: { from: validSpan.to, to: validSpan.from } },
        include: "all",
      },
    ],
    [
      "between equal",
      {
        scope: "everything",
        range: { kind: "between", span: { from: validSpan.from, to: validSpan.from } },
        include: "all",
      },
    ],
    [
      "between off-minute",
      {
        scope: "everything",
        range: { kind: "between", span: { from: validSpan.from + 1000, to: validSpan.to } },
        include: "all",
      },
    ],
    ["empty sessions", { scope: "sessions", sessions: [], include: "all" }],
    [
      "sessions bad site",
      { scope: "sessions", sessions: [{ site: "not valid!", span: validSpan }], include: "all" },
    ],
  ])("rejects %s", (_label, raw) => {
    expect(parseSelection(raw)).toBeNull();
  });

  it("accepts valid selections of every scope", () => {
    expect(
      parseSelection({
        scope: "tab",
        tabId: 0 as TabId,
        range: { kind: "last", minutes: 15 },
        include: "fetch-and-xhr",
      }),
    ).not.toBeNull();
    expect(
      parseSelection({
        scope: "sessions",
        sessions: [{ site: "app.example" as Site, span: validSpan }],
        include: "all",
      }),
    ).not.toBeNull();
  });

  it("with devtoolsFirst ignored a private tab loses its start, and an off-by-one last range drops the boundary minute", async () => {
    const noDevtoolsFirst = await importAltered<{
      resolveSelection: typeof resolveSelection;
    }>("selection.ts", {
      id: "ignore-devtools-first",
      from: "const earliest = earlierMinute(context.tabFirstSeen, context.devtoolsFirst);",
      to: "const earliest = context.tabFirstSeen;",
    });
    const ctx: SelectionContext = {
      now: m("2026-11-16T12:15:00.000Z"),
      localMidnight: m("2026-11-16T05:00:00.000Z"),
      tab: TAB_KEY,
      tabFirstSeen: null,
      devtoolsFirst: m("2026-11-16T11:40:00.000Z"),
    };
    const broken = noDevtoolsFirst.resolveSelection(
      { scope: "tab", tabId: TAB_ID, range: { kind: "since-tab-opened" }, include: "all" },
      ctx,
    );
    expect(broken.windows[0]!.from).not.toBe(ctx.devtoolsFirst);

    const offByOneLast = await importAltered<{
      resolveSelection: typeof resolveSelection;
    }>("selection.ts", {
      id: "last-off-by-one",
      from: "from: addMinutes(context.now, -range.minutes),",
      to: "from: addMinutes(context.now, -(range.minutes - 1)),",
    });
    const brokenLast = offByOneLast.resolveSelection(
      {
        scope: "everything",
        range: { kind: "last", minutes: parsePositiveMinutes(15)! },
        include: "all",
      },
      ctx,
    );
    expect(brokenLast.windows[0]!.from).not.toBe(m("2026-11-16T12:00:00.000Z"));
  });
});
