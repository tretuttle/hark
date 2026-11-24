// The history and settings calls of the API, in the parent. Paths stay here: a page gets site names, counts, setting
// values, and the chosen export folder's own name or the kind of folder that refused it.

import { pageSessions, pageSites } from "@hark/recording/activity";
import { toMinute, type EpochMs, type Minute } from "@hark/recording/ids";
import {
  guardFolder,
  type FolderRefusal,
  type ForbiddenRoots,
  type Platform,
} from "@hark/recording/layout";
import type { StoredSettings } from "@hark/recording/settings";
import type { RefusedFolder, SettingsView } from "./contract.ts";
import type { Host } from "./parent-api.ts";
import type { Store } from "./store.ts";

const HISTORY_PAGE_ROWS = 50;

/** A forbidden root by the word a page may hear. The profile and the archive are named; the rest is the browser's. */
export function refusedFolder(
  refusal: FolderRefusal,
  roots: ForbiddenRoots,
  archive: string,
): RefusedFolder {
  if (refusal.kind === "not-absolute") return "not-absolute";
  const within =
    refusal.forbidden === roots.profile
      ? "profile"
      : refusal.forbidden === archive
        ? "recording"
        : "browser";
  return `${refusal.kind}-${within}`;
}

/** Built field by field, so nothing the store keeps beside these values reaches a page. */
export const settingsView = (
  stored: StoredSettings,
  usage: ReturnType<Store["usage"]>,
): SettingsView => ({
  user: {
    version: stored.user.version,
    retention: {
      maxBodyBytes: stored.user.retention.maxBodyBytes,
      maxDetailBytes: stored.user.retention.maxDetailBytes,
      maxAgeDays: stored.user.retention.maxAgeDays,
    },
    excludedSites: [...stored.user.excludedSites],
    media: stored.user.media,
    secretStorage: stored.user.secretStorage,
    exportDefaults: {
      bodies: stored.user.exportDefaults.bodies,
      secrets: stored.user.exportDefaults.secrets,
    },
  },
  exportTo:
    stored.exportFolder.kind === "chosen"
      ? { kind: "chosen", label: stored.exportFolder.label }
      : { kind: "downloads" },
  usage: { bodyBytes: usage.bodyBytes, detailBytes: usage.detailBytes },
});

const localMidnight = (): Minute => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return toMinute(day.getTime() as EpochMs);
};

/** The platform's folder picker over the most recent browser window. Null when the user cancels. */
const pickFolder = (title: string): Promise<string | null> =>
  new Promise((resolve) => {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(
      Services.wm.getMostRecentWindow("navigator:browser")?.browsingContext ?? null,
      title,
      Ci.nsIFilePicker.modeGetFolder,
    );
    picker.open((result: number) =>
      resolve(result === Ci.nsIFilePicker.returnOK ? picker.file.path : null),
    );
  });

const notRunning = (): Promise<never> =>
  Promise.reject(new Error("The recording is not running, so settings cannot be saved."));

/**
 * The calls over a running recording, or null. A chosen folder is checked by its real path against the same roots the
 * export checks it against again when it writes, so a folder refused here is also refused there.
 */
export function settingsHost(
  running: () => { readonly store: Store; readonly archive: string } | null,
  folders: {
    readonly realPath: (path: string) => string;
    readonly roots: (archive: string) => ForbiddenRoots;
    readonly platform: Platform;
  },
): Pick<Host, "history" | "settings"> {
  /** A path that cannot be resolved is checked as written, as the export's own guard does. */
  const realOr = (path: string): string => {
    try {
      return folders.realPath(path);
    } catch {
      return path;
    }
  };
  const view = (store: Store): SettingsView => settingsView(store.settings(), store.usage());
  const write = async (change: (store: Store) => Promise<unknown>): Promise<SettingsView> => {
    const now = running();
    if (now === null) return notRunning();
    await change(now.store);
    return view(now.store);
  };
  return {
    history: {
      sites: ({ cursor }) => {
        const now = running();
        return now === null
          ? { rows: [], next: null }
          : pageSites(now.store.activity(), cursor, HISTORY_PAGE_ROWS, localMidnight());
      },
      sessions: ({ site, cursor }) => {
        const now = running();
        return now === null
          ? { rows: [], next: null }
          : pageSessions(now.store.activity(), site, cursor, HISTORY_PAGE_ROWS);
      },
    },
    settings: {
      read: () => {
        const now = running();
        return now === null ? null : view(now.store);
      },
      save: (setting) => write((store) => store.updateSettings({ setting })),
      exclude: (site) => write((store) => store.excludeSite(site)),
      include: (site) => write((store) => store.includeSite(site)),
      useDownloads: () =>
        write((store) => store.updateSettings({ exportFolder: { kind: "downloads" } })),
      chooseFolder: async () => {
        if (running() === null) return notRunning();
        const picked = await pickFolder("Choose the folder for exports");
        const now = running();
        if (picked === null) return { kind: "cancelled" };
        if (now === null) return notRunning();
        const roots = folders.roots(now.archive);
        const verdict = guardFolder(realOr(picked), roots, folders.platform);
        if (!verdict.ok)
          return {
            kind: "refused",
            reason: refusedFolder(verdict.refusal, roots, realOr(now.archive)),
          };
        await now.store.updateSettings({
          exportFolder: {
            kind: "chosen",
            path: verdict.folder,
            label: PathUtils.filename(verdict.folder) || verdict.folder,
          },
        });
        return { kind: "chosen", settings: view(now.store) };
      },
    },
  };
}
