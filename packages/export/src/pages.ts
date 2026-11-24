// log.pages and entry.pageref, built while entries stream.

import { isoDateTimeFromEpochMs, toPageId, type HarPage, type PageId } from "@hark/har/model";
import type { EpochMs, TabKey } from "@hark/recording/ids";

export interface PageState {
  readonly __pages: unique symbol;
}

interface InternalPageState {
  readonly pages: readonly HarPage[];
  readonly currentByTab: ReadonlyMap<string, PageId>;
}

const asInternal = (state: PageState): InternalPageState => state as unknown as InternalPageState;
const asPublic = (state: InternalPageState): PageState => state as unknown as PageState;

function tabKeyString(tab: TabKey | null): string {
  return tab === null ? "" : `${tab.run}:${tab.browserId}`;
}

export function startPages(): PageState {
  return asPublic({ pages: [], currentByTab: new Map() });
}

/**
 * `url` is the entry's request URL and becomes the page title. Titles are redacted with the rest of the log by
 * @hark/har at the end of the export, under the same level as the entries.
 */
export function pageFor(
  state: PageState,
  entry: {
    readonly tab: TabKey | null;
    readonly startedAt: EpochMs;
    readonly navigation: boolean;
    readonly url: string;
  },
): { readonly pageref: PageId; readonly state: PageState } {
  const s = asInternal(state);
  const key = tabKeyString(entry.tab);
  const current = s.currentByTab.get(key);
  if (!entry.navigation && current !== undefined) {
    return { pageref: current, state };
  }
  const pageref = toPageId(`page_${String(s.pages.length)}`)!;
  const page: HarPage = {
    startedDateTime: isoDateTimeFromEpochMs(entry.startedAt),
    id: pageref,
    title: entry.url,
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  };
  const nextByTab = new Map(s.currentByTab);
  nextByTab.set(key, pageref);
  return {
    pageref,
    state: asPublic({ pages: [...s.pages, page], currentByTab: nextByTab }),
  };
}

/** onContentLoad and onLoad are -1: the recording does not see them, and DevTools' page timings are not merged. */
export function finishPages(state: PageState): readonly HarPage[] {
  return asInternal(state).pages;
}
