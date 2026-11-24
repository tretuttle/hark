import type { HarRedactionPlace } from "@hark/har/model";
import { BODY_WINDOW_BYTES } from "../src/run.ts";
import { utf8, type FakeRow, type SideEntry, type SideRow } from "./fake-ports.ts";

// A unique marker in every string the two sources can hand the export, each tagged with the redaction place it is
// placed in, across rows that take every path: paired, one-sided, cut short, streamed, and sources that throw.

export interface Marker {
  readonly marker: string;
  readonly place: HarRedactionPlace;
}

export const markers: Marker[] = [];
function mark(place: HarRedactionPlace): string {
  const marker = `MKR${String(markers.length).padStart(3, "0")}X`;
  markers.push({ marker, place });
  return marker;
}

function sideEntry(): SideEntry {
  return {
    request: {
      httpVersion: `HTTP/${mark("protocol-metadata")}`,
      headers: [
        { name: "Authorization", value: `Bearer ${mark("header-value-secret")}` },
        { name: "Cookie", value: `sid=${mark("header-value-secret")}` },
        { name: "Referer", value: `https://r.example/?token=${mark("url-header")}` },
        { name: "Accept", value: mark("header-value-allowlisted") },
        { name: "X-Note", value: mark("named-header") },
        { name: `X-${mark("header-name")}`, value: "v" },
      ],
      cookies: [{ name: mark("cookie-metadata"), value: mark("cookie") }],
      queryString: [
        { name: "token", value: mark("query-string-secret") },
        { name: mark("query-string"), value: mark("query-string") },
      ],
      postData: {
        mimeType: "application/json",
        params: [
          { name: "password", value: mark("body-param-secret") },
          {
            name: mark("body-param"),
            value: mark("body-param"),
            fileName: mark("body-param"),
            contentType: mark("body-param"),
          },
        ],
        text: "",
      },
    },
    response: {
      status: 302,
      statusText: mark("protocol-metadata"),
      headers: [
        { name: "Set-Cookie", value: `s=${mark("header-value-secret")}` },
        { name: "Location", value: `https://l.example/?code=${mark("url-header")}` },
        { name: "Vary", value: mark("header-value-allowlisted") },
        { name: "X-Info", value: mark("named-header") },
      ],
      cookies: [
        {
          name: mark("cookie-metadata"),
          value: mark("cookie"),
          path: `/${mark("cookie-metadata")}`,
          domain: mark("cookie-metadata"),
        },
      ],
      redirectURL: `https://x.example/?token=${mark("redirect-url")}`,
      _error: mark("other-custom-field"),
      content: { size: -1, mimeType: "application/json" },
    },
    cache: {
      comment: mark("comment"),
      beforeRequest: {
        lastAccess: "2026-11-16T00:00:00.000Z",
        eTag: mark("cache"),
        hitCount: 1,
        comment: mark("cache"),
      },
    },
    timings: { send: 1, wait: 2, receive: 3, comment: mark("comment") },
    serverIPAddress: "192.0.2.1",
    connection: mark("other-custom-field"),
    _securityState: mark("other-custom-field"),
    _priority: mark("other-custom-field"),
    _resourceType: mark("other-custom-field"),
    _fromCache: mark("other-custom-field"),
    _connectionId: mark("other-custom-field"),
    _initiator: {
      type: "script",
      url: mark("initiator"),
      stack: {
        callFrames: [
          {
            functionName: mark("initiator"),
            scriptId: mark("initiator"),
            url: `https://s.example/a.js?token=${mark("initiator")}`,
            lineNumber: 1,
            columnNumber: 2,
          },
        ],
      },
    },
    _webSocketMessages: [
      { type: "send", time: 1, opcode: 1, data: `{"token":"${mark("websocket")}"}` },
    ],
  };
}

function url(row: number): string {
  return `https://u${mark("request-url-userinfo")}:pw@h${String(row)}.example/p${mark("request-url-path")}/?token=${mark("request-url-query-secret")}&q=${mark("request-url-query")}#${mark("request-url-fragment")}`;
}

function side(extra: Partial<SideRow>): SideRow {
  const entry = sideEntry();
  return { entry, ...extra };
}

function json(place: HarRedactionPlace): Uint8Array {
  return utf8(JSON.stringify({ token: mark(place), pad: "p".repeat(40) }));
}

function longBody(place: HarRedactionPlace): Uint8Array {
  const out = new Uint8Array(BODY_WINDOW_BYTES + 200_000).fill(0x2e);
  out.set(utf8(mark(place)), BODY_WINDOW_BYTES + 100_000);
  return out;
}

const binaryUpload = new Uint8Array([0xff, 0xfe, ...utf8(mark("request-body-other")), 0x80]);

export const ROWS: readonly FakeRow[] = [
  {
    id: 1,
    url: url(1),
    method: "POST",
    navigation: true,
    tab: 1,
    recording: side({
      body: { kind: "bytes", data: json("response-body-json"), chunk: 9 },
      upload: { kind: "bytes", data: json("body-json") },
    }),
    devtools: side({
      body: { kind: "text", slices: [`{"token":"${mark("response-body-json")}"}`] },
      upload: { kind: "text", slices: [`{"a":"${mark("body-json")}"}`] },
    }),
  },
  {
    id: 2,
    url: url(2),
    method: "POST",
    tab: 1,
    recording: side({
      body: { kind: "bytes", data: json("response-body-json"), chunk: 5, failAt: 3 },
      upload: { kind: "bytes", data: binaryUpload },
    }),
  },
  {
    id: 3,
    url: url(3),
    navigation: true,
    tab: 2,
    devtools: side({
      body: {
        kind: "base64",
        slices: [Buffer.from(json("response-body-base64")).toString("base64")],
      },
      upload: { kind: "text", slices: [mark("body-json"), "tail"], failAt: 1 },
    }),
  },
  {
    id: 4,
    url: url(4),
    tab: 2,
    recording: side({
      body: { kind: "bytes", data: longBody("response-body-base64"), chunk: 1_000_003 },
    }),
  },
  { id: 5, url: url(5), tab: 1, recording: side({ loadThrows: true }) },
  {
    id: 6,
    url: url(6),
    tab: 1,
    recording: side({ loadThrows: true }),
    devtools: side({
      body: { kind: "text", slices: [mark("response-body-other"), "x"], failAt: 1 },
    }),
  },
];
