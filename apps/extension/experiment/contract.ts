import {
  parseExportId,
  parseExportRequest,
  type ExportId,
  type ExportJob,
  type PopupState,
  type Preview,
} from "@hark/export/jobs";
import { parseSelection } from "@hark/export/selection";
import {
  parseHistoryCursor,
  type HistoryCursor,
  type Page,
  type Session,
  type SiteSummary,
} from "@hark/recording/activity";
import { parseSite, parseTabId, type ByteCount, type Site, type TabId } from "@hark/recording/ids";
import { parseSettingChange, type UserSettings } from "@hark/recording/settings";
import { any, asyncFunction, integer, returns, type ApiFunctions } from "./gecko-schema.ts";

/** The experiment namespace: `browser.hark` in extension pages, `experiment_apis.hark` in the manifest. */
export const namespace = "hark";

/** Where build-experiment.ts writes file-worker.ts in the package, and the path the parent script starts it from. */
export const FILE_WORKER = "experiment/file-worker.js";

export type ToolboxState =
  | { readonly open: true; readonly host: string }
  | { readonly open: false; readonly reason: ToolboxClosedReason };

/** Why no toolbox was found. `devtools-not-started` means DevTools was never opened since the browser started. */
export type ToolboxClosedReason = "no-such-tab" | "devtools-not-started" | "no-toolbox-for-tab";

export interface Environment {
  readonly browser: {
    readonly name: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly toolbox: ToolboxState;
}

/**
 * Why the background recording is off or at risk. No path, site or byte crosses to an extension page; the page turns
 * each kind into plain words.
 */
export type RecordingProblem =
  /** security.fileuri.strict_origin_policy is false, so a local file:// page can read the archive. */
  | "file-pages-can-read-files"
  /** The archive folder is inside the profile, the browser's own folders, or a resource:// or moz-src:// target. */
  | "archive-refused"
  | "archive-unwritable"
  /** settings.json did not parse; it was set aside and the defaults are in use. */
  | "settings-unreadable"
  | "write-failed"
  /** More requests were in flight at once than the recorder tracks; the extra ones were not recorded. */
  | "too-many-live-requests"
  /** A pinned export is holding the archive over its retention cap. */
  | "over-cap-while-exporting"
  /** Unreadable files or folders in the archive were skipped during startup scan. */
  | "archive-entries-unreadable";

export interface RecordingStatus {
  readonly recording: boolean;
  readonly problems: readonly RecordingProblem[];
}

/** The popup's tab. null when the active tab has no id (Zen's empty tab reports -1). */
export interface PopupTabArgument {
  readonly tabId: TabId | null;
}

/** Everything the popup's first paint needs. The recording problems are this API's own list. */
export type PopupView = Omit<PopupState, "problems"> & {
  readonly problems: readonly RecordingProblem[];
};

/** Where exports are written, as a page sees it: the chosen folder's own name, never its path. */
export type ExportTo =
  | { readonly kind: "downloads" }
  | { readonly kind: "chosen"; readonly label: string };

/** What the options page reads. The site list is the user's own exclusions; no site's data comes with it. */
export interface SettingsView {
  readonly user: UserSettings;
  readonly exportTo: ExportTo;
  readonly usage: { readonly bodyBytes: ByteCount; readonly detailBytes: ByteCount };
}

/** Why a chosen export folder was refused, by the kind of folder it is in or holds. Never the folder's path. */
export type RefusedFolder =
  | "inside-profile"
  | "contains-profile"
  | "inside-browser"
  | "contains-browser"
  | "inside-recording"
  | "contains-recording"
  | "not-absolute";

export type FolderChoice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "chosen"; readonly settings: SettingsView }
  | { readonly kind: "refused"; readonly reason: RefusedFolder };

/** A page of the history list. The cursor is the `next` of the page before, or null for the first page. */
export interface HistoryQuery {
  readonly cursor: HistoryCursor | null;
}
export interface SessionsQuery extends HistoryQuery {
  readonly site: Site;
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

const parsePopupTab = (raw: unknown): PopupTabArgument | null => {
  if (!isRecord(raw) || !Object.hasOwn(raw, "tabId")) return null;
  if (raw["tabId"] === null) return { tabId: null };
  const tabId = parseTabId(raw["tabId"]);
  return tabId === null ? null : { tabId };
};

const parseHistoryQuery = (raw: unknown): HistoryQuery | null => {
  if (!isRecord(raw) || !Object.hasOwn(raw, "cursor")) return null;
  if (raw["cursor"] === null) return { cursor: null };
  const cursor = parseHistoryCursor(raw["cursor"]);
  return cursor === null ? null : { cursor };
};

const parseSessionsQuery = (raw: unknown): SessionsQuery | null => {
  const query = parseHistoryQuery(raw);
  const site = isRecord(raw) ? parseSite(raw["site"]) : null;
  return query === null || site === null ? null : { ...query, site };
};

/**
 * The one table of this API. Gecko's schema.json is written from it, pages get their client type from it, and every
 * host runs each parameter's parser before a handler sees the value. No row carries a file path, a body byte or HAR
 * text in either direction; `contract.test.ts` checks that over every row's types.
 */
export const harkApi = {
  getEnvironment: asyncFunction(
    [integer("tabId", parseTabId, { minimum: 0 })],
    returns<Environment>(),
  ),
  getRecordingStatus: asyncFunction([], returns<RecordingStatus>()),
  getPopup: asyncFunction([any("tab", parsePopupTab)], returns<PopupView>()),
  preview: asyncFunction([any("selection", parseSelection)], returns<Preview>()),
  startExport: asyncFunction([any("request", parseExportRequest)], returns<ExportJob>()),
  listExports: asyncFunction([], returns<readonly ExportJob[]>()),
  /** Stops a running export within one body chunk and deletes its .har.part. Idempotent. */
  cancelExport: asyncFunction([any("id", parseExportId)], returns<boolean>()),
  /** Shows a finished file in its folder. The path never leaves the host. False when the file is gone. */
  revealExport: asyncFunction([any("id", parseExportId)], returns<boolean>()),
  /** Puts a finished file's path on the clipboard from the host, so the page never holds it. */
  copyExportPath: asyncFunction([any("id", parseExportId)], returns<boolean>()),
  /** Sites with recorded activity, most recent first, a page at a time. */
  listSites: asyncFunction([any("query", parseHistoryQuery)], returns<Page<SiteSummary>>()),
  /** One site's sessions, most recent first, a page at a time. */
  listSessions: asyncFunction([any("query", parseSessionsQuery)], returns<Page<Session>>()),
  /** null while the recording is not running: settings live beside the archive. */
  getSettings: asyncFunction([], returns<SettingsView | null>()),
  /**
   * Changes one setting; the parent applies it to the settings it holds, so two quick changes never undo each other.
   * The excluded sites and the export folder have their own rows.
   */
  setSettings: asyncFunction([any("change", parseSettingChange)], returns<SettingsView>()),
  /** Stops recording the site and deletes everything recorded for it. Idempotent. */
  excludeSite: asyncFunction([any("site", parseSite)], returns<SettingsView>()),
  includeSite: asyncFunction([any("site", parseSite)], returns<SettingsView>()),
  /** Opens the folder picker in the parent. The path stays there; the page gets the folder's name or the refusal. */
  chooseExportFolder: asyncFunction([], returns<FolderChoice>()),
  useDownloadsFolder: asyncFunction([], returns<SettingsView>()),
};

export type HarkApi = ApiFunctions<typeof harkApi>;
export type { ExportId };

/**
 * The result's key sets at run time. Types are erased, so the contract test compares the handler's actual keys
 * with this table; a value held in a variable is not checked for excess properties by the type checker.
 */
export const environmentKeys = {
  result: ["browser", "toolbox"],
  browser: ["name", "version", "buildId"],
  toolboxOpen: ["host", "open"],
  toolboxClosed: ["open", "reason"],
  recordingStatus: ["problems", "recording"],
} as const satisfies {
  result: ReadonlyArray<keyof Environment>;
  browser: ReadonlyArray<keyof Environment["browser"]>;
  toolboxOpen: ReadonlyArray<keyof Extract<ToolboxState, { open: true }>>;
  toolboxClosed: ReadonlyArray<keyof Extract<ToolboxState, { open: false }>>;
  recordingStatus: ReadonlyArray<keyof RecordingStatus>;
};
