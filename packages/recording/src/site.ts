// Which top-level site a request belongs to. The site is the unit the user exports ("This site") and excludes, so
// it is decided once, at examine (or at stop for an unanswered request), by this table.

import type { Site } from "./ids.ts";

/** Everything the rules read. The adapter fills it without throwing: a missing browsing context is null, not an error. */
export interface SiteFacts {
  /** loadInfo.externalContentPolicyType. 6 is a top-level document. */
  readonly policyType: number;
  /** The response carries Content-Disposition: attachment (channel.contentDisposition), so the tab keeps its page. */
  readonly isAttachment: boolean;
  readonly channelSite: Site | null;
  /** Site of the tab's current top document, browsingContext.top.currentWindowGlobal.documentURI; null when none. */
  readonly tabDocumentSite: Site | null;
  /** Site of loadInfo.loadingPrincipal, else triggeringPrincipal: a worker's own origin. */
  readonly principalSite: Site | null;
  /** loadInfo.browsingContext is null for service-worker and shared-worker channels. */
  readonly hasBrowsingContext: boolean;
}

export type SiteRuleId =
  | "attachment-from-page"
  | "top-level-document"
  | "worker"
  | "subresource"
  | "unknown";

export interface SiteRule {
  readonly id: SiteRuleId;
  readonly when: (f: SiteFacts) => boolean;
  readonly site: (f: SiteFacts) => Site | null;
  readonly why: string;
}

const UNKNOWN: SiteRule = {
  id: "unknown",
  when: () => true,
  site: (f) => f.principalSite ?? f.channelSite,
  why: "No document to attribute it to.",
};

/** First match wins. */
export const TOP_SITE_RULES: readonly SiteRule[] = [
  {
    id: "attachment-from-page",
    when: (f) => f.policyType === 6 && f.isAttachment && f.tabDocumentSite !== null,
    site: (f) => f.tabDocumentSite,
    why: "A download link does not navigate the tab, so the request belongs to the page that started it, for exports and for exclusion.",
  },
  {
    id: "top-level-document",
    when: (f) => f.policyType === 6,
    site: (f) => f.channelSite,
    why: "At examine time the tab still shows the previous page, or about:blank for the first load.",
  },
  {
    id: "worker",
    when: (f) => !f.hasBrowsingContext,
    site: (f) => f.principalSite,
    why: "A worker's channel has no browsing context, and reading .top on it throws. Its origin is its site.",
  },
  {
    id: "subresource",
    when: (f) => f.tabDocumentSite !== null,
    site: (f) => f.tabDocumentSite,
    why: "Everything a page loads, third-party requests included, belongs to the page's site.",
  },
  UNKNOWN,
];

export function topSiteOf(facts: SiteFacts): {
  readonly rule: SiteRuleId;
  readonly site: Site | null;
} {
  const rule = TOP_SITE_RULES.find((r) => r.when(facts)) ?? UNKNOWN;
  return { rule: rule.id, site: rule.site(facts) };
}
