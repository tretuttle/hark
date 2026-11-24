// Holds the popup's view and runs the commands the reducer returns. The only code here that talks to the browser goes
// through the ports, so the reducer stays pure and the store is the one place a command becomes a call.

import type { ExportJob } from "@hark/export/jobs";
import type { TabId } from "@hark/recording/ids";
import type { HarkApi } from "../../experiment/contract.ts";
import {
  firstStep,
  reducePopup,
  type PopupCommand,
  type PopupEvent,
  type PopupView,
  type SettingsSection,
  type Step,
} from "./view.ts";

export interface PopupPorts {
  readonly api: HarkApi | null;
  readonly tab: () => Promise<TabId | null>;
  readonly settings: (section: SettingsSection) => Promise<void>;
  readonly history: () => Promise<void>;
  /** How often a running export's progress is read. */
  readonly pollMs: number;
}

export interface PopupStore {
  readonly subscribe: (listener: () => void) => () => void;
  /** null until the first reading arrives. */
  readonly view: () => PopupView | null;
  readonly dispatch: (event: PopupEvent) => void;
}

export function createPopupStore(ports: PopupPorts): PopupStore {
  const listeners = new Set<() => void>();
  let view: PopupView | null = null;
  /** Read once: the popup acts on the tab it opened for, even after a reload. */
  const tab = ports.tab();

  const apply = (step: Step): void => {
    view = step.view;
    for (const listener of listeners) listener();
    if (step.command !== null)
      void run(step.command).catch((error: unknown) => console.error(error));
  };

  const dispatch = (event: PopupEvent): void => {
    if (view !== null) apply(reducePopup(view, event));
  };

  const load = async (api: HarkApi): Promise<void> => {
    const reading = await api.getPopup({ tabId: await tab });
    if (view === null) apply(firstStep(reading));
    else dispatch({ kind: "loaded", reading });
  };

  const watch = async (api: HarkApi, id: ExportJob["id"]): Promise<void> => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, ports.pollMs));
      if (view?.kind !== "exporting" || view.job.id !== id) return;
      const job = (await api.listExports()).find((j) => j.id === id);
      if (job === undefined) return dispatch({ kind: "reload" });
      dispatch({ kind: "job", job });
      if (job.state.kind !== "writing") return;
    }
  };

  const run = async (command: PopupCommand): Promise<void> => {
    const api = ports.api;
    if (api === null) return;
    switch (command.kind) {
      case "load":
        return load(api);
      case "start":
        return dispatch({ kind: "job", job: await api.startExport(command.request) });
      case "watch":
        return watch(api, command.id);
      case "cancel":
        await api.cancelExport(command.id);
        return;
      case "preview": {
        const preview = await api.preview(command.selection);
        return dispatch({ kind: "previewed", selection: command.selection, preview });
      }
      case "reveal":
        if (!(await api.revealExport(command.id))) dispatch({ kind: "notice", notice: "gone" });
        return;
      case "copy-path":
        return dispatch({
          kind: "notice",
          notice: (await api.copyExportPath(command.id)) ? "copied" : "gone",
        });
      case "settings":
        return ports.settings(command.section);
      case "history":
        return ports.history();
    }
  };

  if (ports.api === null) view = { kind: "api-missing" };
  else void load(ports.api).catch((error: unknown) => console.error(error));

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    view: () => view,
    dispatch,
  };
}
