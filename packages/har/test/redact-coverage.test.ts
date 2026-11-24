import { describe, expect, it } from "vite-plus/test";

import { decodeAsciiBase64, encodeAsciiBase64 } from "./ascii-base64.ts";
import { buildHar } from "../src/build.ts";
import {
  HAR_REDACTION_PLACES,
  toHarUrl,
  toIsoDateTime,
  toMimeType,
  type HarRedactionPlace,
} from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { ALLOWLISTED_HEADER_NAMES, URL_HEADER_NAMES, redactHar } from "../src/redact.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function entry(start: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    startedDateTime: start,
    time: 10,
    request: {
      method: "GET",
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "text/plain" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 1, wait: 1, receive: 1 },
    ...extra,
  };
}

describe("redaction coverage", () => {
  it("leaves realistic bodies byte-identical under standard and removes them under shareable", () => {
    expect(ALLOWLISTED_HEADER_NAMES.has("content-type")).toBe(true);
    expect(ALLOWLISTED_HEADER_NAMES.has("content-length")).toBe(true);
    expect(URL_HEADER_NAMES.has("location")).toBe(true);
    expect(URL_HEADER_NAMES.has("referer")).toBe(true);

    const jsBundle = [
      "const B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';",
      "function layout(prevReachedMinPanes=0,nextPaneWidth24=1){return prevReachedMinPanes+nextPaneWidth24;}",
      "export default layout;",
    ].join("\n");
    const htmlBody =
      '<!doctype html><link rel="stylesheet" href="/assets/index-k0-HAKZI.css" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" crossorigin><script type="module" src="/assets/index-C4tyqWfb.js"></script>';
    const jsonBody = JSON.stringify({
      id: "1849203849102938471",
      stripeId: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      i18nKey: "checkout.Payment2Method.Label",
      icon: PNG,
    });

    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl(
              "https://cdn.example/assets/index-C4tyqWfb.js?snowflake=1849203849102938471",
            )!,
            headers: [
              { name: "Content-Type", value: "application/javascript" },
              { name: "X-Request-Id", value: "pi_3MtwBwLkdIwHu7ix28a3tqPa" },
            ],
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("application/javascript")!,
              text: jsBundle,
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:01.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/index.html")!,
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("text/html")!,
              text: htmlBody,
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:02.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl("https://app.example/api/order")!,
            postData: {
              mimeType: toMimeType("application/json")!,
              text: jsonBody,
            },
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("application/json")!,
              text: jsonBody,
            },
          },
          _requestContext: { trace: "keep-in-standard" },
        },
      ],
    });

    const standard = redactHar(doc, { level: "standard" });
    expect(standard.document.log.entries[0]!.response.content.text).toBe(jsBundle);
    expect(standard.document.log.entries[0]!.request.url).toContain(
      "snowflake=1849203849102938471",
    );
    expect(standard.document.log.entries[1]!.response.content.text).toBe(htmlBody);
    expect(standard.document.log.entries[2]!.request.postData?.text).toBe(jsonBody);
    expect(standard.document.log.entries[2]!.response.content.text).toBe(jsonBody);
    expect(standard.document.log.entries[2]!._requestContext).toEqual({
      trace: "keep-in-standard",
    });

    const shareable = redactHar(doc, { level: "shareable" });
    expect(shareable.document.log.entries[0]!.request.url).toBe(
      "https://cdn.example/assets/index-C4tyqWfb.js",
    );
    expect(shareable.document.log.entries[0]!.request.queryString).toEqual([]);
    expect(
      shareable.document.log.entries[0]!.request.headers.find((h) => h.name === "Content-Type")
        ?.value,
    ).toBe("application/javascript");
    expect(
      shareable.document.log.entries[0]!.request.headers.find((h) => h.name === "X-Request-Id")
        ?.value,
    ).toBe("");
    expect(shareable.document.log.entries[0]!.response.content.text).toBeUndefined();
    expect(shareable.document.log.entries[1]!.response.content.text).toBeUndefined();
    expect(shareable.document.log.entries[2]!.request.postData?.text).toBe("");
    expect(shareable.document.log.entries[2]!.response.content.text).toBeUndefined();
    expect(shareable.document.log.entries[2]!._requestContext).toBeUndefined();
    expect(
      shareable.report.places.find((place) => place.place === "response-body-other")?.status,
    ).toBe("removed");
    expect(
      shareable.report.places.find((place) => place.place === "request-url-path")?.status,
    ).toBe("kept-by-allowlist");
  });

  it("keeps custom fields at all 19 HAR levels under standard and removes them all under shareable", () => {
    const customTag = (tag: string) => ({
      _u: `keep-${tag}`,
      vendorNote: `keep-${tag}-plain`,
    });
    const levels = [
      "log",
      "creator",
      "browser",
      "page",
      "pageTimings",
      "entry",
      "request",
      "reqCookie",
      "reqHeader",
      "query",
      "postData",
      "param",
      "response",
      "resCookie",
      "resHeader",
      "content",
      "cache",
      "cacheEntry",
      "timings",
    ] as const;

    const parsed = parseHar({
      log: {
        version: "1.2",
        ...customTag("log"),
        creator: { name: "u", version: "1", ...customTag("creator") },
        browser: { name: "b", version: "1", ...customTag("browser") },
        pages: [
          {
            id: "p1",
            title: "t",
            startedDateTime: "2026-11-16T00:00:00.000Z",
            pageTimings: { onLoad: 1, ...customTag("pageTimings") },
            ...customTag("page"),
          },
        ],
        entries: [
          {
            pageref: "p1",
            startedDateTime: "2026-11-16T00:00:01.000Z",
            time: 1,
            ...customTag("entry"),
            request: {
              method: "POST",
              url: "https://u.example/a?x=1",
              httpVersion: "HTTP/1.1",
              ...customTag("request"),
              cookies: [{ name: "c", value: "v", ...customTag("reqCookie") }],
              headers: [{ name: "h", value: "v", ...customTag("reqHeader") }],
              queryString: [{ name: "x", value: "1", ...customTag("query") }],
              postData: {
                mimeType: "application/x-www-form-urlencoded",
                text: "",
                params: [{ name: "p", value: "v", ...customTag("param") }],
                ...customTag("postData"),
              },
              headersSize: -1,
              bodySize: -1,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/1.1",
              ...customTag("response"),
              cookies: [{ name: "c", value: "v", ...customTag("resCookie") }],
              headers: [{ name: "h", value: "v", ...customTag("resHeader") }],
              content: {
                size: 1,
                mimeType: "text/plain",
                text: "a",
                ...customTag("content"),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
            cache: {
              ...customTag("cache"),
              beforeRequest: {
                lastAccess: "2026-11-16T00:00:00.000Z",
                eTag: "e",
                hitCount: 1,
                ...customTag("cacheEntry"),
              },
            },
            timings: { send: 0, wait: 0, receive: 0, ...customTag("timings") },
          },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const standardText = JSON.stringify(redactHar(parsed.document, { level: "standard" }).document);
    const shareableResult = redactHar(parsed.document, { level: "shareable" });
    const shareableText = JSON.stringify(shareableResult.document);

    for (const lv of levels) {
      expect(standardText).toContain(`"keep-${lv}"`);
      expect(standardText).toContain(`"keep-${lv}-plain"`);
      expect(shareableText).not.toContain(`"keep-${lv}"`);
      expect(shareableText).not.toContain(`"keep-${lv}-plain"`);
    }
    expect(
      shareableResult.report.places.find((p) => p.place === "other-custom-field")?.status,
    ).toBe("removed");
  });

  it("accounts for all 24 fixture secrets under standard and removes all except the URL path under shareable", () => {
    const secret = (key: string) => `SECRET_${key}_9c2e`;
    const jwt = (key: string) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${key}In0.${secret(key)}`;
    const signed = `https://bucket.s3.amazonaws.com/f.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261116&X-Amz-Signature=${secret("S3_SIG")}&X-Amz-Security-Token=${secret("S3_STS")}`;

    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "t", version: "1" },
        pages: [
          {
            id: "page_0",
            title: "https://app.example/",
            startedDateTime: "2026-11-16T09:59:59.000Z",
            pageTimings: {},
          },
        ],
        entries: [
          entry("2026-11-16T10:00:00.000Z", "https://app.example/api/files", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 100,
                mimeType: "application/json",
                text: JSON.stringify({
                  name: "f.zip",
                  downloadUrl: `https://bucket.s3.amazonaws.com/f.zip?X-Amz-Signature=${secret("RB_SIGNEDURL")}`,
                }),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:01.000Z", `wss://rt.example/socket?token=${secret("WS_URL")}`, {
            response: {
              status: 101,
              statusText: "",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: "" },
              redirectURL: "",
              headersSize: -1,
              bodySize: 0,
            },
            request: {
              method: "GET",
              url: `wss://rt.example/socket?token=${secret("WS_URL")}`,
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [
                { name: "Sec-WebSocket-Protocol", value: `bearer, ${secret("WS_PROTOCOL")}` },
              ],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
            _webSocketMessages: [
              {
                type: "send",
                time: 1,
                opcode: 1,
                data: JSON.stringify({ type: "auth", token: jwt("WS_JWT") }),
              },
            ],
          }),
          entry("2026-11-16T10:00:02.000Z", "https://sso.example/login/callback", {
            response: {
              status: 302,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [
                { name: "SESSIONID", value: secret("REDIR_SETCOOKIE"), path: "/" },
                { name: "SESSIONID2", value: secret("REDIR_RESCOOKIE") },
              ],
              headers: [
                {
                  name: "Set-Cookie",
                  value: `SESSIONID=${secret("REDIR_SETCOOKIE")}; Path=/; HttpOnly`,
                },
                { name: "Location", value: "https://app.example/home" },
              ],
              content: { size: 0, mimeType: "text/plain" },
              redirectURL: "https://app.example/home",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:03.000Z", "https://app.example/graphql", {
            request: {
              method: "POST",
              url: "https://app.example/graphql",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
              postData: {
                mimeType: "application/json",
                params: [],
                text: JSON.stringify({
                  variables: { authorization: `Bearer ${secret("GQL_BEARER")}` },
                }),
              },
            },
          }),
          entry("2026-11-16T10:00:04.000Z", "https://app.example/api/x", {
            _requestContext: { apiKey: secret("CUSTOM_APIKEY") },
          }),
          entry("2026-11-16T10:00:05.000Z", signed),
          entry(
            "2026-11-16T10:00:06.000Z",
            `https://maps.googleapis.com/maps/api/geocode/json?address=x&key=${secret("GKEY")}`,
          ),
          entry("2026-11-16T10:00:07.000Z", "https://idp.example/authorize?response_type=token", {
            response: {
              status: 302,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [
                {
                  name: "Location",
                  value: `https://app.example/cb#access_token=${secret("IMPLICIT_LOC")}&token_type=bearer`,
                },
              ],
              content: { size: 0, mimeType: "text/plain" },
              redirectURL: `https://app.example/cb#access_token=${secret("IMPLICIT_REDIR")}&token_type=bearer`,
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:08.000Z", "https://app.example/api/login", {
            request: {
              method: "POST",
              url: "https://app.example/api/login",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
              postData: {
                mimeType: "text/plain;charset=UTF-8",
                params: [],
                text: JSON.stringify({ user: "a", password: secret("TEXTPLAIN_JSON") }),
              },
            },
          }),
          entry("2026-11-16T10:00:09.000Z", "https://cloud.example/v3/servers", {
            request: {
              method: "GET",
              url: "https://cloud.example/v3/servers",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [
                { name: "X-Auth-Token", value: secret("X_AUTH_TOKEN") },
                { name: "cookie", value: `refresh=${secret("REFRESH_COOKIE_HDR")}` },
              ],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
          }),
          entry("2026-11-16T10:00:10.000Z", "https://app.example/oauth/token", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 80,
                mimeType: "application/json",
                encoding: "base64",
                text: encodeAsciiBase64(
                  JSON.stringify({ access_token: secret("B64_JSON"), token_type: "bearer" }),
                ),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:11.000Z", "https://app.example/settings", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 90,
                mimeType: "text/html",
                text: `<form><input type="hidden" name="csrf_token" value="${secret("HTML_CSRF")}"></form>`,
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:12.000Z", "https://app.example/x", {
            comment: `debug token=${secret("ENTRY_COMMENT")}`,
          }),
          entry(
            "2026-11-16T10:00:13.000Z",
            `https://app.example/auth/magic/${secret("PATH_TOKEN")}`,
          ),
          entry("2026-11-16T10:00:14.000Z", "https://app.example/y.js", {
            _initiator: {
              type: "script",
              stack: {
                callFrames: [
                  {
                    functionName: "f",
                    scriptId: "1",
                    url: `https://app.example/a.js?token=${secret("STACK_URL")}`,
                    lineNumber: 1,
                    columnNumber: 1,
                  },
                ],
              },
            },
          }),
          entry("2026-11-16T10:00:15.000Z", "https://app.example/oidc", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 60,
                mimeType: "application/json",
                text: JSON.stringify({ results: [{ id_token: secret("ID_TOKEN_ARRAY") }] }),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:16.000Z", "https://mail.example/inbox", {
            request: {
              method: "GET",
              url: "https://mail.example/inbox",
              httpVersion: "HTTP/2",
              cookies: [{ name: "sid", value: secret("SAFARI_COOKIE") }],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
          }),
          entry("2026-11-16T10:00:17.000Z", "https://app.example/cached", {
            cache: { beforeRequest: { eTag: `W/"${secret("CACHE_ETAG")}"`, hitCount: 1 } },
          }),
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const removedInStd = [
      "REDIR_SETCOOKIE",
      "REDIR_RESCOOKIE",
      "S3_SIG",
      "S3_STS",
      "GKEY",
      "X_AUTH_TOKEN",
      "WS_URL",
      "SAFARI_COOKIE",
      "REFRESH_COOKIE_HDR",
    ];
    const notExaminedInStd: ReadonlyArray<readonly [string, HarRedactionPlace]> = [
      ["RB_SIGNEDURL", "response-body-json"],
      ["WS_JWT", "websocket"],
      ["GQL_BEARER", "body-json"],
      ["CUSTOM_APIKEY", "other-custom-field"],
      ["IMPLICIT_LOC", "url-header"],
      ["IMPLICIT_REDIR", "redirect-url"],
      ["TEXTPLAIN_JSON", "body-json"],
      ["WS_PROTOCOL", "named-header"],
      ["B64_JSON", "response-body-base64"],
      ["HTML_CSRF", "response-body-other"],
      ["ENTRY_COMMENT", "comment"],
      ["PATH_TOKEN", "request-url-path"],
      ["STACK_URL", "initiator"],
      ["ID_TOKEN_ARRAY", "response-body-json"],
      ["CACHE_ETAG", "cache"],
    ];

    const std = redactHar(parsed.document, { level: "standard" });
    const stdDecoded = std.document.log.entries
      .filter((item) => item.response.content.encoding === "base64" && item.response.content.text)
      .map((item) => decodeAsciiBase64(item.response.content.text ?? ""));
    const stdOut = [JSON.stringify(std.document), ...stdDecoded].join("\n");

    for (const key of removedInStd) {
      expect(stdOut).not.toContain(secret(key));
    }
    for (const [key, place] of notExaminedInStd) {
      expect(stdOut).toContain(secret(key));
      const cov = std.report.places.find((item) => item.place === place);
      expect(cov?.status).toBe("kept-not-examined");
      expect(cov?.detail).toBe("not examined: may contain secrets");
      expect(cov?.count).toBeGreaterThan(0);
    }

    const shareable = redactHar(parsed.document, { level: "shareable" });
    const shareOut = JSON.stringify(shareable.document);
    for (const key of removedInStd) {
      expect(shareOut).not.toContain(secret(key));
    }
    for (const [key] of notExaminedInStd) {
      if (key === "PATH_TOKEN") {
        expect(shareOut).toContain(secret(key));
      } else {
        expect(shareOut).not.toContain(secret(key));
      }
    }
    expect(shareable.report.places.find((item) => item.place === "request-url-path")?.status).toBe(
      "kept-by-allowlist",
    );
    expect(shareable.report.places).toHaveLength(HAR_REDACTION_PLACES.length);
  });
});
