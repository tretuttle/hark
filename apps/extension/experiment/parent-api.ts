import type { ExportId, ExportJob, Preview } from "@hark/export/jobs";
import type { ExportRequest } from "@hark/export/jobs";
import type { Selection } from "@hark/export/selection";
import type { Page, Session, SiteSummary } from "@hark/recording/activity";
import type { Site, TabId } from "@hark/recording/ids";
import type { SettingChange } from "@hark/recording/settings";
import {
  namespace,
  harkApi,
  type Environment,
  type FolderChoice,
  type HistoryQuery,
  type SessionsQuery,
  type SettingsView,
  type HarkApi,
  type PopupTabArgument,
  type PopupView,
  type RecordingProblem,
  type RecordingStatus,
  type ToolboxState,
} from "./contract.ts";
import { parseArguments } from "./gecko-schema.ts";

/** What the recorder and the store report about themselves, read when an extension page asks. */
export interface RecordingFacts {
  /** null when observers are running. */
  readonly archive: "refused" | "unwritable" | null;
  readonly strictOriginPolicy: boolean;
  readonly settingsRejected: boolean;
  readonly writeFailures: number;
  readonly liveOverflow: number;
  readonly overCapWhileExporting?: boolean;
  readonly unreadableEntries?: number;
}

/** One row per problem, in the order the status lists them. */
const PROBLEM_RULES: readonly {
  readonly problem: RecordingProblem;
  readonly when: (f: RecordingFacts) => boolean;
}[] = [
  { problem: "archive-refused", when: (f) => f.archive === "refused" },
  { problem: "archive-unwritable", when: (f) => f.archive === "unwritable" },
  { problem: "file-pages-can-read-files", when: (f) => !f.strictOriginPolicy },
  { problem: "settings-unreadable", when: (f) => f.settingsRejected },
  { problem: "write-failed", when: (f) => f.writeFailures > 0 },
  { problem: "too-many-live-requests", when: (f) => f.liveOverflow > 0 },
  { problem: "over-cap-while-exporting", when: (f) => f.overCapWhileExporting === true },
  { problem: "archive-entries-unreadable", when: (f) => (f.unreadableEntries ?? 0) > 0 },
];

export const recordingStatus = (facts: RecordingFacts): RecordingStatus => ({
  recording: facts.archive === null,
  problems: PROBLEM_RULES.filter((rule) => rule.when(facts)).map((rule) => rule.problem),
});

/**
 * What a host can do, after its input is parsed. A tab id that names no tab is a state of the result here, never a
 * throw: tab 0, a closed tab and a private tab without permission all come back as `no-such-tab`.
 */
export interface Host {
  readonly identity: () => Environment["browser"];
  readonly toolbox: (tabId: TabId) => ToolboxState;
  readonly recording: () => RecordingFacts;
  readonly popup: (tab: PopupTabArgument) => Promise<Omit<PopupView, "problems">>;
  readonly preview: (selection: Selection) => Promise<Preview>;
  readonly exports: {
    readonly start: (request: ExportRequest) => ExportJob;
    readonly list: () => readonly ExportJob[];
    readonly cancel: (id: ExportId) => boolean;
    readonly reveal: (id: ExportId) => Promise<boolean>;
    readonly copyPath: (id: ExportId) => boolean;
  };
  /** Empty pages while the recording is not running. */
  readonly history: {
    readonly sites: (query: HistoryQuery) => Page<SiteSummary>;
    readonly sessions: (query: SessionsQuery) => Page<Session>;
  };
  /** Every write rejects while the recording is not running, and when settings.json cannot be written. */
  readonly settings: {
    readonly read: () => SettingsView | null;
    readonly save: (setting: SettingChange) => Promise<SettingsView>;
    readonly exclude: (site: Site) => Promise<SettingsView>;
    readonly include: (site: Site) => Promise<SettingsView>;
    readonly chooseFolder: () => Promise<FolderChoice>;
    readonly useDownloads: () => Promise<SettingsView>;
  };
}

/**
 * The handlers, written once against `Host`. The explicit `Promise<...>` return types make a fresh result literal with
 * an extra property fail typecheck; the contract test compares the runtime keys of values held in variables.
 */
const handlers = (host: Host): HarkApi => ({
  getEnvironment: async (tabId): Promise<Environment> => {
    const identity = host.identity();
    return {
      browser: { name: identity.name, version: identity.version, buildId: identity.buildId },
      toolbox: host.toolbox(tabId),
    };
  },
  getRecordingStatus: async (): Promise<RecordingStatus> => {
    const status = recordingStatus(host.recording());
    return { recording: status.recording, problems: status.problems };
  },
  getPopup: async (tab): Promise<PopupView> => ({
    ...(await host.popup(tab)),
    problems: recordingStatus(host.recording()).problems,
  }),
  preview: (selection) => host.preview(selection),
  startExport: async (request) => host.exports.start(request),
  listExports: async () => host.exports.list(),
  cancelExport: async (id) => host.exports.cancel(id),
  revealExport: (id) => host.exports.reveal(id),
  copyExportPath: async (id) => host.exports.copyPath(id),
  listSites: async (query) => host.history.sites(query),
  listSessions: async (query) => host.history.sessions(query),
  getSettings: async () => host.settings.read(),
  setSettings: (setting) => host.settings.save(setting),
  excludeSite: (site) => host.settings.exclude(site),
  includeSite: (site) => host.settings.include(site),
  chooseExportFolder: () => host.settings.chooseFolder(),
  useDownloadsFolder: () => host.settings.useDownloads(),
});

/** The API as a page's caller reaches it: raw arguments in, each one parsed before its handler runs. */
export type RawApi = {
  readonly [Name in keyof HarkApi]: (...raw: readonly unknown[]) => ReturnType<HarkApi[Name]>;
};

/**
 * The API object a host exposes. Every argument goes through its parameter's parser first, in both hosts, because the
 * standard host's port has no Gecko schema in front of it. A refused argument rejects with `refuse`'s error.
 */
export const createHarkApi = (host: Host, refuse: (message: string) => Error): RawApi => {
  const typed = handlers(host) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const entries = Object.entries(harkApi).map(([name, fn]) => {
    const call = (...raw: readonly unknown[]): Promise<unknown> => {
      const parsed = parseArguments(fn, raw);
      if (!parsed.ok)
        return Promise.reject(refuse(`Invalid ${parsed.refused} for ${namespace}.${name}.`));
      return typed[name]!(...parsed.values);
    };
    return [name, call] as const;
  });
  return Object.fromEntries(entries) as unknown as RawApi;
};
