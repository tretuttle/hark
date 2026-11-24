import { describe, expect, it } from "vite-plus/test";

import { buildHar } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { redactHar, redactHarEntry, redactUrl } from "../src/redact.ts";
import { DEFAULT_REDACTION_RULES } from "../src/rules.ts";

describe("redactHar", () => {
  it("removes structurally defined credential carriers under standard and leaves bodies byte-identical", () => {
    const jsonBodyText = JSON.stringify({
      user: "alice",
      nested: { password: "body-json-secret-1" },
    });
    const formBodyText = "client_secret=form-secret-1&grant_type=client_credentials";

    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl(
              "https://alice:url-pass-1@api.example/oauth/token?access_token=q-secret-1&page=2",
            )!,
            headers: [
              { name: "Cookie", value: "sid=cookie-secret-1" },
              { name: "Authorization", value: "Bearer auth-secret-1" },
              { name: "Proxy-Authorization", value: "Basic proxy-secret-1" },
              { name: "Accept", value: "application/json" },
            ],
            cookies: [{ name: "sid", value: "cookie-secret-1" }],
            postData: {
              mimeType: toMimeType("application/json")!,
              text: jsonBodyText,
            },
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [{ name: "Set-Cookie", value: "refresh=set-cookie-secret-1; HttpOnly" }],
            cookies: [{ name: "refresh", value: "set-cookie-secret-1", httpOnly: true }],
            content: {
              mimeType: toMimeType("application/json")!,
              text: '{"status":"ok"}',
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:01.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl("https://api.example/form")!,
            postData: {
              mimeType: toMimeType("application/x-www-form-urlencoded")!,
              params: [
                { name: "client_secret", value: "param-secret-1" },
                { name: "clientSecret", value: "camel-param-secret-1" },
                { name: "grant_type", value: "client_credentials" },
              ],
              text: formBodyText,
            },
          },
          response: {
            status: 204,
          },
        },
      ],
    });

    const { document: redacted, report } = redactHar(doc);
    const serialized = JSON.stringify(redacted);

    for (const removedSecret of [
      "url-pass-1",
      "cookie-secret-1",
      "auth-secret-1",
      "proxy-secret-1",
      "set-cookie-secret-1",
      "q-secret-1",
      "param-secret-1",
      "camel-param-secret-1",
    ]) {
      expect(serialized).not.toContain(removedSecret);
    }

    const first = redacted.log.entries[0]!;
    expect(first.request.url).toBe(
      "https://api.example/oauth/token?access_token=%5BREDACTED%5D&page=2",
    );
    expect(first.request.queryString).toEqual([
      { name: "access_token", value: "[REDACTED]" },
      { name: "page", value: "2" },
    ]);
    expect(first.request.headers.find((h) => h.name === "Accept")?.value).toBe("application/json");
    expect(first.request.postData?.text).toBe(jsonBodyText);
    expect(first.response.content.text).toBe('{"status":"ok"}');

    const second = redacted.log.entries[1]!;
    expect(second.request.postData?.params).toEqual([
      { name: "client_secret", value: "[REDACTED]" },
      { name: "clientSecret", value: "[REDACTED]" },
      { name: "grant_type", value: "client_credentials" },
    ]);
    expect(second.request.postData?.text).toBe(formBodyText);

    expect(report.applied).toBe(true);
    expect(report.level).toBe("standard");
    expect(report.entriesAffected).toBe(2);
    expect(report.totalRemoved).toBe(13);
    expect(report.records.some((record) => record.field === "log.pages[].title")).toBe(true);
    expect(report.notInspected).toContain("body-json");
    expect(report.notInspected).toContain("body-form");
    expect(report.notInspected).toContain("response-body-json");
    expect(
      report.places.every(
        (place) => place.status === "removed" || place.status === "kept-not-examined",
      ),
    ).toBe(true);
    expect(redacted.log._harExport?.redaction).toEqual(report);
    expect(first._harExport?.redactedFields).toEqual([
      "request.url",
      "request.cookies[].value",
      "request.headers[].value",
      "request.queryString[].value",
      "response.cookies[].value",
      "response.headers[].value",
    ]);
    expect(second._harExport?.redactedFields).toEqual(["request.postData.params[].value"]);
    expect(parseHar(redacted).ok).toBe(true);
  });

  it("derives report coverage from the caller's rules and supports extraRules", () => {
    expect(DEFAULT_REDACTION_RULES.some((rule) => rule.target === "header")).toBe(true);
    const unlistedHeaderSecret = "unlisted-custom-header-secret";
    const unlistedResponseBodySecret = "unlisted-response-body-secret";

    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl("https://alice:pw@api.example/debug?access_token=tok1")!,
            cookies: [
              { name: "sid", value: "sid-val" },
              { name: "other", value: "other-val" },
            ],
            headers: [
              { name: "Authorization", value: "Bearer listed-secret" },
              { name: "X-Custom-Debug-Token", value: unlistedHeaderSecret },
            ],
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("application/json")!,
              text: JSON.stringify({ diagnosticToken: unlistedResponseBodySecret }),
            },
          },
        },
      ],
    });

    const defaultRedacted = redactHar(doc);
    const defaultEntry = defaultRedacted.document.log.entries[0]!;
    expect(defaultEntry.request.headers.find((h) => h.name === "Authorization")?.value).toBe(
      "[REDACTED]",
    );
    expect(defaultEntry.request.headers.find((h) => h.name === "X-Custom-Debug-Token")?.value).toBe(
      unlistedHeaderSecret,
    );
    expect(defaultEntry.response.content.text).toContain(unlistedResponseBodySecret);
    const headerPlace = defaultRedacted.report.places.find(
      (place) => place.place === "named-header",
    );
    const bodyPlace = defaultRedacted.report.places.find(
      (place) => place.place === "response-body-json",
    );
    expect(headerPlace?.status).toBe("kept-not-examined");
    expect(headerPlace?.detail).toBe("not examined: may contain secrets");
    expect(bodyPlace?.status).toBe("kept-not-examined");
    expect(bodyPlace?.detail).toBe("not examined: may contain secrets");

    const withExtraRule = redactHar(doc, {
      extraRules: [
        { id: "header:custom-debug", target: "header", names: ["x-custom-debug-token"] },
      ],
    });
    expect(
      withExtraRule.document.log.entries[0]!.request.headers.find(
        (h) => h.name === "X-Custom-Debug-Token",
      )?.value,
    ).toBe("[REDACTED]");

    const partialCookieRules = redactHar(doc, {
      rules: [{ id: "cookie:sid", target: "cookie", names: ["sid"] }],
    });
    const partialEntry = partialCookieRules.document.log.entries[0]!;
    // A cookie rule selects every cookie value, whatever names it lists.
    expect(partialEntry.request.cookies.map((c) => c.value)).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(partialEntry.request.url).toContain("alice:pw@");
    expect(partialEntry.request.url).toContain("access_token=tok1");
    expect(partialCookieRules.report.places.find((p) => p.place === "cookie")?.status).toBe(
      "removed",
    );
    expect(
      partialCookieRules.report.places.find((p) => p.place === "request-url-userinfo")?.status,
    ).toBe("kept-not-examined");
    expect(
      partialCookieRules.report.places.find((p) => p.place === "request-url-query-secret")?.status,
    ).toBe("kept-not-examined");
    expect(
      partialCookieRules.report.places.find((p) => p.place === "header-value-secret")?.status,
    ).toBe("kept-not-examined");
    expect(partialCookieRules.report.notInspected).toContain("request-url-userinfo");
    expect(partialCookieRules.report.notInspected).toContain("request-url-query-secret");
    expect(partialCookieRules.report.notInspected).toContain("header-value-secret");
  });

  it("supports single-entry redaction (redactHarEntry) and URL/page-title redaction (redactUrl)", () => {
    const built = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl("https://bob:hunter2@api.example/items?token=sec123&page=1")!,
            headers: [
              { name: "Authorization", value: "Bearer sec456" },
              { name: "Content-Type", value: "application/json" },
              { name: "X-Custom", value: "val" },
            ],
            cookies: [{ name: "sid", value: "c789" }],
          },
          response: {
            status: 200,
            content: { mimeType: toMimeType("application/json")!, text: '{"ok":true}' },
          },
        },
      ],
    });

    const singleStandard = redactHarEntry(built.log.entries[0]!, DEFAULT_REDACTION_RULES, 0);
    expect(singleStandard.touched).toBe(true);
    expect(singleStandard.url).toBe("https://api.example/items?token=%5BREDACTED%5D&page=1");
    expect(singleStandard.covered).toEqual([
      "request-url-userinfo",
      "request-url-query-secret",
      "header-value-secret",
      "cookie",
      "query-string-secret",
      "body-param-secret",
      "redaction-record",
      "wrong-type",
    ]);
    expect(singleStandard.entry.response.content.text).toBe('{"ok":true}');

    const singleShareable = redactHarEntry(built.log.entries[0]!, { level: "shareable" }, 0);
    expect(singleShareable.touched).toBe(true);
    expect(singleShareable.url).toBe("https://api.example/items");
    expect(singleShareable.entry.request.cookies).toEqual([]);
    expect(singleShareable.entry.request.queryString).toEqual([]);
    expect(singleShareable.entry.response.content.text).toBeUndefined();
    expect(
      singleShareable.entry.request.headers.find((h) => h.name === "Content-Type")?.value,
    ).toBe("application/json");
    expect(singleShareable.entry.request.headers.find((h) => h.name === "X-Custom")?.value).toBe(
      "",
    );

    const titleStandard = redactUrl("https://user:pw@app.example/callback?code=oauth123&state=ok");
    expect(titleStandard.touched).toBe(true);
    expect(titleStandard.url).toBe("https://app.example/callback?code=%5BREDACTED%5D&state=ok");

    const titleShareable = redactUrl(
      "https://user:pw@app.example/callback?code=oauth123&state=ok#frag",
      { level: "shareable" },
    );
    expect(titleShareable.touched).toBe(true);
    expect(titleShareable.url).toBe("https://app.example/callback");
  });

  it("accounts for all 23 fixture secrets under standard and removes all 23 under shareable", () => {
    const secret = (key: string) => `SECRET_${key}_7f3a`;
    const pair = (name: string, value: string) => ({ name, value });
    const secretEntry = {
      startedDateTime: "2026-11-16T06:00:00.000Z",
      time: 10,
      request: {
        method: "POST",
        url: `https://user:${secret("URLPASS")}@api.example/v1/items?access_token=${secret("QUERY")}&q=1`,
        httpVersion: "HTTP/2",
        cookies: [{ name: "sid", value: secret("COOKIEARR") }],
        headers: [
          pair("AUTHORIZATION", `Bearer ${secret("AUTHHDR")}`),
          pair("Cookie", `sid=${secret("COOKIEHDR")}`),
          pair("X-Api-Key", secret("XAPIKEY")),
          pair("Referer", `https://app.example/cb?code=${secret("REFERER")}`),
          pair(":path", `/v1/items?access_token=${secret("H2PATH")}`),
          pair("X-CSRF-Token", secret("CSRF")),
        ],
        queryString: [pair("access_token", secret("QUERY")), pair("q", "1")],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "application/json",
          params: [{ name: "password", value: secret("PARAM") }],
          text: JSON.stringify({
            password: secret("JSONPW"),
            accessToken: secret("CAMEL"),
            nested: { client_secret: secret("NESTED") },
          }),
        },
      },
      response: {
        status: 302,
        statusText: "Found",
        httpVersion: "HTTP/2",
        cookies: [{ name: "sid", value: secret("RESCOOKIE") }],
        headers: [
          pair("Set-Cookie", `sid=${secret("SETCOOKIE")}; HttpOnly`),
          pair("Location", `https://app.example/cb?code=${secret("LOCATION")}`),
        ],
        content: {
          mimeType: "application/json",
          size: 80,
          text: JSON.stringify({
            access_token: secret("RESBODY"),
            refresh_token: secret("RESBODY2"),
          }),
        },
        redirectURL: `https://app.example/cb?code=${secret("REDIRECT")}`,
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 1, wait: 5, receive: 4 },
      pageref: "page_1",
      _initiator: { type: "script", url: `https://app.example/x.js?token=${secret("INITIATOR")}` },
    };
    const formEntry = {
      startedDateTime: "2026-11-16T06:00:01.000Z",
      time: 10,
      request: {
        method: "POST",
        url: "https://api.example/login",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "application/x-www-form-urlencoded",
          params: [],
          text: `user=a&password=${secret("FORM")}`,
        },
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        content: { mimeType: "text/html", size: 0 },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 1, receive: 1 },
    };
    const multipartEntry = {
      startedDateTime: "2026-11-16T06:00:02.000Z",
      time: 10,
      request: {
        method: "POST",
        url: "https://api.example/upload",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "multipart/form-data; boundary=b",
          params: [],
          text: `--b\r\nContent-Disposition: form-data; name="password"\r\n\r\n${secret("MULTIPART")}\r\n--b--`,
        },
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        content: { mimeType: "text/html", size: 0 },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 1, receive: 1 },
    };

    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        pages: [
          {
            id: "page_1",
            title: `https://app.example/?token=${secret("PAGETITLE")}`,
            startedDateTime: "2026-11-16T05:59:59.000Z",
            pageTimings: {},
          },
        ],
        entries: [secretEntry, formEntry, multipartEntry],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const { document: stdDoc, report: stdReport } = redactHar(parsed.document);
    const stdText = JSON.stringify(stdDoc);

    const removedInStandard = [
      "URLPASS",
      "QUERY",
      "AUTHHDR",
      "COOKIEHDR",
      "XAPIKEY",
      "CSRF",
      "COOKIEARR",
      "PARAM",
      "SETCOOKIE",
      "RESCOOKIE",
      "PAGETITLE",
      "REFERER",
      "LOCATION",
      "REDIRECT",
    ];
    for (const key of removedInStandard) {
      expect(stdText).not.toContain(secret(key));
    }

    const unexaminedInStandard: ReadonlyArray<readonly [string, string]> = [
      ["H2PATH", "url-header"],
      ["JSONPW", "body-json"],
      ["CAMEL", "body-json"],
      ["NESTED", "body-json"],
      ["RESBODY", "response-body-json"],
      ["RESBODY2", "response-body-json"],
      ["INITIATOR", "initiator"],
      ["FORM", "body-form"],
      ["MULTIPART", "body-multipart"],
    ];
    for (const [key, place] of unexaminedInStandard) {
      expect(stdText).toContain(secret(key));
      const cov = stdReport.places.find((item) => item.place === place);
      expect(cov?.status).toBe("kept-not-examined");
      expect(cov?.detail).toBe("not examined: may contain secrets");
      expect(cov?.count).toBeGreaterThan(0);
      expect(stdReport.notInspected).toContain(place);
    }

    expect(stdReport.entriesAffected).toBe(1);
    expect(stdReport.records.some((record) => record.field === "log.pages[].title")).toBe(true);
    expect("_hark" in stdDoc.log).toBe(false);
    expect(stdDoc.log._harExport?.redaction).toEqual(stdReport);
    expect(parseHar(stdDoc).ok).toBe(true);

    const { document: shareDoc, report: shareReport } = redactHar(parsed.document, {
      level: "shareable",
    });
    const shareText = JSON.stringify(shareDoc);
    const all23 = [...removedInStandard, ...unexaminedInStandard.map(([key]) => key)];
    for (const key of all23) {
      expect(shareText).not.toContain(secret(key));
    }
    expect(shareReport.level).toBe("shareable");
    expect(shareReport.remainingRisk).toContain("the path of request URLs");
    expect(parseHar(shareDoc).ok).toBe(true);
  });
});
