import { describe, expect, it } from "vite-plus/test";

import { buildHar, buildHarEntry, type BuildHarEntryInput } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType, toPageId } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";

describe("buildHar", () => {
  it("sorts entries arriving sorted by size and assigns every entry to a valid page", () => {
    const largestLater: BuildHarEntryInput = {
      startedDateTime: toIsoDateTime("2026-11-16T05:00:05.000Z")!,
      request: {
        method: "GET",
        url: toHarUrl("https://app.example/assets/model.glb?lod=high")!,
      },
      response: {
        status: 200,
        statusText: "OK",
        content: {
          size: 13_600_000,
          mimeType: toMimeType("model/gltf-binary")!,
        },
        bodySize: 13_600_000,
      },
    };

    const mediumMiddle: BuildHarEntryInput = {
      startedDateTime: toIsoDateTime("2026-11-16T05:00:02.000Z")!,
      request: {
        method: "GET",
        url: toHarUrl("https://app.example/app.js")!,
      },
      response: {
        status: 200,
        statusText: "OK",
        content: {
          size: 42_000,
          mimeType: toMimeType("application/javascript")!,
          text: "console.log('app');",
        },
      },
    };

    const smallestEarliest: BuildHarEntryInput = {
      startedDateTime: toIsoDateTime("2026-11-16T05:00:00.100Z")!,
      request: {
        method: "GET",
        url: toHarUrl("https://app.example/")!,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        content: {
          text: "<!doctype html>",
        },
      },
    };

    const built = buildHar({
      creator: { name: "Caller", version: "1.0.0" },
      entries: [largestLater, mediumMiddle, smallestEarliest],
    });

    expect(built.log.pages).toHaveLength(1);
    const page = built.log.pages![0]!;
    expect(page.startedDateTime).toBe("2026-11-16T05:00:00.100Z");
    expect(page.title).toBe("https://app.example/");

    expect(built.log.entries.map((entry) => entry.startedDateTime)).toEqual([
      "2026-11-16T05:00:00.100Z",
      "2026-11-16T05:00:02.000Z",
      "2026-11-16T05:00:05.000Z",
    ]);
    for (const entry of built.log.entries) {
      expect(entry.pageref).toBe(page.id);
    }

    expect(built.log.entries[0]!.response.content.mimeType).toBe("text/html; charset=utf-8");
    expect(built.log.entries[0]!.response.content.size).toBe(15);
    expect(built.log.entries[2]!.request.queryString).toEqual([{ name: "lod", value: "high" }]);
    expect(built.log.entries[2]!.timings).toEqual({ send: 0, wait: 0, receive: 0 });
    expect(built.log.entries[2]!.time).toBe(0);

    const reparsed = parseHar(built);
    expect(reparsed.ok).toBe(true);
  });

  it("synthesizes an initial page when entries precede the earliest declared page", () => {
    const built = buildHar({
      creator: { name: "Caller", version: "1" },
      pages: [
        {
          id: toPageId("page_nav")!,
          title: "https://app.example/dashboard",
          startedDateTime: toIsoDateTime("2026-11-16T05:00:10.000Z")!,
        },
      ],
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:12.000Z")!,
          request: { method: "GET", url: toHarUrl("https://app.example/api/user")! },
          response: { status: 304 },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:01.000Z")!,
          request: { method: "GET", url: toHarUrl("https://app.example/login")! },
          response: {
            status: 302,
            headers: [{ name: "Location", value: "https://app.example/dashboard" }],
          },
        },
      ],
    });

    expect(built.log.pages).toHaveLength(2);
    const earlyPage = built.log.pages![0]!;
    const navPage = built.log.pages![1]!;
    expect(earlyPage.startedDateTime).toBe("2026-11-16T05:00:01.000Z");
    expect(navPage.id).toBe("page_nav");

    expect(built.log.entries[0]!.pageref).toBe(earlyPage.id);
    expect(built.log.entries[0]!.response.redirectURL).toBe("https://app.example/dashboard");
    expect(built.log.entries[1]!.pageref).toBe("page_nav");
    expect(built.log.entries[1]!.response.bodySize).toBe(0);
    expect(parseHar(built).ok).toBe(true);
  });

  it("is stable across parse -> build -> parse round trips", () => {
    const rawHar = {
      log: {
        version: "1.2",
        creator: { name: "Zen", version: "160.0" },
        browser: { name: "Zen", version: "160.0" },
        pages: [
          {
            startedDateTime: "2026-11-16T00:00:00.000-05:00",
            id: "page_0",
            title: "https://example.org/",
            pageTimings: { onContentLoad: 150, onLoad: 300 },
          },
        ],
        entries: [
          {
            pageref: "page_0",
            startedDateTime: "2026-11-16T00:00:01.000-05:00",
            time: 40,
            request: {
              method: "POST",
              url: "https://example.org/submit?mode=fast",
              httpVersion: "HTTP/2.0",
              cookies: [],
              headers: [{ name: "Content-Type", value: "application/json" }],
              queryString: [{ name: "mode", value: "fast" }],
              postData: {
                mimeType: "application/json",
                params: [],
                text: '{"ok":true}',
              },
              headersSize: 110,
              bodySize: 11,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/2.0",
              cookies: [],
              headers: [{ name: "Content-Type", value: "application/json" }],
              content: {
                size: 11,
                mimeType: "application/json",
                text: '{"ok":true}',
              },
              redirectURL: "",
              headersSize: 80,
              bodySize: 11,
            },
            cache: {},
            timings: { blocked: 1, dns: 2, connect: 5, ssl: 3, send: 2, wait: 25, receive: 5 },
            _securityState: "secure",
          },
        ],
      },
    };

    const parsed1 = parseHar(rawHar);
    expect(parsed1.ok).toBe(true);
    if (!parsed1.ok) {
      return;
    }

    const built1 = buildHar(parsed1.document.log);
    const parsed2 = parseHar(built1);
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) {
      return;
    }

    const built2 = buildHar(parsed2.document.log);
    const parsed3 = parseHar(built2);
    expect(parsed3.ok).toBe(true);
    if (!parsed3.ok) {
      return;
    }

    expect(built2).toEqual(built1);
    expect(parsed3.document).toEqual(parsed2.document);
    expect(parsed2.document).toEqual(parsed1.document);
  });

  it("replaces a pageref that names no page with a page that exists", () => {
    const built = buildHar({
      creator: { name: "Caller", version: "1" },
      pages: [
        {
          id: toPageId("p1")!,
          title: "one",
          startedDateTime: toIsoDateTime("2026-01-01T00:00:00.000Z")!,
        },
      ],
      entries: [
        {
          pageref: toPageId("missing")!,
          startedDateTime: toIsoDateTime("2026-01-01T00:00:01.000Z")!,
          request: { method: "GET", url: toHarUrl("https://a.example/")! },
          response: { status: 200 },
        },
      ],
    });

    const pageIds = new Set((built.log.pages ?? []).map((page) => page.id));
    expect(built.log.entries[0]!.pageref).toBe("p1");
    expect(pageIds.has(built.log.entries[0]!.pageref!)).toBe(true);
  });

  it("sets a missing entry time to the sum of timings and leaves ssl out of that sum", () => {
    const built = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: { method: "GET", url: toHarUrl("https://a.example/")! },
          response: { status: 200 },
          timings: {
            blocked: 1,
            dns: 2,
            connect: 4,
            ssl: 100,
            send: 8,
            wait: 16,
            receive: 32,
          },
        },
      ],
    });

    expect(built.log.entries[0]!.time).toBe(63);
    expect(built.log.entries[0]!.timings.ssl).toBe(100);
  });

  it("does not write defaultPageTitle into the file and rejects an empty creator", () => {
    const built = buildHar({
      creator: { name: "Caller", version: "1" },
      defaultPageTitle: "Untitled",
      entries: [],
    });
    expect(Object.keys(built.log)).not.toContain("defaultPageTitle");
    expect(() =>
      buildHar({
        creator: { name: "", version: "1" },
        entries: [],
      }),
    ).toThrow(/creator/);
    expect(() =>
      buildHar({
        creator: { name: "Caller", version: "" },
        entries: [],
      }),
    ).toThrow(/creator/);

    const single = buildHarEntry({
      pageref: toPageId("p_stream")!,
      startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
      request: {
        method: "POST",
        url: toHarUrl("https://a.example/stream?x=1")!,
        headers: [{ name: "Content-Type", value: "application/json" }],
        postData: { text: '{"a":1}' },
      },
      response: {
        status: 200,
        headers: [{ name: "Content-Type", value: "application/json" }],
        content: { text: '{"ok":true}' },
      },
      timings: { send: 2, wait: 3, receive: 4, ssl: 10 },
    });
    expect(single.pageref).toBe("p_stream");
    expect(single.time).toBe(9);
    expect(single.request.queryString).toEqual([{ name: "x", value: "1" }]);
    expect(single.request.bodySize).toBe(7);
    expect(single.response.content.size).toBe(11);
    expect(single.response.content.mimeType).toBe("application/json");
  });
});
