import type { EpochMs, RunId, TabKey } from "@hark/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import { finishPages, pageFor, startPages } from "../src/pages.ts";
import { T0 } from "./fixtures.ts";
import { importAltered } from "./alter.ts";

const TAB_A: TabKey = { run: "mhz02" as RunId, browserId: 1 };
const TAB_B: TabKey = { run: "mhz02" as RunId, browserId: 2 };

describe("pages", () => {
  it("assigns synthetic pages before navigation, starts new pages on navigation, and resolves every pageref", () => {
    let state = startPages();
    const refs: string[] = [];

    // Subresource before any navigation in TAB_A creates a synthetic page.
    let step = pageFor(state, {
      tab: TAB_A,
      startedAt: T0,
      navigation: false,
      url: "https://app.example/style.css",
    });
    state = step.state;
    refs.push(step.pageref);

    // Second subresource in TAB_A reuses the synthetic page.
    step = pageFor(state, {
      tab: TAB_A,
      startedAt: (T0 + 10) as EpochMs,
      navigation: false,
      url: "https://app.example/app.js",
    });
    state = step.state;
    refs.push(step.pageref);
    expect(refs[1]).toBe(refs[0]);

    // Navigation in TAB_B gets its own page.
    step = pageFor(state, {
      tab: TAB_B,
      startedAt: (T0 + 20) as EpochMs,
      navigation: true,
      url: "https://other.example/",
    });
    state = step.state;
    refs.push(step.pageref);
    expect(refs[2]).not.toBe(refs[0]);

    // Navigation in TAB_A starts a second page for TAB_A.
    step = pageFor(state, {
      tab: TAB_A,
      startedAt: (T0 + 30) as EpochMs,
      navigation: true,
      url: "https://app.example/next",
    });
    state = step.state;
    refs.push(step.pageref);
    expect(refs[3]).not.toBe(refs[0]);

    // Subsequent subresource in TAB_A uses the new page.
    step = pageFor(state, {
      tab: TAB_A,
      startedAt: (T0 + 40) as EpochMs,
      navigation: false,
      url: "https://app.example/next.js",
    });
    state = step.state;
    refs.push(step.pageref);
    expect(refs[4]).toBe(refs[3]);

    const pages = finishPages(state);
    expect(pages).toHaveLength(3);
    const ids = new Set(pages.map((p) => p.id));
    expect(ids.size).toBe(pages.length);
    for (const ref of refs) {
      expect(ids.has(ref as never)).toBe(true);
    }
    for (const page of pages) {
      expect(page.pageTimings).toEqual({ onContentLoad: -1, onLoad: -1 });
    }
  });

  it("with the navigation flag ignored, two navigations in one tab share a page", async () => {
    const altered = await importAltered<{
      startPages: typeof startPages;
      pageFor: typeof pageFor;
      finishPages: typeof finishPages;
    }>("pages.ts", {
      id: "reuse-page-on-navigation",
      from: "if (!entry.navigation && current !== undefined)",
      to: "if (current !== undefined)",
    });
    let state = altered.startPages();
    const s1 = altered.pageFor(state, {
      tab: TAB_A,
      startedAt: T0,
      navigation: true,
      url: "https://a.example/1",
    });
    state = s1.state;
    const s2 = altered.pageFor(state, {
      tab: TAB_A,
      startedAt: (T0 + 10) as EpochMs,
      navigation: true,
      url: "https://a.example/2",
    });
    expect(s2.pageref).toBe(s1.pageref);
  });
});
