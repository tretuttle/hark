import { describe, expect, it } from "vite-plus/test";

import type { Site } from "../src/ids.ts";
import {
  topSiteOf,
  TOP_SITE_RULES,
  type SiteFacts,
  type SiteRule,
  type SiteRuleId,
} from "../src/site.ts";

const site = (s: string) => s as Site;
const f = (o: Partial<SiteFacts>): SiteFacts => ({
  policyType: 20,
  isAttachment: false,
  channelSite: site("127.0.0.1"),
  tabDocumentSite: site("127.0.0.1"),
  principalSite: site("127.0.0.1"),
  hasBrowsingContext: true,
  ...o,
});

// Download, navigation, worker and subresource channels as site facts, plus the fallback rows.
const CASES: readonly (readonly [string, SiteFacts, string | null, SiteRuleId])[] = [
  [
    "attachment link on a 127.0.0.1 page to localhost",
    f({ policyType: 6, isAttachment: true, channelSite: site("localhost") }),
    "127.0.0.1",
    "attachment-from-page",
  ],
  [
    "first load in a new tab (documentURI about:blank)",
    f({ policyType: 6, tabDocumentSite: null, channelSite: site("example.com") }),
    "example.com",
    "top-level-document",
  ],
  [
    "an attachment opened as the first load of a tab",
    f({
      policyType: 6,
      isAttachment: true,
      tabDocumentSite: null,
      channelSite: site("files.example"),
    }),
    "files.example",
    "top-level-document",
  ],
  [
    "navigation from one site to another",
    f({ policyType: 6, channelSite: site("example.org") }),
    "example.org",
    "top-level-document",
  ],
  [
    "service worker script load, no browsing context",
    f({ policyType: 32, hasBrowsingContext: false, tabDocumentSite: null }),
    "127.0.0.1",
    "worker",
  ],
  [
    "service worker's own fetch, no browsing context",
    f({ policyType: 11, hasBrowsingContext: false, tabDocumentSite: null }),
    "127.0.0.1",
    "worker",
  ],
  [
    "third-party subresource",
    f({ channelSite: site("cdn.example.net") }),
    "127.0.0.1",
    "subresource",
  ],
  [
    "no document and no principal site",
    f({ tabDocumentSite: null, principalSite: null, channelSite: site("api.example") }),
    "api.example",
    "unknown",
  ],
  [
    "nothing names a site",
    f({ tabDocumentSite: null, principalSite: null, channelSite: null }),
    null,
    "unknown",
  ],
];

const viaRules = (rules: readonly SiteRule[], facts: SiteFacts) => {
  const hit = rules.find((r) => r.when(facts));
  return hit === undefined ? null : { rule: hit.id, site: hit.site(facts) };
};

describe("TOP_SITE_RULES", () => {
  it.each(CASES)("%s", (_label, facts, wantSite, wantRule) => {
    expect(topSiteOf(facts)).toEqual({ rule: wantRule, site: wantSite });
  });

  it("putting top-level-document before attachment-from-page gives the download host's site", () => {
    const swapped = [TOP_SITE_RULES[1]!, TOP_SITE_RULES[0]!, ...TOP_SITE_RULES.slice(2)];
    expect(viaRules(swapped, CASES[0]![1])).toEqual({
      rule: "top-level-document",
      site: "localhost",
    });
  });

  it.each(TOP_SITE_RULES.map((r) => r.id))(
    "without rule %s some channel gets another answer",
    (id) => {
      const without = TOP_SITE_RULES.filter((r) => r.id !== id);
      expect(
        CASES.some(
          ([, facts, wantSite, wantRule]) =>
            JSON.stringify(viaRules(without, facts)) !==
            JSON.stringify({ rule: wantRule, site: wantSite }),
        ),
      ).toBe(true);
    },
  );
});
