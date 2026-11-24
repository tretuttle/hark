import { describe, expect, it } from "vite-plus/test";

import {
  HAR_VALIDATION_RULES,
  parseHar,
  parseHarJson,
  type HarValidationRule,
} from "../src/parse.ts";

function makeValidHar(): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: { name: "Caller", version: "1.0.0" },
      browser: { name: "Zen", version: "160.0" },
      pages: [
        {
          startedDateTime: "2026-11-16T05:00:00.000Z",
          id: "page_0",
          title: "https://example.com/",
          pageTimings: { onContentLoad: 120, onLoad: 240 },
        },
      ],
      entries: [
        {
          pageref: "page_0",
          startedDateTime: "2026-11-16T05:00:00.050Z",
          time: 45,
          request: {
            method: "GET",
            url: "https://example.com/?view=full",
            httpVersion: "HTTP/2.0",
            cookies: [{ name: "prefs", value: "compact" }],
            headers: [{ name: "Accept", value: "text/html" }],
            queryString: [{ name: "view", value: "full" }],
            headersSize: 128,
            bodySize: 0,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/2.0",
            cookies: [],
            headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            content: {
              size: 15,
              mimeType: "text/html; charset=utf-8",
              text: "<h1>Hello</h1>\n",
            },
            redirectURL: "",
            headersSize: 96,
            bodySize: 15,
          },
          cache: {},
          timings: {
            blocked: 2,
            dns: 5,
            connect: 10,
            ssl: 5,
            send: 3,
            wait: 15,
            receive: 10,
          },
          serverIPAddress: "93.184.216.34",
          connection: "443",
        },
      ],
    },
  };
}

function cloneHar(alter: (har: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(makeValidHar())) as Record<string, unknown>;
  alter(copy);
  return copy;
}

describe("parseHar and parseHarJson", () => {
  it("parses a hand-written Firefox HAR fixture derived from har-builder.js with custom fields", () => {
    const firefoxHar = {
      log: {
        version: "1.2",
        creator: { name: "Zen", version: "160.0a1" },
        browser: { name: "Zen", version: "160.0a1" },
        pages: [
          {
            id: "page_1",
            pageTimings: { onContentLoad: 312, onLoad: 640 },
            startedDateTime: "2026-11-16T00:05:00.100-05:00",
            title: "https://app.example.test/models",
          },
        ],
        entries: [
          {
            startedDateTime: "2026-11-16T00:05:00.100-05:00",
            request: {
              bodySize: 0,
              method: "GET",
              url: "https://app.example.test/models",
              httpVersion: "HTTP/3",
              headers: [
                { name: "Host", value: "app.example.test" },
                { name: "Accept", value: "text/html" },
              ],
              cookies: [{ name: "sid", value: "abc123", httpOnly: true, secure: true }],
              queryString: [],
              headersSize: 210,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/3",
              headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              cookies: [],
              content: {
                mimeType: "text/html; charset=utf-8",
                size: 1200,
                comment: "Response bodies are not included.",
              },
              redirectURL: "",
              headersSize: 180,
              bodySize: 540,
            },
            cache: {},
            timings: {
              blocked: 1,
              dns: 4,
              connect: 12,
              ssl: 8,
              send: 1,
              wait: 24,
              receive: 6,
            },
            time: 56,
            _securityState: "secure",
            _priority: "Highest",
            serverIPAddress: "203.0.113.10",
            connection: "443",
            pageref: "page_1",
          },
          {
            startedDateTime: "2026-11-16T00:05:00.320-05:00",
            request: {
              bodySize: 23,
              method: "POST",
              url: "https://app.example.test/api/save",
              httpVersion: "HTTP/2.0",
              headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
              cookies: [],
              queryString: [],
              headersSize: 190,
              postData: {
                mimeType: "application/x-www-form-urlencoded",
                params: [
                  { name: "scene", value: "robot" },
                  { name: "format", value: "glb" },
                ],
                text: "scene=robot&format=glb",
              },
            },
            response: {
              status: 304,
              statusText: "Not Modified",
              httpVersion: "HTTP/2.0",
              headers: [],
              cookies: [],
              content: {
                mimeType: "application/json",
                size: 64,
                encoding: "base64",
                text: "eyJvayI6dHJ1ZX0=",
              },
              redirectURL: "",
              headersSize: 95,
              bodySize: 0,
            },
            cache: {
              afterRequest: {
                expires: "1794880000",
                lastFetched: "1794800000",
                fetchCount: "3",
                _dataSize: "64",
                _lastModified: "1794790000",
                _device: "disk",
              },
            },
            timings: {
              blocked: 0,
              dns: 0,
              connect: 0,
              ssl: 0,
              send: 2,
              wait: 11,
              receive: 1,
            },
            time: 14,
            _securityState: "secure",
            _priority: "Normal",
            pageref: "page_1",
          },
        ],
      },
    };

    const result = parseHar(firefoxHar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.document.log.entries).toHaveLength(2);
    const first = result.document.log.entries[0]!;
    const second = result.document.log.entries[1]!;
    expect(first._securityState).toBe("secure");
    expect(first._priority).toBe("Highest");
    expect(second.cache.afterRequest?._device).toBe("disk");
    expect(second.cache.afterRequest?.fetchCount).toBe("3");
    expect(second.request.postData?.params).toHaveLength(2);
    expect(second.response.content.encoding).toBe("base64");
  });

  it("parses Chrome custom underscore fields and strips UTF-8 BOM", () => {
    const chromeHar = cloneHar((har) => {
      const log = har.log as Record<string, unknown>;
      const entries = log.entries as Array<Record<string, unknown>>;
      const entry = entries[0]!;
      entry._initiator = { type: "script", url: "https://example.com/app.js", lineNumber: 12 };
      entry._resourceType = "xhr";
      entry._fromCache = "disk";
      entry._webSocketMessages = [{ type: "send", time: 1.5, opcode: 1, data: "ping" }];
      const response = entry.response as Record<string, unknown>;
      response._transferSize = 240;
      response._error = null;
      const timings = entry.timings as Record<string, unknown>;
      timings._blocked_queueing = 1.2;
    });

    const jsonWithBom = `\uFEFF${JSON.stringify(chromeHar)}`;
    const result = parseHarJson(jsonWithBom);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const entry = result.document.log.entries[0]!;
    expect(entry._resourceType).toBe("xhr");
    expect(entry._fromCache).toBe("disk");
    expect(entry._initiator?.type).toBe("script");
    expect(entry.response._transferSize).toBe(240);
    expect(entry.timings._blocked_queueing).toBe(1.2);
  });

  const ruleFixtures: Record<
    HarValidationRule,
    {
      readonly pass: () => ReturnType<typeof parseHarJson>;
      readonly fail: () => ReturnType<typeof parseHarJson>;
    }
  > = {
    "json-syntax": {
      pass: () => parseHarJson(JSON.stringify(makeValidHar())),
      fail: () => parseHarJson("{not valid json"),
    },
    "root-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () => parseHar({ notLog: {} }),
    },
    "log-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () => parseHar({ log: [] }),
    },
    "log-version": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).version = "";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).version = "2.0";
          }),
        ),
    },
    "creator-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).creator = { name: "", version: "1.0" };
          }),
        ),
    },
    "browser-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            delete (har.log as Record<string, unknown>).browser;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).browser = "Firefox";
          }),
        ),
    },
    "pages-array": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const log = har.log as Record<string, unknown>;
            delete log.pages;
            delete (log.entries as Array<Record<string, unknown>>)[0]!.pageref;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).pages = {};
          }),
        ),
    },
    "page-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            ((har.log as Record<string, unknown>).pages as unknown[])[0] = "bad-page";
          }),
        ),
    },
    "page-id-unique": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages.push({
              startedDateTime: "2026-11-16T05:01:00.000Z",
              id: "page_1",
              title: "https://example.com/next",
              pageTimings: { onContentLoad: -1, onLoad: -1 },
            });
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages.push({
              startedDateTime: "2026-11-16T05:01:00.000Z",
              id: "page_0",
              title: "https://example.com/dup",
              pageTimings: { onContentLoad: -1, onLoad: -1 },
            });
          }),
        ),
    },
    "page-timings-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages[0]!.pageTimings = null;
          }),
        ),
    },
    "entries-array": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).entries = [];
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).entries = "none";
          }),
        ),
    },
    "entry-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            ((har.log as Record<string, unknown>).entries as unknown[])[0] = 42;
          }),
        ),
    },
    "entry-pageref-exists": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.pageref = "missing_page";
          }),
        ),
    },
    "iso-datetime": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.startedDateTime = "2026-02-30T10:00:00Z";
          }),
        ),
    },
    "non-negative-number": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.time = -5;
          }),
        ),
    },
    "size-or-sentinel": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headersSize = -1;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headersSize = -2;
          }),
        ),
    },
    "timing-or-sentinel": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.timings as Record<string, unknown>).dns = -1;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.timings as Record<string, unknown>).dns = -2;
          }),
        ),
    },
    "request-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.request = null;
          }),
        ),
    },
    "request-url": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).url = "/relative/path";
          }),
        ),
    },
    "response-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.response = "ok";
          }),
        ),
    },
    "response-status": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).status = 0;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).status = 1000;
          }),
        ),
    },
    "redirect-url": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).redirectURL =
              "https://example.com/next";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).redirectURL = "not a url";
          }),
        ),
    },
    "content-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).content = null;
          }),
        ),
    },
    "mime-type": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (
              (entries[0]!.response as Record<string, unknown>).content as Record<string, unknown>
            ).mimeType = "";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (
              (entries[0]!.response as Record<string, unknown>).content as Record<string, unknown>
            ).mimeType = "invalid-mime";
          }),
        ),
    },
    "post-data-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/json",
              text: "{}",
            };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/json",
            };
          }),
        ),
    },
    "post-data-param-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/x-www-form-urlencoded",
              params: [{ name: "a", value: "1" }],
            };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/x-www-form-urlencoded",
              params: [{ value: "missing-name" }],
            };
          }),
        ),
    },
    "name-value-array": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headers = [{ name: "X-Test" }];
          }),
        ),
    },
    "cookie-array": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).cookies = [
              { name: "a", value: "1", httpOnly: "yes" },
            ];
          }),
        ),
    },
    "cache-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = [];
          }),
        ),
    },
    "cache-entry-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = { beforeRequest: null, afterRequest: { eTag: "v1", hitCount: 1 } };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = { afterRequest: "bad" };
          }),
        ),
    },
    "timings-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.timings = null;
          }),
        ),
    },
    "browser-timings": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            const timings = entries[0]!.timings as Record<string, unknown>;
            delete timings.send;
            delete timings.wait;
            delete timings.receive;
          }),
        ),
    },
    "browser-cookie-expires": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).cookies = [
              { name: "sid", value: "a", expires: null },
            ];
          }),
        ),
    },
  };

  const DOCUMENT_RULES = new Set<HarValidationRule>([
    "json-syntax",
    "root-object",
    "log-object",
    "log-version",
    "creator-object",
    "entries-array",
  ]);

  const NOTE_RULES = new Set<HarValidationRule>([
    "redirect-url",
    "mime-type",
    "browser-timings",
    "browser-cookie-expires",
  ]);

  const DROPPED_FIXTURE_RULES = new Set<HarValidationRule>(["page-object", "entry-object"]);

  it("covers every validator rule with a passing and a failing fixture", () => {
    expect(Object.keys(ruleFixtures).sort()).toEqual([...HAR_VALIDATION_RULES].sort());

    for (const rule of HAR_VALIDATION_RULES) {
      const pair = ruleFixtures[rule];
      const passed = pair.pass();
      expect(passed.ok, `expected rule ${rule} pass fixture to succeed`).toBe(true);

      const failed = pair.fail();
      expect(failed.ok, `rule ${rule} ok flag`).toBe(!DOCUMENT_RULES.has(rule));
      const match = failed.problems.find((problem) => problem.rule === rule);
      expect(
        match,
        `expected a ${rule} problem, got ${failed.problems.map((problem) => problem.rule).join(", ")}`,
      ).toBeDefined();
      const expectedSeverity = NOTE_RULES.has(rule)
        ? "note"
        : DROPPED_FIXTURE_RULES.has(rule)
          ? "dropped"
          : "error";
      expect(match?.severity).toBe(expectedSeverity);
    }
  });

  it("marks every lost entry and lost page as dropped, includes method and url when known, and keeps salvaged entries", () => {
    const result = parseHar(
      cloneHar((har) => {
        const pages = (har.log as Record<string, unknown>).pages as Array<unknown>;
        pages.push({
          id: "page_0",
          title: "https://example.com/dup",
          startedDateTime: "2026-11-16T05:01:00.000Z",
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        });
        pages.push("not-a-page");
        pages.push({
          id: "page_bad_title",
          title: 42,
          startedDateTime: "2026-11-16T05:02:00.000Z",
          pageTimings: {},
        });
        pages.push({
          id: "page_bad_timings",
          title: "bad timings",
          startedDateTime: "2026-11-16T05:03:00.000Z",
          pageTimings: "invalid",
        });

        const entries = (har.log as Record<string, unknown>).entries as Array<unknown>;
        const goodTemplate = JSON.parse(JSON.stringify(entries[0])) as Record<string, unknown>;
        entries.push(null);
        entries.push("GET https://example.com/raw-line");
        entries.push([1, 2]);
        entries.push({ ...JSON.parse(JSON.stringify(goodTemplate)), request: undefined });
        entries.push({
          ...JSON.parse(JSON.stringify(goodTemplate)),
          request: { method: "POST", url: "/relative/drop" },
        });
        entries.push({
          ...JSON.parse(JSON.stringify(goodTemplate)),
          request: { method: "DELETE", url: 42 },
        });

        const badResponse = JSON.parse(JSON.stringify(goodTemplate)) as Record<string, unknown>;
        (badResponse.request as Record<string, unknown>).url = "https://example.com/salvage-res";
        badResponse.response = "HTTP/1.1 200 OK";
        entries.push(badResponse);

        const badTime = JSON.parse(JSON.stringify(goodTemplate)) as Record<string, unknown>;
        (badTime.request as Record<string, unknown>).url = "https://example.com/salvage-time";
        badTime.time = -5;
        entries.push(badTime);

        const badDate = JSON.parse(JSON.stringify(goodTemplate)) as Record<string, unknown>;
        (badDate.request as Record<string, unknown>).url = "https://example.com/salvage-date";
        badDate.startedDateTime = "not-a-valid-date";
        entries.push(badDate);
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.document.log.pages?.map((page) => page.id)).toEqual(["page_0", "page_0__1"]);
    const droppedPages = result.problems.filter(
      (problem) => problem.path.startsWith("$.log.pages") && problem.severity === "dropped",
    );
    expect(droppedPages).toHaveLength(3);

    expect(result.document.log.entries.map((entry) => entry.request.url)).toEqual([
      "https://example.com/?view=full",
      "https://example.com/salvage-res",
      "https://example.com/salvage-time",
      "https://example.com/salvage-date",
    ]);
    expect(result.document.log.entries[1]!.response.status).toBe(0);
    expect(result.document.log.entries[2]!.time).toBe(0);
    expect(result.document.log.entries[3]!.startedDateTime).toBe("1970-01-01T00:00:00.000Z");

    const droppedEntries = result.problems.filter(
      (problem) => problem.path.startsWith("$.log.entries") && problem.severity === "dropped",
    );
    expect(droppedEntries).toHaveLength(6);
    expect(droppedEntries.some((problem) => problem.message.includes("POST /relative/drop"))).toBe(
      true,
    );
    expect(droppedEntries.some((problem) => problem.message.includes("(DELETE)"))).toBe(true);
  });

  it("reports negative send, wait, and receive and keeps the salvaged entry", () => {
    const result = parseHar(
      cloneHar((har) => {
        const entries = (har.log as Record<string, unknown>).entries as Array<
          Record<string, unknown>
        >;
        const bad = JSON.parse(JSON.stringify(entries[0])) as Record<string, unknown>;
        bad.startedDateTime = "2026-11-16T05:00:01.000Z";
        const timings = bad.timings as Record<string, unknown>;
        timings.send = -1;
        timings.wait = -1;
        timings.receive = -1;
        entries.push(bad);
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.problems.some((problem) => problem.rule === "non-negative-number")).toBe(true);
    expect(result.problems.some((problem) => problem.severity === "dropped")).toBe(false);
    expect(result.document.log.entries).toHaveLength(2);
    expect(result.document.log.entries[1]!.timings.send).toBe(0);
    expect(result.document.log.entries[1]!.timings.wait).toBe(0);
    expect(result.document.log.entries[1]!.timings.receive).toBe(0);
  });

  it("keeps a good entry that follows one whose request URL cannot be salvaged", () => {
    const result = parseHar(
      cloneHar((har) => {
        const entries = (har.log as Record<string, unknown>).entries as Array<
          Record<string, unknown>
        >;
        const good = JSON.parse(JSON.stringify(entries[0])) as Record<string, unknown>;
        entries.push({
          startedDateTime: "2026-11-16T05:00:01.000Z",
          request: { url: "/relative" },
        });
        good.startedDateTime = "2026-11-16T05:00:02.000Z";
        entries.push(good);
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.log.entries.map((entry) => entry.startedDateTime)).toEqual([
      "2026-11-16T05:00:00.050Z",
      "2026-11-16T05:00:02.000Z",
    ]);
    expect(result.problems.some((problem) => problem.severity === "dropped")).toBe(true);
  });

  it("keeps unknown keys on postData, headers, and content", () => {
    const result = parseHar(
      cloneHar((har) => {
        const entry = (
          (har.log as Record<string, unknown>).entries as Array<Record<string, unknown>>
        )[0]!;
        const request = entry.request as Record<string, unknown>;
        request.postData = {
          mimeType: "text/plain",
          text: "hello",
          params: [],
          vendorTrace: "keep-post",
        };
        request.headers = [{ name: "Accept", value: "text/html", size: 12 }];
        const response = entry.response as Record<string, unknown>;
        (response.content as Record<string, unknown>).url = "blob:keep-content-url";
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const entry = result.document.log.entries[0]!;
    expect(entry.request.postData?.vendorTrace).toBe("keep-post");
    expect(entry.request.headers[0]?.size).toBe(12);
    expect(entry.response.content.url).toBe("blob:keep-content-url");
  });

  it("reports a page with a bad date and keeps the page", () => {
    const result = parseHar(
      cloneHar((har) => {
        const pages = (har.log as Record<string, unknown>).pages as Array<Record<string, unknown>>;
        pages[0]!.startedDateTime = "not-a-date";
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.log.pages?.[0]?.title).toBe("https://example.com/");
    expect(result.document.log.pages?.[0]?.startedDateTime).toBe("1970-01-01T00:00:00.000Z");
    const problem = result.problems.find((item) => item.rule === "iso-datetime");
    expect(problem?.severity).toBe("error");
    expect(problem?.severity).not.toBe("dropped");
  });

  it("rejects an empty creator name and keeps an empty creator version with a note", () => {
    const nameless = parseHar(
      cloneHar((har) => {
        (har.log as Record<string, unknown>).creator = { name: "", version: "1" };
      }),
    );
    const missingVersion = parseHar(
      cloneHar((har) => {
        (har.log as Record<string, unknown>).creator = { name: "Caller" };
      }),
    );
    const emptyVersion = parseHar(
      cloneHar((har) => {
        (har.log as Record<string, unknown>).creator = { name: "Caller", version: "" };
      }),
    );
    expect(nameless.ok).toBe(false);
    expect(missingVersion.ok).toBe(false);
    expect(emptyVersion.ok).toBe(true);
    if (!nameless.ok) {
      expect(nameless.problems.some((problem) => problem.rule === "creator-object")).toBe(true);
    }
    if (emptyVersion.ok) {
      expect(emptyVersion.document.log.creator.version).toBe("");
      expect(
        emptyVersion.problems.some(
          (problem) => problem.rule === "creator-object" && problem.severity === "note",
        ),
      ).toBe(true);
    }
  });

  it("keeps Safari session cookie expires and negative compression", () => {
    const result = parseHar(
      cloneHar((har) => {
        const entry = (
          (har.log as Record<string, unknown>).entries as Array<Record<string, unknown>>
        )[0]!;
        const response = entry.response as Record<string, unknown>;
        response.cookies = [{ name: "pref", value: "1", expires: "" }];
        response.content = { size: 4, compression: -12, mimeType: "text/html", text: "inbox" };
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.log.entries[0]!.response.cookies[0]?.expires).toBe("");
    expect(result.document.log.entries[0]!.response.content.compression).toBe(-12);
    expect(result.problems.some((problem) => problem.path.includes("compression"))).toBe(false);
  });

  it("keeps a mitmproxy failed request and a null postData text", () => {
    const result = parseHar(
      cloneHar((har) => {
        const entries = (har.log as Record<string, unknown>).entries as Array<
          Record<string, unknown>
        >;
        entries.push({
          startedDateTime: "2026-11-16T08:00:01.000Z",
          time: 0,
          request: {
            method: "GET",
            url: "https://down.example/",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: 20,
            bodySize: 0,
          },
          response: {
            status: 0,
            statusText: "",
            httpVersion: "",
            headers: [],
            cookies: [],
            content: {},
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
            _error: "Connection refused",
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        });
        const request = entries[0]!.request as Record<string, unknown>;
        request.postData = { mimeType: "application/octet-stream", text: null, params: [] };
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.log.entries).toHaveLength(2);
    expect(result.document.log.entries[1]!.response.content.size).toBe(-1);
    expect(result.document.log.entries[1]!.response._error).toBe("Connection refused");
    expect(result.document.log.entries[0]!.request.postData?.text).toBeNull();
    const nullText = result.problems.find((problem) => problem.path.endsWith("postData.text"));
    expect(nullText?.severity).toBe("note");
  });
});
