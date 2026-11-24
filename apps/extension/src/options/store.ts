// Holds the options page's state and makes its calls. Every call goes through `api`, the page's one way to settings.

import { parseSite, type Site } from "@hark/recording/ids";
import type { SettingChange } from "@hark/recording/settings";
import type { HarkApi, SettingsView } from "../../experiment/contract.ts";
import { EMPTY_OPTIONS, type OptionsState } from "./model.ts";

export interface OptionsStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly state: () => OptionsState;
  /** Reads status and settings again, after a failed read. */
  readonly read: () => void;
  /** Sends one setting; the parent applies it to what it holds, so quick changes never undo each other. */
  readonly save: (change: SettingChange) => void;
  readonly chooseFolder: () => void;
  readonly useDownloads: () => void;
  readonly include: (site: Site) => void;
  readonly typeSite: (text: string) => void;
  /** The first step of excluding: the page asks once, in place. */
  readonly askExclude: () => void;
  readonly cancelExclude: () => void;
  readonly confirmExclude: () => void;
}

export function createOptionsStore(api: HarkApi): OptionsStore {
  const listeners = new Set<() => void>();
  let state: OptionsState = EMPTY_OPTIONS;
  const set = (change: Partial<OptionsState>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };

  /** Shows what the parent saved, or that the save failed; the page never shows a value the parent did not keep. */
  const write = (call: Promise<SettingsView>, after: Partial<OptionsState> = {}): void => {
    void call.then(
      (settings) => set({ settings, saved: "saved", ...after }),
      (error: unknown) => {
        console.error(error);
        set({ saved: "failed" });
      },
    );
  };

  const read = (): void => {
    set({ reading: { kind: "loading" } });
    void Promise.all([api.getRecordingStatus(), api.getSettings()]).then(
      ([status, settings]) => set({ status, settings, reading: { kind: "read" } }),
      (error: unknown) =>
        set({
          reading: {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
  };
  read();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => state,
    read,
    save: (change) => {
      write(api.setSettings(change));
    },
    chooseFolder: () => {
      set({ refused: null });
      void api.chooseExportFolder().then(
        (choice) => {
          if (choice.kind === "chosen")
            set({ settings: choice.settings, refused: null, saved: "saved" });
          if (choice.kind === "refused") set({ refused: choice.reason });
        },
        (error: unknown) => {
          console.error(error);
          set({ saved: "failed" });
        },
      );
    },
    useDownloads: () => write(api.useDownloadsFolder(), { refused: null }),
    include: (site) => write(api.includeSite(site)),
    typeSite: (text) => set({ draft: text, draftInvalid: false, confirming: null }),
    askExclude: () => {
      const site = parseSite(state.draft.trim());
      set(site === null ? { draftInvalid: true } : { confirming: site });
    },
    cancelExclude: () => set({ confirming: null }),
    confirmExclude: () => {
      const site = state.confirming;
      if (site === null) return;
      set({ confirming: null });
      write(api.excludeSite(site), { draft: "" });
    },
  };
}
