import { describe, expect, it } from "vite-plus/test";

import { buildHar } from "../src/build.ts";
import { parseHar, parseHarJson } from "../src/parse.ts";
import { classifyEntryBodyState, summarizeHar } from "../src/summarize.ts";
import chromeHar from "./fixtures/chrome.json" with { type: "json" };
import firefoxHar from "./fixtures/firefox.json" with { type: "json" };
import specHar from "./fixtures/spec.json" with { type: "json" };

describe("browser and spec HAR fixtures", () => {
  it("parses a Firefox export, keeps the relative redirect, and classifies a comment-only body as unknown", () => {
    const result = parseHar(firefoxHar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const entries = result.document.log.entries;
    expect(entries).toHaveLength(5);
    expect(entries[1]!.response.redirectURL).toBe("/login?next=%2Faccount");
    expect(result.problems.some((problem) => problem.rule === "redirect-url")).toBe(true);
    expect(entries[3]!.timings).toMatchObject({ send: 0, wait: 0, receive: 0 });
    expect(result.problems.some((problem) => problem.rule === "browser-timings")).toBe(true);
    expect(classifyEntryBodyState(entries[1]!)).toEqual({ state: "empty" });
    expect(classifyEntryBodyState(entries[3]!)).toEqual({ state: "missing", reason: "aborted" });
    expect(classifyEntryBodyState(entries[4]!)).toEqual({ state: "missing", reason: "unknown" });
    expect(summarizeHar(result.document).bodies.missingByReason.unknown).toBe(1);
  });

  it("parses a Chrome export and keeps cookie sameSite through a build round trip", () => {
    const result = parseHar(chromeHar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const entries = result.document.log.entries;
    expect(entries[1]!.response.content.mimeType).toBe("x-unknown");
    expect(entries[2]!.response.redirectURL).toBe("/new");
    expect(entries[0]!.request.cookies[0]!.expires).toBeNull();
    expect(result.problems.some((problem) => problem.rule === "mime-type")).toBe(true);
    expect(result.problems.some((problem) => problem.rule === "browser-cookie-expires")).toBe(true);

    const built = buildHar({
      creator: result.document.log.creator,
      pages: result.document.log.pages,
      entries,
    });
    const again = parseHarJson(JSON.stringify(built));
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    const serialized = JSON.parse(JSON.stringify(again.document)) as {
      log: { entries: Array<{ request: { cookies: Array<{ sameSite?: string }> } }> };
    };
    expect(serialized.log.entries[0]!.request.cookies[0]!.sameSite).toBe("Lax");
  });

  it("parses the HAR 1.2 spec sample and keeps fields the spec names", () => {
    const result = parseHar(specHar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const entry = result.document.log.entries[0]!;
    expect(result.document.log.entries).toHaveLength(2);
    expect(entry.request.postData?.params[0]?.fileName).toBe("a.txt");
    expect(entry.cache.beforeRequest?.lastAccess).toBe("2009-16-02T15:50:34");
  });
});
