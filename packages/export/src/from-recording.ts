// A settled or live exchange from the recording as Material. Pure: the store supplies availability from its inventory.

import { buildHarEntry } from "@hark/har/build";
import {
  isoDateTimeFromEpochMs,
  toHarUrl,
  type HarCookie,
  type HarNameValue,
  type HarTimings,
  type HarUrl,
} from "@hark/har/model";
import type {
  BodyAvailability,
  Header,
  LiveExchange,
  RequestFacts,
  ResponseFacts,
  SettledExchange,
  Timings,
  UploadOutcome,
} from "@hark/recording/exchange";
import type { ResponseSource } from "@hark/recording/routes";
import type { BodyCandidates, Material } from "./source.ts";

const RESOURCE_TYPE_BY_POLICY: { readonly [policyType: number]: string } = {
  2: "script",
  3: "image",
  4: "stylesheet",
  5: "other",
  6: "document",
  7: "document",
  10: "ping",
  11: "xhr",
  14: "font",
  15: "media",
  16: "websocket",
  19: "ping",
  20: "fetch",
  21: "image",
};

const FROM_CACHE_BY_SOURCE: { readonly [S in ResponseSource]: "disk" | undefined } = {
  network: undefined,
  cache: "disk",
  revalidated: "disk",
  "service-worker": undefined,
};

function mapHeaders(headers: readonly Header[]): HarNameValue[] {
  return headers.map(([name, value]) => ({ name, value: value ?? "" }));
}

function findHeader(headers: readonly Header[], targetName: string): string | null {
  const lower = targetName.toLowerCase();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === lower && value !== null) {
      return value;
    }
  }
  return null;
}

function parseRequestCookies(headers: readonly Header[]): HarCookie[] {
  const cookies: HarCookie[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "cookie" || value === null) continue;
    for (const part of value.split(";")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      cookies.push({
        name: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 1).trim(),
      });
    }
  }
  return cookies;
}

function parseSetCookie(raw: string): HarCookie | null {
  const segments = raw.split(";");
  const first = segments[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let path: string | undefined;
  let domain: string | undefined;
  let expires: string | undefined;
  let httpOnly: boolean | undefined;
  let secure: boolean | undefined;

  for (let i = 1; i < segments.length; i += 1) {
    const attr = segments[i]?.trim() ?? "";
    if (attr === "") continue;
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrVal = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();
    if (attrName === "path" && attrVal !== "") path = attrVal;
    else if (attrName === "domain" && attrVal !== "") domain = attrVal;
    else if (attrName === "expires" && attrVal !== "") {
      const parsed = Date.parse(attrVal);
      if (Number.isFinite(parsed)) expires = isoDateTimeFromEpochMs(parsed);
    } else if (attrName === "httponly") httpOnly = true;
    else if (attrName === "secure") secure = true;
  }

  return {
    name,
    value,
    ...(path !== undefined ? { path } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(httpOnly !== undefined ? { httpOnly } : {}),
    ...(secure !== undefined ? { secure } : {}),
  };
}

function parseResponseCookies(headers: readonly Header[]): HarCookie[] {
  const cookies: HarCookie[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "set-cookie" || value === null) continue;
    const parsed = parseSetCookie(value);
    if (parsed !== null) cookies.push(parsed);
  }
  return cookies;
}

function mapTimings(timings: Timings | null): Partial<HarTimings> {
  if (timings === null) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 };
  }
  return {
    blocked: timings.blocked ?? -1,
    dns: timings.dns ?? -1,
    connect: timings.connect ?? -1,
    ssl: timings.ssl ?? -1,
    send: timings.send ?? -1,
    wait: timings.wait ?? -1,
    receive: timings.receive ?? -1,
  };
}

function toCandidates(avail: BodyAvailability): BodyCandidates {
  switch (avail.kind) {
    case "available":
      return {
        kind: "candidates",
        list: [{ kind: "stored", at: avail.at, wireEncoding: avail.encoding, check: avail.check }],
      };
    case "empty":
      return { kind: "empty" };
    case "missing":
      return { kind: "none", reason: avail.reason };
  }
}

function uploadCandidates(outcome: UploadOutcome, avail: BodyAvailability): BodyCandidates {
  if (outcome.kind === "none") return { kind: "empty" };
  if (outcome.kind === "not-kept") return { kind: "none", reason: outcome.reason };
  return toCandidates(avail);
}

/** A request still in flight carries a body when its head says so: a positive Content-Length or any Transfer-Encoding. */
function liveUpload(headers: readonly Header[]): BodyCandidates {
  const length = Number(findHeader(headers, "content-length") ?? "0");
  const chunked = findHeader(headers, "transfer-encoding") !== null;
  return chunked || length > 0 ? { kind: "none", reason: "in-progress" } : { kind: "empty" };
}

function responseMimeType(response: ResponseFacts): string {
  return findHeader(response.headers, "content-type") ?? response.mimeType ?? "";
}

function buildRequestInput(request: RequestFacts, upload: UploadOutcome) {
  return {
    method: request.method,
    url: toHarUrl(request.url) ?? (request.url as HarUrl),
    httpVersion: request.httpVersion,
    cookies: parseRequestCookies(request.headers),
    headers: mapHeaders(request.headers),
    ...(upload.kind === "stored"
      ? { postData: { mimeType: upload.mimeType ?? "", params: [], text: "" } }
      : {}),
    headersSize: -1,
    bodySize: -1,
  };
}

export function materialFromRecording(
  exchange:
    | {
        readonly kind: "settled";
        readonly settled: SettledExchange;
        readonly body: BodyAvailability;
        readonly upload: BodyAvailability;
      }
    | { readonly kind: "live"; readonly live: LiveExchange },
): Material {
  if (exchange.kind === "live") {
    const { request, response } = exchange.live;
    const entry = buildHarEntry({
      startedDateTime: isoDateTimeFromEpochMs(request.startedAt),
      request: buildRequestInput(request, { kind: "none" }),
      response: response
        ? {
            status: response.status,
            statusText: response.statusText,
            httpVersion: response.httpVersion,
            cookies: parseResponseCookies(response.headers),
            headers: mapHeaders(response.headers),
            content: { size: -1, mimeType: responseMimeType(response) },
            redirectURL: response.redirectTo ?? "",
            headersSize: -1,
            bodySize: response.contentLength ?? -1,
          }
        : {
            status: 0,
            statusText: "",
            httpVersion: "",
            cookies: [],
            headers: [],
            content: { size: -1, mimeType: "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
      timings: mapTimings(null),
      ...(response?.remoteAddress ? { serverIPAddress: response.remoteAddress } : {}),
      _resourceType: RESOURCE_TYPE_BY_POLICY[request.policyType] ?? "other",
      ...(response && FROM_CACHE_BY_SOURCE[response.source]
        ? { _fromCache: FROM_CACHE_BY_SOURCE[response.source] }
        : {}),
    });
    return {
      entry,
      body: { kind: "none", reason: "in-progress" },
      upload: liveUpload(request.headers),
      lostGroups: {
        ...(request.headers.length === 0 ? { "request-head": "in-progress" as const } : {}),
        ...(response === null ? { "response-head": "in-progress" as const } : {}),
        timings: "in-progress",
      },
    };
  }

  const { settled, body, upload } = exchange;
  const { request } = settled;
  const response = settled.kind === "unanswered" ? null : settled.response;
  const stop = settled.kind === "abandoned" ? null : settled.stop;

  const entry = buildHarEntry({
    startedDateTime: isoDateTimeFromEpochMs(request.startedAt),
    request: buildRequestInput(request, settled.upload),
    response:
      settled.kind === "unanswered"
        ? {
            status: 0,
            statusText: "",
            httpVersion: "",
            cookies: [],
            headers: [],
            content: { size: -1, mimeType: "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: settled.stop.encodedBodySize,
            _transferSize: settled.stop.transferSize,
            _error:
              settled.stop.status.kind === "failed"
                ? settled.stop.status.error
                : settled.stop.status.kind,
          }
        : response !== null
          ? {
              status: response.status,
              statusText: response.statusText,
              httpVersion: response.httpVersion,
              cookies: parseResponseCookies(response.headers),
              headers: mapHeaders(response.headers),
              content: { size: -1, mimeType: responseMimeType(response) },
              redirectURL: response.redirectTo ?? "",
              headersSize: -1,
              bodySize: stop ? stop.encodedBodySize : (response.contentLength ?? -1),
              ...(stop ? { _transferSize: stop.transferSize } : {}),
            }
          : {
              status: 0,
              statusText: "",
              httpVersion: "",
              cookies: [],
              headers: [],
              content: { size: -1, mimeType: "" },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
    timings: mapTimings(stop ? stop.timings : null),
    ...(response?.remoteAddress ? { serverIPAddress: response.remoteAddress } : {}),
    _resourceType: RESOURCE_TYPE_BY_POLICY[request.policyType] ?? "other",
    ...(response && FROM_CACHE_BY_SOURCE[response.source]
      ? { _fromCache: FROM_CACHE_BY_SOURCE[response.source] }
      : {}),
  });

  const missingReason =
    settled.kind === "unanswered"
      ? ("no-response" as const)
      : settled.kind === "abandoned"
        ? ("network-aborted" as const)
        : ("not-recorded" as const);
  const lostGroups = {
    ...(request.headers.length === 0 ? { "request-head": missingReason } : {}),
    ...(settled.kind === "unanswered"
      ? { "response-head": "no-response" as const }
      : response === null
        ? { "response-head": "network-aborted" as const }
        : {}),
    ...(stop === null ? { timings: "network-aborted" as const } : {}),
  };

  return {
    entry,
    body:
      settled.kind === "unanswered" ? { kind: "none", reason: "no-response" } : toCandidates(body),
    upload: uploadCandidates(settled.upload, upload),
    ...(Object.keys(lostGroups).length > 0 ? { lostGroups } : {}),
  };
}
