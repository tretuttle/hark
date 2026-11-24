import type { CustomHarFields, HarUrl } from "./model.ts";

// Each HAR object owns only the names the spec gives that object. A key such as
// `url` is spec-owned on a request and custom on a creator, so one set shared by
// every object would silently drop custom keys.
export const OWNED_FIELDS = {
  log: new Set(["version", "creator", "browser", "pages", "entries", "comment"]),
  creator: new Set(["name", "version", "comment"]),
  page: new Set(["startedDateTime", "id", "title", "pageTimings", "comment"]),
  pageTimings: new Set(["onContentLoad", "onLoad", "comment"]),
  nameValue: new Set(["name", "value", "comment"]),
  cookie: new Set(["name", "value", "path", "domain", "expires", "httpOnly", "secure", "comment"]),
  postParam: new Set(["name", "value", "fileName", "contentType", "comment"]),
  postData: new Set(["mimeType", "params", "text", "comment"]),
  request: new Set([
    "method",
    "url",
    "httpVersion",
    "cookies",
    "headers",
    "queryString",
    "postData",
    "headersSize",
    "bodySize",
    "comment",
  ]),
  content: new Set(["size", "compression", "mimeType", "text", "encoding", "comment"]),
  response: new Set([
    "status",
    "statusText",
    "httpVersion",
    "cookies",
    "headers",
    "content",
    "redirectURL",
    "headersSize",
    "bodySize",
    "comment",
  ]),
  cacheEntry: new Set([
    "expires",
    "lastAccess",
    "lastFetched",
    "eTag",
    "hitCount",
    "fetchCount",
    "comment",
  ]),
  cache: new Set(["beforeRequest", "afterRequest", "comment"]),
  timings: new Set(["blocked", "dns", "connect", "send", "wait", "receive", "ssl", "comment"]),
  entry: new Set([
    "pageref",
    "startedDateTime",
    "time",
    "request",
    "response",
    "cache",
    "timings",
    "serverIPAddress",
    "connection",
    "comment",
  ]),
  entryExport: new Set([
    "source",
    "bodyState",
    "bodyMissing",
    "bodyIncomplete",
    "bodyCheck",
    "lossyText",
    "inProgress",
    "redactedFields",
  ]),
  logExport: new Set(["redaction"]),
} as const;

export function pickCustomFields(record: object, owned: ReadonlySet<string>): CustomHarFields {
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!owned.has(key)) {
      custom[key] = value;
    }
  }
  return custom as CustomHarFields;
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function safeDecodeQueryComponent(raw: string): string {
  const plusAsSpace = raw.replace(/\+/gu, " ");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

export function extractUrlHost(url: HarUrl): string | null {
  const schemeEnd = url.indexOf(":");
  if (schemeEnd === -1) {
    return null;
  }
  const rest = url.slice(schemeEnd + 1);
  if (!rest.startsWith("//")) {
    return null;
  }
  const afterSlashes = rest.slice(2);
  const authorityEnd = afterSlashes.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    return closeBracket > 1 ? hostPort.slice(0, closeBracket + 1).toLowerCase() : null;
  }
  const colonIndex = hostPort.indexOf(":");
  const host = colonIndex === -1 ? hostPort : hostPort.slice(0, colonIndex);
  return host.length > 0 ? host.toLowerCase() : null;
}
