// The popup is one state union, so a screen that mixes two states cannot be drawn. `reducePopup` is pure: it returns
// the command to run instead of running it, so every transition is tested without a browser.

import type { ExportId, ExportJob, ExportRequest, ExportState, Preview } from "@hark/export/jobs";
import {
  CUT_SHORT_REASONS,
  MISSING_REASONS,
  type BodyPlace,
  type CutShortReason,
  type MissingReason,
} from "@hark/export/missing";
import type { RedactionChoice } from "@hark/export/redaction";
import type { ExportReport } from "@hark/export/report";
import {
  parseSelection,
  PRESETS,
  type Include,
  type PresetId,
  type Selection,
} from "@hark/export/selection";
import type { PopupView as PopupReading, RecordingProblem } from "../../experiment/contract.ts";
import { localMinute } from "./format.ts";

export type { PopupReading };

export interface Choices {
  readonly bodies: "include" | "omit";
  readonly redaction: RedactionChoice;
}

/** A section of the settings page that a popup link opens. The page has one element per value, with that id. */
export type SettingsSection =
  | "storage"
  | "export-holding"
  | "unreadable-files"
  | "media"
  | "secrets"
  | "folder"
  | "sites";

export type Writing = Extract<ExportState, { readonly kind: "writing" }>;
export type Saved = Extract<ExportState, { readonly kind: "done" }>;
export type WriteFailed = Extract<ExportState, { readonly kind: "write-failed" }>;

export type Scope = "tab" | "site" | "everything";
export type RangeId =
  | "since-tab-opened"
  | "last-5"
  | "last-15"
  | "last-60"
  | "today"
  | "everything"
  | "between";

/** The Custom form as typed. `from` and `to` are `datetime-local` values, used only when range is "between". */
export interface Draft {
  readonly scope: Scope;
  readonly range: RangeId;
  readonly from: string;
  readonly to: string;
  readonly include: Include;
  readonly fileName: string;
}

export type DraftCheck =
  | { readonly ok: true; readonly selection: Selection; readonly fileName: string | null }
  | { readonly ok: false; readonly problem: "range" | "file-name" };

/** After Show in folder or Copy path: what the host answered. */
export type Notice = "copied" | "gone";

interface Home {
  readonly reading: PopupReading;
  readonly choices: Choices;
}

export type PopupView =
  | { readonly kind: "api-missing" }
  | ({ readonly kind: "ready" } & Home)
  /** The window's tab has no id the extension can use, such as Zen's empty tab. */
  | ({ readonly kind: "no-tab" } & Home)
  /** A tab with nothing recorded and no DevTools open on it. */
  | ({ readonly kind: "empty-tab" } & Home)
  | ({ readonly kind: "empty-private" } & Home)
  /** The recording is off. Offers an export from DevTools when a toolbox is open on the tab. */
  | ({ readonly kind: "error-store"; readonly problem: RecordingProblem } & Home)
  | ({
      readonly kind: "custom";
      readonly draft: Draft;
      readonly check: DraftCheck;
      readonly preview: Preview | null;
    } & Home)
  | ({ readonly kind: "exporting"; readonly job: ExportJob; readonly progress: Writing } & Home)
  | ({
      readonly kind: "done";
      readonly job: ExportJob;
      readonly saved: Saved;
      readonly notice: Notice | null;
    } & Home)
  | ({
      readonly kind: "error-write";
      readonly job: ExportJob;
      readonly failed: WriteFailed;
    } & Home);

export type PopupEvent =
  | { readonly kind: "api-missing" }
  | { readonly kind: "loaded"; readonly reading: PopupReading }
  | { readonly kind: "choices-changed"; readonly choices: Choices }
  | { readonly kind: "row-clicked"; readonly row: PresetId }
  | { readonly kind: "custom-opened"; readonly now: number }
  | { readonly kind: "draft-changed"; readonly draft: Draft }
  | { readonly kind: "previewed"; readonly selection: Selection; readonly preview: Preview }
  | { readonly kind: "custom-export" }
  | { readonly kind: "job"; readonly job: ExportJob }
  | { readonly kind: "cancel" }
  | { readonly kind: "back" }
  | { readonly kind: "reload" }
  | { readonly kind: "retry"; readonly bodies: "include" | "omit" }
  | { readonly kind: "show-last" }
  | { readonly kind: "reveal" }
  | { readonly kind: "copy-path" }
  | { readonly kind: "notice"; readonly notice: Notice }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "history" };

export type PopupCommand =
  | { readonly kind: "load" }
  | { readonly kind: "start"; readonly request: ExportRequest }
  | { readonly kind: "watch"; readonly id: ExportId }
  | { readonly kind: "cancel"; readonly id: ExportId }
  | { readonly kind: "preview"; readonly selection: Selection }
  | { readonly kind: "reveal"; readonly id: ExportId }
  | { readonly kind: "copy-path"; readonly id: ExportId }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "history" };

export interface Step {
  readonly view: PopupView;
  readonly command: PopupCommand | null;
}

/** What each recording problem means for the popup. A blocking one replaces the rows with the error-store view. */
export const RECORDING_PROBLEMS: {
  readonly [P in RecordingProblem]: { readonly blocking: boolean };
} = {
  "archive-refused": { blocking: true },
  "archive-unwritable": { blocking: true },
  "file-pages-can-read-files": { blocking: false },
  "settings-unreadable": { blocking: false },
  "write-failed": { blocking: false },
  "too-many-live-requests": { blocking: false },
  "over-cap-while-exporting": { blocking: false },
  "archive-entries-unreadable": { blocking: false },
};

const rowCount = (reading: PopupReading, row: PresetId): number =>
  reading.rows.find((r) => r.id === row)?.preview?.requests ?? 0;

/** First matching row wins: the home screen a reading gets when no export is running or shown. */
const HOME_RULES: readonly {
  readonly kind: "error-store" | "no-tab" | "empty-private" | "empty-tab" | "ready";
  readonly when: (reading: PopupReading) => boolean;
}[] = [
  {
    kind: "error-store",
    when: (r) => r.problems.some((p) => RECORDING_PROBLEMS[p].blocking),
  },
  { kind: "no-tab", when: (r) => r.tab.kind !== "tab" },
  { kind: "empty-private", when: (r) => r.gate === "private-window" && r.devtools !== "open" },
  {
    kind: "empty-tab",
    when: (r) => r.devtools !== "open" && rowCount(r, "this-tab-everything") === 0,
  },
  { kind: "ready", when: () => true },
];

function homeView(reading: PopupReading, choices: Choices): PopupView {
  const rule = HOME_RULES.find((r) => r.when(reading))!;
  if (rule.kind === "error-store") {
    const problem = reading.problems.find((p) => RECORDING_PROBLEMS[p].blocking)!;
    return { kind: "error-store", problem, reading, choices };
  }
  return { kind: rule.kind, reading, choices };
}

/** The view for a job: progress while it writes, its result once it ended. Cancelled leaves the home view. */
function jobStep(job: ExportJob, home: Home, from: PopupView | null): Step {
  switch (job.state.kind) {
    case "writing":
      return {
        view: { ...home, kind: "exporting", job, progress: job.state },
        command: from?.kind === "exporting" ? null : { kind: "watch", id: job.id },
      };
    case "done":
      return {
        view: { ...home, kind: "done", job, saved: job.state, notice: null },
        command: null,
      };
    case "write-failed":
      return { view: { ...home, kind: "error-write", job, failed: job.state }, command: null };
    case "cancelled":
      return { view: homeView(home.reading, home.choices), command: { kind: "load" } };
  }
}

const presetSelection = (reading: PopupReading, row: PresetId): Selection | null => {
  const tabId = reading.tab.kind === "tab" ? reading.tab.tabId : null;
  return PRESETS.find((p) => p.id === row)?.selection(tabId, reading.site) ?? null;
};

const exportRequest = (
  selection: Selection,
  choices: Choices,
  fileName: string | null,
): ExportRequest => ({
  selection,
  bodies: choices.bodies,
  redaction: choices.redaction,
  packaging: "har",
  fileName,
});

const MINUTE_MS = 60_000;

/** A `datetime-local` value as a whole local minute in epoch ms; NaN when it does not parse. */
const minuteOf = (local: string): number =>
  Math.floor(new Date(local).getTime() / MINUTE_MS) * MINUTE_MS;

export const SCOPES: readonly {
  readonly id: Scope;
  readonly raw: (reading: PopupReading) => Record<string, unknown> | null;
}[] = [
  {
    id: "tab",
    raw: (r) => (r.tab.kind === "tab" ? { scope: "tab", tabId: r.tab.tabId } : null),
  },
  { id: "site", raw: (r) => (r.site === null ? null : { scope: "site", site: r.site }) },
  { id: "everything", raw: () => ({ scope: "everything" }) },
];

export const RANGES: readonly {
  readonly id: RangeId;
  readonly tabOnly: boolean;
  readonly raw: (draft: Draft) => Record<string, unknown>;
}[] = [
  { id: "since-tab-opened", tabOnly: true, raw: () => ({ kind: "since-tab-opened" }) },
  { id: "last-5", tabOnly: false, raw: () => ({ kind: "last", minutes: 5 }) },
  { id: "last-15", tabOnly: false, raw: () => ({ kind: "last", minutes: 15 }) },
  { id: "last-60", tabOnly: false, raw: () => ({ kind: "last", minutes: 60 }) },
  { id: "today", tabOnly: false, raw: () => ({ kind: "today" }) },
  { id: "everything", tabOnly: false, raw: () => ({ kind: "everything" }) },
  {
    id: "between",
    tabOnly: false,
    raw: (d) => ({ kind: "between", span: { from: minuteOf(d.from), to: minuteOf(d.to) } }),
  },
];

/** The characters and names parseExportRequest refuses, so the form says so before the API does. */
const BAD_FILE_NAME = /[/\\:\u0000-\u001f]/u;

/** The form's input crosses into an API argument here, through the same parser the API runs. */
function checkDraft(draft: Draft, reading: PopupReading): DraftCheck {
  const name = draft.fileName.trim();
  if (BAD_FILE_NAME.test(name) || name === "." || name === "..") {
    return { ok: false, problem: "file-name" };
  }
  const scope = SCOPES.find((s) => s.id === draft.scope)!.raw(reading);
  const range = RANGES.find((r) => r.id === draft.range)!.raw(draft);
  const selection =
    scope === null ? null : parseSelection({ ...scope, range, include: draft.include });
  if (selection === null) return { ok: false, problem: "range" };
  return { ok: true, selection, fileName: name === "" ? null : name };
}

/** A range that only means something for a tab falls back to everything when the scope changes. */
const normalizeDraft = (draft: Draft): Draft =>
  draft.scope !== "tab" && RANGES.find((r) => r.id === draft.range)!.tabOnly
    ? { ...draft, range: "everything" }
    : draft;

const sameSelection = (a: Selection, b: Selection): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function customStep(home: Home, draft: Draft): Step {
  const normalized = normalizeDraft(draft);
  const check = checkDraft(normalized, home.reading);
  return {
    view: { ...home, kind: "custom", draft: normalized, check, preview: null },
    command: check.ok ? { kind: "preview", selection: check.selection } : null,
  };
}

const stay = (view: PopupView): Step => ({ view, command: null });

/** A reading shows the running export when there is one, else the home view. */
const loadedStep = (home: Home, from: PopupView | null): Step =>
  home.reading.running === null
    ? stay(homeView(home.reading, home.choices))
    : jobStep(home.reading.running, home, from);

/** The popup's first screen, with the user's export defaults as its choices. */
export const firstStep = (reading: PopupReading): Step =>
  loadedStep({ reading, choices: reading.defaults }, null);

export function reducePopup(view: PopupView, event: PopupEvent): Step {
  if (event.kind === "api-missing") return stay({ kind: "api-missing" });
  if (event.kind === "loaded") {
    return loadedStep(
      {
        reading: event.reading,
        choices: view.kind === "api-missing" ? event.reading.defaults : view.choices,
      },
      view,
    );
  }
  if (view.kind === "api-missing") return stay(view);
  const home: Home = { reading: view.reading, choices: view.choices };
  switch (event.kind) {
    case "choices-changed":
      return stay({ ...view, choices: event.choices });
    case "row-clicked": {
      const selection = presetSelection(home.reading, event.row);
      return selection === null
        ? stay(view)
        : {
            view,
            command: { kind: "start", request: exportRequest(selection, home.choices, null) },
          };
    }
    case "custom-opened": {
      const hasTab = home.reading.tab.kind === "tab";
      return customStep(home, {
        scope: hasTab ? "tab" : home.reading.site === null ? "everything" : "site",
        range: hasTab ? "since-tab-opened" : "everything",
        from: localMinute(event.now - 15 * MINUTE_MS),
        to: localMinute(event.now + MINUTE_MS),
        include: "all",
        fileName: "",
      });
    }
    case "draft-changed":
      return view.kind === "custom" ? customStep(home, event.draft) : stay(view);
    case "previewed":
      return view.kind === "custom" &&
        view.check.ok &&
        sameSelection(view.check.selection, event.selection)
        ? stay({ ...view, preview: event.preview })
        : stay(view);
    case "custom-export":
      return view.kind === "custom" && view.check.ok
        ? {
            view,
            command: {
              kind: "start",
              request: exportRequest(view.check.selection, home.choices, view.check.fileName),
            },
          }
        : stay(view);
    case "job":
      if (view.kind === "exporting" && view.job.id !== event.job.id) return stay(view);
      return jobStep(event.job, home, view);
    case "cancel":
      return view.kind === "exporting"
        ? { view, command: { kind: "cancel", id: view.job.id } }
        : stay(view);
    case "back":
      return { view: homeView(home.reading, home.choices), command: { kind: "load" } };
    case "reload":
      return { view, command: { kind: "load" } };
    case "retry":
      return view.kind === "error-write"
        ? {
            view,
            command: {
              kind: "start",
              request: { ...view.job.request, bodies: event.bodies },
            },
          }
        : stay(view);
    case "show-last":
      return home.reading.last === null ? stay(view) : jobStep(home.reading.last, home, view);
    case "reveal":
      return view.kind === "done"
        ? { view, command: { kind: "reveal", id: view.job.id } }
        : stay(view);
    case "copy-path":
      return view.kind === "done"
        ? { view, command: { kind: "copy-path", id: view.job.id } }
        : stay(view);
    case "notice":
      return view.kind === "done" ? stay({ ...view, notice: event.notice }) : stay(view);
    case "settings":
      return { view, command: { kind: "settings", section: event.section } };
    case "history":
      return { view, command: { kind: "history" } };
  }
}

/** One line of the result's list of bodies that are not in the file. */
export interface Gap {
  readonly place: BodyPlace;
  readonly count: number;
  readonly label: string;
  readonly cutShort: boolean;
  readonly settings: SettingsSection | null;
  /** Left out because the user turned bodies off: listed, but not counted as missing. */
  readonly chosen: boolean;
}

const PLACES: readonly BodyPlace[] = ["response", "request"];

/** Every missing and cut-short reason in the report with a count, in the export package's own words. */
export function gaps(report: ExportReport): readonly Gap[] {
  return PLACES.flatMap((place) => {
    const tally = report.bodies[place];
    const missing = (Object.entries(tally.missing) as [MissingReason, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, n]): Gap => ({
        place,
        count: n,
        label: MISSING_REASONS[reason].reportLabel,
        cutShort: false,
        settings: MISSING_REASONS[reason].settings,
        chosen: reason === "omitted-by-choice",
      }));
    const cut = (Object.entries(tally.cutShort) as [CutShortReason, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, n]): Gap => ({
        place,
        count: n,
        label: CUT_SHORT_REASONS[reason].reportLabel,
        cutShort: true,
        settings: reason === "over-body-cap" ? "storage" : null,
        chosen: false,
      }));
    return [...missing, ...cut];
  });
}

/** Response bodies the user did not choose to leave out and that are not whole in the file. */
export const unexpectedGaps = (list: readonly Gap[]): number =>
  list.filter((g) => !g.chosen && g.place === "response").reduce((sum, g) => sum + g.count, 0);

/** Non-form, non-JSON, non-multipart request bodies kept unexamined under standard redaction. */
export function unexaminedRequestBodies(report: ExportReport): number {
  if (report.redaction.choice !== "standard" || report.redaction.report === null) return 0;
  const other = report.redaction.report.places.find(
    (place) => place.place === "request-body-other" && place.status === "kept-not-examined",
  );
  return other?.count ?? 0;
}
