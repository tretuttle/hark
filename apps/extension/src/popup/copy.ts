// Every sentence the popup shows that is not a count, keyed by the domain value it describes. Body-loss wording comes
// from @hark/export/missing, so the popup and the file's comments say the same thing.

import type { DevtoolsState, WriteFailure } from "@hark/export/jobs";
import type { PresetId } from "@hark/export/selection";
import type { RecordingProblem } from "../../experiment/contract.ts";
import { bytes } from "./format.ts";
import type { PopupReading, RangeId, Scope, SettingsSection } from "./view.ts";

export const PRESET_COPY: {
  readonly [P in PresetId]: {
    readonly title: string;
    readonly subtitle: (site: string | null) => string;
    readonly icon: "tab" | "clock" | "globe" | "layers";
  };
} = {
  "this-tab-everything": {
    title: "This tab",
    subtitle: () => "Everything since it opened",
    icon: "tab",
  },
  "this-tab-recent": {
    title: "This tab, recent",
    subtitle: () => "Last 15 minutes",
    icon: "clock",
  },
  "this-site": {
    title: "This site",
    subtitle: (site) => (site === null ? "This tab has no site" : `${site}, every tab`),
    icon: "globe",
  },
  everything: {
    title: "Everything recorded",
    subtitle: () => "All sites and tabs",
    icon: "layers",
  },
};

type Gate = PopupReading["gate"];

/** The one quiet line under the rows that says where the numbers come from. First match wins. */
const SOURCE_LINES: readonly {
  readonly devtools: DevtoolsState | "any";
  readonly gate: Gate | "any";
  readonly icon: "code" | "database" | "lock";
  readonly text: (site: string | null) => string;
}[] = [
  {
    devtools: "open",
    gate: "private-window",
    icon: "code",
    text: () =>
      "Private windows are not recorded in the background. This export uses what DevTools captured.",
  },
  {
    devtools: "open",
    gate: "excluded-site",
    icon: "code",
    text: (site) =>
      `${site ?? "This site"} is excluded from recording. This export uses what DevTools captured.`,
  },
  {
    devtools: "any",
    gate: "excluded-site",
    icon: "lock",
    text: (site) =>
      `${site ?? "This site"} is excluded from recording, so this tab has nothing recorded.`,
  },
  {
    devtools: "open",
    gate: null,
    icon: "code",
    text: () =>
      "Includes what the open DevTools panel captured. Bodies DevTools dropped are filled in from the background recording.",
  },
  {
    devtools: "any",
    gate: "any",
    icon: "database",
    text: () => "From the background recording. DevTools is closed.",
  },
];

export const sourceLine = (reading: PopupReading) =>
  SOURCE_LINES.find(
    (line) =>
      (line.devtools === "any" || line.devtools === reading.devtools) &&
      (line.gate === "any" || line.gate === reading.gate),
  )!;

export const COPY = {
  heading: "Export a HAR",
  headingHelp: "Click a row to save it now.",
  rowsLabel: "Ready-made exports",
  appliesTo: "Applies to the rows above",
  bodies: "Include response bodies",
  secrets: "Remove secrets",
  secretsKept: "The file may contain login tokens. Do not share it.",
  custom: "Choose range, scope and file name",
  settings: "Open settings",
  history: "Open history",
  back: "Back",
  noTabTitle: "This tab has no page yet",
  noTabText: "Open a page in this tab to export it. The export of everything recorded still works.",
  emptyTabTitle: "Nothing recorded for this tab yet",
  emptyTabText:
    "Requests appear here as soon as a page in this tab loads. To capture a page from its first request, open it after this tab exists.",
  emptyPrivateTitle: "Private windows are not recorded",
  emptyPrivateText:
    "Nothing from this window is stored. To get a HAR from it, open DevTools on this tab before you load the page. The export then uses what DevTools captured.",
  otherTabs: "Recorded in other tabs",
  normalWindows: "Recorded in normal windows",
  exportEverything: "Export everything",
  storeTitle: "The background recording is off",
  storeDevtools: "DevTools is open on this tab. You can still export what it captured.",
  storeNoDevtools: "Open DevTools on a tab before you load the page to capture it there.",
  exportDevtools: "Export from DevTools",
  checkAgain: "Check again",
  customTitle: "Custom export",
  scope: "Requests from",
  range: "Time",
  from: "From",
  to: "To",
  onlyApi: "Only fetch and XHR requests",
  onlyApiHelp: "Leaves out pages, images, fonts, styles, scripts and media.",
  fileName: "File name",
  fileNamePlaceholder: "Built from the site, date and range",
  badRange: "The start must be before the end.",
  badFileName: "A file name cannot contain / \\ or :.",
  counting: "Counting",
  exportButton: "Export HAR",
  exportingTitle: "Saving",
  collecting: "Collecting requests",
  keepsRunning:
    "You can close this popup. The export keeps running, and this popup shows the result when you open it again.",
  cancel: "Cancel export",
  saved: "Saved",
  savedIn: "In",
  showInFolder: "Show in folder",
  copyPath: "Copy path",
  copied: "Path copied.",
  gone: "The file is no longer in the folder.",
  nothingMissing: "Nothing is missing from this file.",
  whyInFile: "Each entry without its body says why in its comment field.",
  missingLabel: "Bodies not in the file",
  exportAnother: "Export something else",
  lastExport: "Last export",
  showResult: "Show result",
  writeTitle: "The file could not be saved",
  writeUnconfirmedTitle: "The file could not be confirmed",
  writeUnconfirmed:
    "The file was written, but its name could not be confirmed afterwards, so this export names no file. Check the export folder.",
  recordingSafe: "Your recording is unchanged.",
  tryAgain: "Try again",
  tryWithoutBodies: "Try without response bodies",
  apiMissingTitle: "The browser API is not available",
  apiMissing:
    "Hark needs its browser API. Set extensions.experiments.enabled to true in about:config, then restart the browser.",
  apiMissingNote:
    "Zen, Firefox Nightly, Firefox Developer Edition and unbranded Firefox builds allow this. Firefox Release does not.",
} as const;

export const SCOPE_COPY: { readonly [S in Scope]: string } = {
  tab: "This tab",
  site: "This site",
  everything: "All sites",
};

export const RANGE_COPY: { readonly [R in RangeId]: string } = {
  "since-tab-opened": "Since the tab opened",
  "last-5": "Last 5 minutes",
  "last-15": "Last 15 minutes",
  "last-60": "Last hour",
  today: "Today",
  everything: "Everything recorded",
  between: "Between two times",
};

export const SETTINGS_LINKS: { readonly [S in SettingsSection]: string } = {
  storage: "Change storage settings",
  "export-holding": "What to do while an export finishes",
  "unreadable-files": "What to do about skipped files",
  media: "Change audio and video setting",
  secrets: "Change how secrets are stored",
  folder: "Change export folder",
  sites: "Change excluded sites",
};

export const PROBLEM_COPY: {
  readonly [P in RecordingProblem]: {
    readonly text: string;
    readonly settings: SettingsSection | null;
  };
} = {
  "archive-refused": {
    text: "Its folder is inside the browser profile or the browser's own folders, where Hark does not write.",
    settings: "storage",
  },
  "archive-unwritable": {
    text: "Its folder cannot be written. Check that the disk is connected and has space.",
    settings: "storage",
  },
  "file-pages-can-read-files": {
    text: "Local files opened in the browser can read recorded data, because security.fileuri.strict_origin_policy is off in about:config.",
    settings: null,
  },
  "settings-unreadable": {
    text: "Settings could not be read, so the defaults are in use.",
    settings: "storage",
  },
  "write-failed": { text: "Some requests could not be saved to disk.", settings: "storage" },
  "too-many-live-requests": {
    text: "Some requests were not recorded because too many ran at once.",
    settings: null,
  },
  "over-cap-while-exporting": {
    text: "The recording is temporarily over its size limit while an export is finishing.",
    settings: "export-holding",
  },
  "archive-entries-unreadable": {
    text: "Some files in the recording could not be read on startup, so they were skipped.",
    settings: "unreadable-files",
  },
};

export const WRITE_FAILURE_COPY: {
  readonly [K in WriteFailure["kind"]]: {
    readonly text: (failure: Extract<WriteFailure, { readonly kind: K }>) => string;
    readonly settings: SettingsSection | null;
  };
} = {
  "disk-full": {
    text: (f) =>
      `The disk is full. This export needs about ${bytes(f.needBytes)} and the disk has ${bytes(f.freeBytes)} free.`,
    settings: "folder",
  },
  "access-denied": {
    text: () => "Hark is not allowed to write to the export folder.",
    settings: "folder",
  },
  "read-only": {
    text: () => "The export folder is on a disk that cannot be written to.",
    settings: "folder",
  },
  "not-a-folder": {
    text: () => "The export folder setting names a file, not a folder.",
    settings: "folder",
  },
  "folder-missing": { text: () => "The export folder does not exist.", settings: "folder" },
  "folder-refused": {
    text: () =>
      "The export folder is a link, or lies inside the browser's own folders or the recording. Hark does not write there.",
    settings: "folder",
  },
  "file-replaced": {
    text: () =>
      "Another file took this name while the export was saving it, so that file was left alone.",
    settings: null,
  },
  "name-too-long": { text: () => "The file name is too long for this disk.", settings: null },
  "name-taken": {
    text: () => "A file with this name already exists in the export folder.",
    settings: null,
  },
  "copy-mismatch": {
    text: () =>
      "The copy written to the folder did not match the export byte for byte, so it was not kept.",
    settings: null,
  },
  "io-error": {
    text: () => "The disk reported an error while the file was being written.",
    settings: null,
  },
  "timed-out": { text: () => "The disk did not answer in time.", settings: null },
  "no-atomic-rename": {
    text: () =>
      "This folder cannot finish exports safely without replacing existing files, so the export was stopped.",
    settings: "folder",
  },
  other: { text: () => "The browser reported an error it did not name.", settings: null },
};

export const writeFailureText = (failure: WriteFailure): string =>
  (WRITE_FAILURE_COPY[failure.kind].text as (f: WriteFailure) => string)(failure);

export const sizeUpTo = (n: number): string => `up to ${bytes(n)}`;

export const unexaminedRequestBodiesNote = (n: number, formatted: string): string =>
  n === 1
    ? `${formatted} request body is not JSON, form, or multipart, so it was not examined for secrets.`
    : `${formatted} request bodies are not JSON, form, or multipart, so they were not examined for secrets.`;
