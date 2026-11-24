// Holds the history page's state and makes its calls. Every call goes through `api`, the page's one way to stored data.

import type { ExportJob, ExportRequest } from "@hark/export/jobs";
import type { HistoryCursor, Page, Session, SiteSummary } from "@hark/recording/activity";
import type { Site } from "@hark/recording/ids";
import type { HarkApi } from "../../../experiment/contract.ts";
import { EMPTY_HISTORY, sessionsExport, siteExport, toggled, type HistoryState } from "./model.ts";

export interface HistoryStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly state: () => HistoryState;
  /** Reads the lists again, after a failed read. */
  readonly retry: () => void;
  readonly showSite: (site: Site) => void;
  readonly toggle: (session: Session) => void;
  readonly search: (text: string) => void;
  readonly exportTicked: () => void;
  readonly exportSession: (session: Session) => void;
  readonly exportSite: (site: Site) => void;
  /** The first step of excluding: the page asks once, in place. */
  readonly askExclude: (site: Site) => void;
  readonly cancelExclude: () => void;
  readonly confirmExclude: () => void;
  readonly reveal: () => void;
  readonly copyPath: () => void;
}

/** Every page of a list, in order. */
async function all<T>(read: (cursor: HistoryCursor | null) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let cursor: HistoryCursor | null = null;
  do {
    const page = await read(cursor);
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== null);
  return rows;
}

export function createHistoryStore(api: HarkApi, pollMs: number): HistoryStore {
  const listeners = new Set<() => void>();
  let state: HistoryState = EMPTY_HISTORY;
  const set = (change: Partial<HistoryState>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown): void => console.error(error);

  const sessionsOf = (site: Site): Promise<Session[]> =>
    all((cursor) => api.listSessions({ site, cursor }));
  const sitesNow = (): Promise<SiteSummary[]> => all((cursor) => api.listSites({ cursor }));

  const load = async (site: Site | null): Promise<void> => {
    const [settings, sites] = await Promise.all([api.getSettings(), sitesNow()]);
    const shown = sites.find((s) => s.site === site)?.site ?? sites[0]?.site ?? null;
    set({ settings, sites, site: shown, sessions: null, failed: null, readAt: Date.now() });
    if (shown !== null) set({ sessions: await sessionsOf(shown) });
  };

  const watch = async (job: ExportJob): Promise<void> => {
    set({ job, notice: null });
    let current = job;
    while (current.state.kind === "writing") {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const found = (await api.listExports()).find((j) => j.id === job.id);
      if (found === undefined) return;
      current = found;
      set({ job: current });
    }
  };

  const start = (request: ExportRequest | null): void => {
    if (request === null || state.job?.state.kind === "writing") return;
    void api.startExport(request).then(watch).catch(fail);
  };

  const read = (site: Site | null): void => {
    void load(site).catch((error: unknown) =>
      set({ failed: error instanceof Error ? error.message : String(error) }),
    );
  };
  read(null);

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => state,
    retry: () => read(state.site),
    showSite: (site) => {
      set({ site, sessions: null, confirming: null });
      void sessionsOf(site)
        .then((sessions) => {
          if (state.site === site) set({ sessions });
        })
        .catch(fail);
    },
    toggle: (session) => set({ ticked: toggled(state.ticked, session) }),
    search: (text) => set({ search: text }),
    exportTicked: () => start(sessionsExport([...state.ticked.values()], state.settings)),
    exportSession: (session) => start(sessionsExport([session], state.settings)),
    exportSite: (site) => start(siteExport(site, state.settings)),
    askExclude: (site) => set({ confirming: site }),
    cancelExclude: () => set({ confirming: null }),
    confirmExclude: () => {
      const site = state.confirming;
      if (site === null) return;
      const ticked = new Map([...state.ticked].filter(([, s]) => s.site !== site));
      set({ confirming: null, ticked });
      void api
        .excludeSite(site)
        .then(() => load(null))
        .then(() => set({ excluded: site }))
        .catch(fail);
    },
    reveal: () => {
      const job = state.job;
      if (job !== null)
        void api
          .revealExport(job.id)
          .then((shown) => {
            if (!shown) set({ notice: "gone" });
          })
          .catch(fail);
    },
    copyPath: () => {
      const job = state.job;
      if (job !== null)
        void api
          .copyExportPath(job.id)
          .then((copied) => set({ notice: copied ? "copied" : "gone" }))
          .catch(fail);
    },
  };
}
