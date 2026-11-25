import type { ExportId, ExportJob, ExportState, Preview } from "@hark/export/jobs";
import { emptyReport, type ExportReport } from "@hark/export/report";
import type { ByteCount, EpochMs, Site, TabId } from "@hark/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import {
  firstStep,
  gaps,
  reducePopup,
  unexaminedRequestBodies,
  unexpectedGaps,
  type Draft,
  type PopupEvent,
  type PopupReading,
  type PopupView,
  type Step,
} from "./view.ts";

const TAB = 7 as TabId;
const SITE = "app.example.com" as Site;

const preview = (requests: number): Preview => ({
  requests,
  sources: { both: 0, recordingOnly: requests, devtoolsOnly: 0 },
  bodyBytesAtMost: (requests * 1000) as ByteCount,
  first: null,
  gate: null,
  inProgress: 0,
});

const reading = (patch: Partial<PopupReading> = {}): PopupReading => ({
  tab: { kind: "tab", tabId: TAB },
  site: SITE,
  devtools: "closed",
  gate: null,
  rows: [
    { id: "this-tab-everything", preview: preview(12) },
    { id: "this-tab-recent", preview: preview(4) },
    { id: "this-site", preview: preview(30) },
    { id: "everything", preview: preview(90) },
  ],
  problems: [],
  running: null,
  last: null,
  defaults: { bodies: "include", redaction: "standard" },
  ...patch,
});

const job = (state: ExportState, id = "job-1"): ExportJob => ({
  id: id as ExportId,
  request: {
    selection: { scope: "everything", range: { kind: "everything" }, include: "all" },
    bodies: "include",
    redaction: "standard",
    packaging: "har",
    fileName: null,
  },
  fileName: "app.example.com.har",
  startedAt: 0 as EpochMs,
  state,
});

const writing: ExportState = { kind: "writing", done: 3, total: 10, bytes: 2048 as ByteCount };

const run = (start: Step, ...events: PopupEvent[]): Step =>
  events.reduce<Step>((step, event) => reducePopup(step.view, event), start);

const kind = (step: Step) => step.view.kind;

describe("the popup's first screen", () => {
  it.each<[string, Partial<PopupReading>, PopupView["kind"]]>([
    ["rows for a tab with requests", {}, "ready"],
    ["the error view when the recording is off", { problems: ["archive-refused"] }, "error-store"],
    [
      "rows, with a warning, for a problem that does not stop recording",
      { problems: ["write-failed"] },
      "ready",
    ],
    ["the no-tab view on Zen's empty tab", { tab: { kind: "no-tab" }, site: null }, "no-tab"],
    [
      "the no-tab view for a tab that closed",
      { tab: { kind: "no-such-tab", tabId: TAB }, site: null },
      "no-tab",
    ],
    ["the private view in a private window", { gate: "private-window" }, "empty-private"],
    [
      "rows in a private window with DevTools open",
      { gate: "private-window", devtools: "open" },
      "ready",
    ],
    [
      "the empty view for a tab with nothing recorded",
      {
        rows: [
          { id: "this-tab-everything", preview: preview(0) },
          { id: "everything", preview: preview(90) },
        ],
      },
      "empty-tab",
    ],
  ])("shows %s", (_, patch, expected) => {
    expect(kind(firstStep(reading(patch)))).toBe(expected);
  });

  it("shows a running export and starts reading its progress", () => {
    const step = firstStep(reading({ running: job(writing) }));
    expect(step.view.kind).toBe("exporting");
    expect(step.command).toEqual({ kind: "watch", id: "job-1" });
  });
});

describe("one click on a row", () => {
  it("starts the row's export with the footer's choices", () => {
    const step = run(
      firstStep(reading()),
      { kind: "choices-changed", choices: { bodies: "omit", redaction: "none" } },
      { kind: "row-clicked", row: "this-tab-everything" },
    );
    expect(step.command).toEqual({
      kind: "start",
      request: {
        selection: {
          scope: "tab",
          tabId: TAB,
          range: { kind: "since-tab-opened" },
          include: "all",
        },
        bodies: "omit",
        redaction: "none",
        packaging: "har",
        fileName: null,
      },
    });
  });

  it("exports everything from the no-tab view, and nothing for a row it cannot serve", () => {
    const noTab = firstStep(reading({ tab: { kind: "no-tab" }, site: null }));
    expect(run(noTab, { kind: "row-clicked", row: "everything" }).command).toMatchObject({
      kind: "start",
      request: { selection: { scope: "everything", range: { kind: "everything" } } },
    });
    expect(run(noTab, { kind: "row-clicked", row: "this-tab-everything" }).command).toBeNull();
  });

  it("follows the job from progress to its result, reading progress once", () => {
    const started = run(firstStep(reading()), { kind: "job", job: job(writing) });
    expect(started.view.kind).toBe("exporting");
    expect(started.command).toEqual({ kind: "watch", id: "job-1" });
    const progressed = run(started, { kind: "job", job: job({ ...writing, done: 9 }) });
    expect(progressed.command).toBeNull();
    const saved: ExportState = {
      kind: "done",
      fileName: "app.example.com.har",
      folderLabel: "Downloads",
      report: emptyReport("standard", 0, { recording: 0, devtools: 0 }, {}, []),
      route: "link",
    };
    const done = run(progressed, { kind: "job", job: job(saved) });
    expect(done.view).toMatchObject({ kind: "done", saved: { fileName: "app.example.com.har" } });
    expect(run(done, { kind: "reveal" }).command).toEqual({ kind: "reveal", id: "job-1" });
    expect(run(done, { kind: "copy-path" }).command).toEqual({ kind: "copy-path", id: "job-1" });
    expect(run(done, { kind: "notice", notice: "copied" }).view).toMatchObject({
      notice: "copied",
    });
  });

  it("ignores progress for another export while one is shown", () => {
    const shown = run(firstStep(reading()), { kind: "job", job: job(writing) });
    expect(run(shown, { kind: "job", job: job(writing, "job-2") }).view).toBe(shown.view);
  });

  it("reads the popup again on the way back from a result, so the rows show the new export", () => {
    const saved: ExportState = {
      kind: "done",
      fileName: "app.example.com.har",
      folderLabel: "Downloads",
      report: emptyReport("standard", 0, { recording: 0, devtools: 0 }, {}, []),
      route: "link",
    };
    const done = run(firstStep(reading()), { kind: "job", job: job(saved) });
    const back = run(done, { kind: "back" });
    expect(back.view.kind).toBe("ready");
    expect(back.command).toEqual({ kind: "load" });
    const fresh = reading({
      rows: [{ id: "this-tab-everything", preview: preview(15) }],
      last: job(saved),
    });
    expect(run(back, { kind: "loaded", reading: fresh }).view).toMatchObject({
      kind: "ready",
      reading: { last: { fileName: "app.example.com.har" }, rows: [{ preview: { requests: 15 } }] },
    });
  });

  it("returns home and reloads after a cancel", () => {
    const shown = run(firstStep(reading()), { kind: "job", job: job(writing) });
    expect(run(shown, { kind: "cancel" }).command).toEqual({ kind: "cancel", id: "job-1" });
    const cancelled = run(shown, { kind: "job", job: job({ kind: "cancelled" }) });
    expect(cancelled.view.kind).toBe("ready");
    expect(cancelled.command).toEqual({ kind: "load" });
  });

  it("shows a write failure and retries the same request, with bodies off when asked", () => {
    const failed = run(firstStep(reading()), {
      kind: "job",
      job: job({
        kind: "write-failed",
        failure: { kind: "disk-full", needBytes: 9 as ByteCount, freeBytes: 1 as ByteCount },
      }),
    });
    expect(failed.view.kind).toBe("error-write");
    expect(run(failed, { kind: "retry", bodies: "omit" }).command).toMatchObject({
      kind: "start",
      request: { selection: { scope: "everything" }, bodies: "omit", redaction: "standard" },
    });
  });
});

describe("custom export", () => {
  const NOW = Date.UTC(2026, 10, 16, 14, 47, 30);
  const opened = () => run(firstStep(reading()), { kind: "custom-opened", now: NOW });
  const draftOf = (step: Step): Draft =>
    (step.view as Extract<PopupView, { kind: "custom" }>).draft;
  const previewed = (step: Step) => {
    if (step.command?.kind !== "preview")
      throw new Error(`no preview: ${JSON.stringify(step.command)}`);
    return step.command.selection;
  };
  const edit = (step: Step, patch: Partial<Draft>) =>
    run(step, { kind: "draft-changed", draft: { ...draftOf(step), ...patch } });

  it("opens on this tab since it opened and counts it", () => {
    const step = opened();
    expect(step.view.kind).toBe("custom");
    expect(step.command).toEqual({
      kind: "preview",
      selection: { scope: "tab", tabId: TAB, range: { kind: "since-tab-opened" }, include: "all" },
    });
  });

  it("falls back to everything when a tab-only range meets another scope", () => {
    const step = edit(opened(), { scope: "site" });
    expect(step.command).toEqual({
      kind: "preview",
      selection: { scope: "site", site: SITE, range: { kind: "everything" }, include: "all" },
    });
  });

  it("sends a typed range as whole minutes and refuses one that ends before it starts", () => {
    const between = edit(opened(), {
      range: "between",
      from: "2026-11-16T13:47",
      to: "2026-11-16T14:47",
    });
    const from = new Date("2026-11-16T13:47").getTime();
    expect(between.command).toEqual({
      kind: "preview",
      selection: {
        scope: "tab",
        tabId: TAB,
        range: { kind: "between", span: { from, to: from + 3_600_000 } },
        include: "all",
      },
    });
    const inverted = edit(between, { from: "2026-11-16T15:00" });
    expect(inverted.view).toMatchObject({ check: { ok: false, problem: "range" } });
    expect(inverted.command).toBeNull();
    expect(run(inverted, { kind: "custom-export" }).command).toBeNull();
  });

  it("refuses a file name the API would refuse, and passes a good one through", () => {
    expect(edit(opened(), { fileName: "a/b" }).view).toMatchObject({
      check: { ok: false, problem: "file-name" },
    });
    const named = edit(opened(), { fileName: "  checkout bug  ", include: "fetch-and-xhr" });
    expect(run(named, { kind: "custom-export" }).command).toMatchObject({
      kind: "start",
      request: { fileName: "checkout bug", selection: { include: "fetch-and-xhr" } },
    });
  });

  it("keeps the count of the current draft only", () => {
    const first = opened();
    const changed = edit(first, { range: "last-60" });
    const stale = previewed(first);
    expect(
      run(changed, { kind: "previewed", selection: stale, preview: preview(5) }).view,
    ).toMatchObject({ preview: null });
    const current = previewed(changed);
    expect(
      run(changed, { kind: "previewed", selection: current, preview: preview(5) }).view,
    ).toMatchObject({
      preview: { requests: 5 },
    });
  });
});

describe("bodies that are not in the file", () => {
  const report = (): ExportReport => {
    const base = emptyReport("standard", 0, { recording: 0, devtools: 0 }, {}, []);
    return {
      ...base,
      requests: 40,
      bodies: {
        response: {
          ...base.bodies.response,
          included: 20,
          missing: { "removed-by-retention": 7, "media-setting": 3, "omitted-by-choice": 0 },
          cutShort: { "over-body-cap": 2 },
        },
        request: { ...base.bodies.request, missing: { "network-aborted": 1 } },
      },
    };
  };

  it("groups each reason with its count and the setting that changes it", () => {
    expect(gaps(report())).toEqual([
      expect.objectContaining({
        place: "response",
        count: 7,
        settings: "storage",
        cutShort: false,
      }),
      expect.objectContaining({ place: "response", count: 3, settings: "media", cutShort: false }),
      expect.objectContaining({ place: "response", count: 2, settings: "storage", cutShort: true }),
      expect.objectContaining({ place: "request", count: 1, settings: null }),
    ]);
    expect(unexpectedGaps(gaps(report()))).toBe(12);
  });

  it("lists bodies the user left out without counting them as missing", () => {
    const base = report();
    const chosen: ExportReport = {
      ...base,
      bodies: {
        ...base.bodies,
        response: { ...base.bodies.response, missing: { "omitted-by-choice": 40 }, cutShort: {} },
      },
    };
    expect(gaps(chosen)[0]).toMatchObject({ count: 40, chosen: true });
    expect(unexpectedGaps(gaps(chosen))).toBe(0);
  });

  it("reports unexamined request-body-other count only under standard redaction", () => {
    const base = report();
    const withRedaction = (
      status: "kept-not-examined" | "removed",
      count: number,
    ): ExportReport => ({
      ...base,
      redaction: {
        choice: "standard",
        report: {
          applied: true,
          level: "standard",
          guarantee: "",
          remainingRisk: "",
          totalRemoved: 0,
          entriesAffected: 0,
          rules: [],
          records: [],
          places: [
            {
              place: "request-body-other",
              label: "every other request body",
              fields: ["request.postData.text"],
              status,
              count,
              detail: status === "removed" ? "removed" : "not examined: may contain secrets",
              canStillHold: "",
            },
          ],
          notExamined: [],
          notInspected: [],
        },
      },
    });
    expect(unexaminedRequestBodies(base)).toBe(0);
    expect(unexaminedRequestBodies(withRedaction("kept-not-examined", 0))).toBe(0);
    expect(unexaminedRequestBodies(withRedaction("kept-not-examined", 3))).toBe(3);
    expect(unexaminedRequestBodies(withRedaction("removed", 3))).toBe(0);
  });
});
