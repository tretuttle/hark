import { decodeAsciiBase64, encodeAsciiBase64 } from "./ascii-base64.ts";
import type { HarDocument, HarModelField, HarRedactionPlace } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";

// A text marker is found by searching the output. A number or boolean cannot be told apart that way,
// so it is written at a path and found by reading that path back.
export interface Marker {
  readonly field: HarModelField;
  readonly place: HarRedactionPlace;
  readonly marker: string;
  readonly path?: readonly (string | number)[] | undefined;
  readonly value?: number | boolean | undefined;
}

function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node = root;
  for (const step of path) {
    node =
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[step]
        : undefined;
  }
  return node;
}

export function markerPresent(document: HarDocument, item: Marker): boolean {
  return item.path === undefined
    ? haystackFor(document).includes(item.marker)
    : valueAt(document, item.path) === item.value;
}

const ENTRY: readonly (string | number)[] = ["log", "entries", 0];

const NUMBER_MARKERS: ReadonlyArray<
  readonly [HarModelField, HarRedactionPlace, readonly (string | number)[], number | boolean]
> = [
  [
    "log.pages[].pageTimings.onContentLoad",
    "measurement",
    ["log", "pages", 0, "pageTimings", "onContentLoad"],
    101,
  ],
  [
    "log.pages[].pageTimings.onLoad",
    "measurement",
    ["log", "pages", 0, "pageTimings", "onLoad"],
    102,
  ],
  ["entry.time", "measurement", [...ENTRY, "time"], 103],
  ["request.headersSize", "measurement", [...ENTRY, "request", "headersSize"], 104],
  ["request.bodySize", "measurement", [...ENTRY, "request", "bodySize"], 105],
  [
    "request.cookies[].httpOnly",
    "cookie-metadata",
    [...ENTRY, "request", "cookies", 0, "httpOnly"],
    true,
  ],
  [
    "request.cookies[].secure",
    "cookie-metadata",
    [...ENTRY, "request", "cookies", 0, "secure"],
    true,
  ],
  ["response.status", "measurement", [...ENTRY, "response", "status"], 206],
  ["response.headersSize", "measurement", [...ENTRY, "response", "headersSize"], 107],
  ["response.bodySize", "measurement", [...ENTRY, "response", "bodySize"], 108],
  [
    "response.cookies[].httpOnly",
    "cookie-metadata",
    [...ENTRY, "response", "cookies", 0, "httpOnly"],
    true,
  ],
  [
    "response.cookies[].secure",
    "cookie-metadata",
    [...ENTRY, "response", "cookies", 0, "secure"],
    true,
  ],
  ["response.content.size", "measurement", [...ENTRY, "response", "content", "size"], 109],
  [
    "response.content.compression",
    "measurement",
    [...ENTRY, "response", "content", "compression"],
    110,
  ],
  ["response._transferSize", "other-custom-field", [...ENTRY, "response", "_transferSize"], 111],
  ["cache.beforeRequest.hitCount", "cache", [...ENTRY, "cache", "beforeRequest", "hitCount"], 112],
  ["cache.afterRequest.hitCount", "cache", [...ENTRY, "cache", "afterRequest", "hitCount"], 113],
  ["timings.blocked", "measurement", [...ENTRY, "timings", "blocked"], 114],
  ["timings.dns", "measurement", [...ENTRY, "timings", "dns"], 115],
  ["timings.connect", "measurement", [...ENTRY, "timings", "connect"], 116],
  ["timings.send", "measurement", [...ENTRY, "timings", "send"], 117],
  ["timings.wait", "measurement", [...ENTRY, "timings", "wait"], 118],
  ["timings.receive", "measurement", [...ENTRY, "timings", "receive"], 119],
  ["timings.ssl", "measurement", [...ENTRY, "timings", "ssl"], 120],
  [
    "timings._blocked_queueing",
    "other-custom-field",
    [...ENTRY, "timings", "_blocked_queueing"],
    121,
  ],
  ["timings._blocked_proxy", "other-custom-field", [...ENTRY, "timings", "_blocked_proxy"], 122],
  ["timings._workerStart", "other-custom-field", [...ENTRY, "timings", "_workerStart"], 123],
  ["timings._workerReady", "other-custom-field", [...ENTRY, "timings", "_workerReady"], 124],
  [
    "timings._workerFetchStart",
    "other-custom-field",
    [...ENTRY, "timings", "_workerFetchStart"],
    125,
  ],
  [
    "timings._workerRespondWithSettled",
    "other-custom-field",
    [...ENTRY, "timings", "_workerRespondWithSettled"],
    126,
  ],
  [
    "entry._harExport.bodyIncomplete",
    "export-annotation",
    [...ENTRY, "_harExport", "bodyIncomplete"],
    true,
  ],
  ["entry._harExport.lossyText", "export-annotation", [...ENTRY, "_harExport", "lossyText"], 127],
  [
    "entry._harExport.inProgress",
    "export-annotation",
    [...ENTRY, "_harExport", "inProgress"],
    true,
  ],
  ["entry._initiator.lineNumber", "initiator", [...ENTRY, "_initiator", "lineNumber"], 128],
  ["entry._initiator.columnNumber", "initiator", [...ENTRY, "_initiator", "columnNumber"], 129],
  [
    "entry._initiator.stack.callFrames[].lineNumber",
    "initiator",
    [...ENTRY, "_initiator", "stack", "callFrames", 0, "lineNumber"],
    130,
  ],
  [
    "entry._initiator.stack.callFrames[].columnNumber",
    "initiator",
    [...ENTRY, "_initiator", "stack", "callFrames", 0, "columnNumber"],
    131,
  ],
  [
    "entry._webSocketMessages[].time",
    "websocket",
    [...ENTRY, "_webSocketMessages", 0, "time"],
    132,
  ],
  [
    "entry._webSocketMessages[].opcode",
    "websocket",
    [...ENTRY, "_webSocketMessages", 0, "opcode"],
    133,
  ],
];

function setAt(root: unknown, path: readonly (string | number)[], value: unknown): void {
  const parent = valueAt(root, path.slice(0, -1));
  if (typeof parent !== "object" || parent === null) {
    throw new Error(`No object at ${path.slice(0, -1).join(".")}`);
  }
  (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
}

function baseEntry(index: number, url = "https://plain.example/item"): Record<string, unknown> {
  return {
    pageref: "p_base",
    startedDateTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    time: 5,
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
      content: { size: 2, mimeType: "text/plain", text: "ok" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 2,
    },
    cache: {},
    timings: { send: 1, wait: 2, receive: 2 },
  };
}

export function buildMarkerDocument(): {
  readonly document: HarDocument;
  readonly markers: readonly Marker[];
  readonly markedFields: ReadonlySet<HarModelField>;
} {
  const markers: Marker[] = [];
  const markedFields = new Set<HarModelField>();
  let seq = 0;

  const nextMarker = (field: HarModelField, place: HarRedactionPlace): string => {
    seq += 1;
    markedFields.add(field);
    if (field === "log.version") {
      const m = "1.947281";
      markers.push({ field, place, marker: m });
      return m;
    }
    if (field === "log.pages[].startedDateTime") {
      const m = "2031-07-19T14:23:45.671Z";
      markers.push({ field, place, marker: m });
      return m;
    }
    if (field === "entry.startedDateTime") {
      const m = "2032-08-21T15:34:56.782Z";
      markers.push({ field, place, marker: m });
      return m;
    }
    if (place === "request-url-host") {
      const m = `marker-host-${String(seq)}.example`;
      markers.push({ field, place, marker: m });
      return m;
    }
    const slug = `${field}_${place}`.replace(/[^A-Za-z0-9]+/gu, "_");
    const m = `MARKER_${String(seq)}_${slug}`;
    markers.push({ field, place, marker: m });
    return m;
  };

  const logVersion = nextMarker("log.version", "protocol-metadata");
  const logComment = nextMarker("log.comment", "comment");
  const logCustom = nextMarker("log.<custom>", "other-custom-field");

  const creatorName = nextMarker("log.creator.name", "protocol-metadata");
  const creatorVersion = nextMarker("log.creator.version", "protocol-metadata");
  const creatorComment = nextMarker("log.creator.comment", "comment");
  const creatorCustom = nextMarker("log.creator.<custom>", "other-custom-field");

  const browserName = nextMarker("log.browser.name", "protocol-metadata");
  const browserVersion = nextMarker("log.browser.version", "protocol-metadata");
  const browserComment = nextMarker("log.browser.comment", "comment");
  const browserCustom = nextMarker("log.browser.<custom>", "other-custom-field");

  const pageStarted = nextMarker("log.pages[].startedDateTime", "protocol-metadata");
  const pageId = nextMarker("log.pages[].id", "protocol-metadata");
  const pageTitleUserinfo = nextMarker("log.pages[].title", "request-url-userinfo");
  const pageTitleQuerySecret = nextMarker("log.pages[].title", "request-url-query-secret");
  const pageTitlePlain = nextMarker("log.pages[].title", "page-title");
  const pageComment = nextMarker("log.pages[].comment", "comment");
  const pageCustom = nextMarker("log.pages[].<custom>", "other-custom-field");
  const pageTimingsComment = nextMarker("log.pages[].pageTimings.comment", "comment");
  const pageTimingsCustom = nextMarker("log.pages[].pageTimings.<custom>", "other-custom-field");

  const entryPageref = nextMarker("entry.pageref", "protocol-metadata");
  const entryStarted = nextMarker("entry.startedDateTime", "protocol-metadata");
  const entryServerIp = nextMarker("entry.serverIPAddress", "other-custom-field");
  const entryConnection = nextMarker("entry.connection", "other-custom-field");
  const entryComment = nextMarker("entry.comment", "comment");
  const entrySecurityState = nextMarker("entry._securityState", "other-custom-field");
  const entryPriority = nextMarker("entry._priority", "other-custom-field");
  const entryResourceType = nextMarker("entry._resourceType", "other-custom-field");
  const entryFromCache = nextMarker("entry._fromCache", "other-custom-field");
  const entryConnectionId = nextMarker("entry._connectionId", "other-custom-field");
  const entryCustom = nextMarker("entry.<custom>", "other-custom-field");

  const initiatorType = nextMarker("entry._initiator.type", "initiator");
  const initiatorUrl = nextMarker("entry._initiator.url", "initiator");
  const initiatorRequestId = nextMarker("entry._initiator.requestId", "initiator");
  const frameFn = nextMarker("entry._initiator.stack.callFrames[].functionName", "initiator");
  const frameScript = nextMarker("entry._initiator.stack.callFrames[].scriptId", "initiator");
  const frameUrl = nextMarker("entry._initiator.stack.callFrames[].url", "initiator");

  const wsType = nextMarker("entry._webSocketMessages[].type", "websocket");
  const wsData = nextMarker("entry._webSocketMessages[].data", "websocket");
  const wsCustom = nextMarker("entry._webSocketMessages[].<custom>", "websocket");
  const initiatorCustom = nextMarker("entry._initiator.<custom>", "initiator");
  const stackCustom = nextMarker("entry._initiator.stack.<custom>", "initiator");
  const frameCustom = nextMarker("entry._initiator.stack.callFrames[].<custom>", "initiator");
  const exportSource = nextMarker("entry._harExport.source", "export-annotation");
  const exportBodyState = nextMarker("entry._harExport.bodyState", "export-annotation");
  const exportBodyMissing = nextMarker("entry._harExport.bodyMissing", "export-annotation");
  const exportBodyCheck = nextMarker("entry._harExport.bodyCheck", "export-annotation");
  const exportRedacted = nextMarker("entry._harExport.redactedFields", "redaction-record");
  const exportCustom = nextMarker("entry._harExport.<custom>", "other-custom-field");
  const logExportRedaction = nextMarker("log._harExport.redaction", "redaction-record");
  const logExportCustom = nextMarker("log._harExport.<custom>", "other-custom-field");

  const reqMethod = nextMarker("request.method", "protocol-metadata");
  const reqUrlUserinfo = nextMarker("request.url", "request-url-userinfo");
  const reqUrlHost = nextMarker("request.url", "request-url-host");
  const reqUrlPath = nextMarker("request.url", "request-url-path");
  const reqUrlQuerySecret = nextMarker("request.url", "request-url-query-secret");
  const reqUrlQueryOther = nextMarker("request.url", "request-url-query");
  const reqUrlFragment = nextMarker("request.url", "request-url-fragment");
  const reqHttpVersion = nextMarker("request.httpVersion", "protocol-metadata");
  const reqComment = nextMarker("request.comment", "comment");
  const reqCustom = nextMarker("request.<custom>", "other-custom-field");

  const reqCookieName = nextMarker("request.cookies[].name", "cookie-metadata");
  const reqCookieValue = nextMarker("request.cookies[].value", "cookie");
  const reqCookiePath = nextMarker("request.cookies[].path", "cookie-metadata");
  const reqCookieDomain = nextMarker("request.cookies[].domain", "cookie-metadata");
  const reqCookieExpires = nextMarker("request.cookies[].expires", "cookie-metadata");
  const reqCookieComment = nextMarker("request.cookies[].comment", "comment");
  const reqCookieCustom = nextMarker("request.cookies[].<custom>", "other-custom-field");

  const reqHeaderName = nextMarker("request.headers[].name", "header-name");
  const reqHeaderSecret = nextMarker("request.headers[].value", "header-value-secret");
  const reqHeaderAllowlisted = nextMarker("request.headers[].value", "header-value-allowlisted");
  const reqHeaderUrl = nextMarker("request.headers[].value", "url-header");
  const reqHeaderUrlUserinfo = nextMarker("request.headers[].value", "request-url-userinfo");
  const reqHeaderUrlQuerySecret = nextMarker("request.headers[].value", "request-url-query-secret");
  const reqHeaderNamed = nextMarker("request.headers[].value", "named-header");
  const reqHeaderComment = nextMarker("request.headers[].comment", "comment");
  const reqHeaderCustom = nextMarker("request.headers[].<custom>", "other-custom-field");

  const qsName = nextMarker("request.queryString[].name", "query-string");
  const qsSecret = nextMarker("request.queryString[].value", "query-string-secret");
  const qsOther = nextMarker("request.queryString[].value", "query-string");
  const qsComment = nextMarker("request.queryString[].comment", "comment");
  const qsCustom = nextMarker("request.queryString[].<custom>", "other-custom-field");

  const postMime = nextMarker("request.postData.mimeType", "protocol-metadata");
  const postTextJson = nextMarker("request.postData.text", "body-json");
  const postTextForm = nextMarker("request.postData.text", "body-form");
  const postTextMultipart = nextMarker("request.postData.text", "body-multipart");
  const postTextOther = nextMarker("request.postData.text", "request-body-other");
  const postComment = nextMarker("request.postData.comment", "comment");
  const postCustom = nextMarker("request.postData.<custom>", "other-custom-field");

  const paramName = nextMarker("request.postData.params[].name", "body-param");
  const paramSecret = nextMarker("request.postData.params[].value", "body-param-secret");
  const paramOther = nextMarker("request.postData.params[].value", "body-param");
  const paramFile = nextMarker("request.postData.params[].fileName", "body-param");
  const paramContentType = nextMarker("request.postData.params[].contentType", "body-param");
  const paramComment = nextMarker("request.postData.params[].comment", "comment");
  const paramCustom = nextMarker("request.postData.params[].<custom>", "other-custom-field");

  const resStatusText = nextMarker("response.statusText", "protocol-metadata");
  const resHttpVersion = nextMarker("response.httpVersion", "protocol-metadata");
  const resRedirectUrl = nextMarker("response.redirectURL", "redirect-url");
  const resRedirectUserinfo = nextMarker("response.redirectURL", "request-url-userinfo");
  const resRedirectQuerySecret = nextMarker("response.redirectURL", "request-url-query-secret");
  const resComment = nextMarker("response.comment", "comment");
  const resError = nextMarker("response._error", "other-custom-field");
  const resCustom = nextMarker("response.<custom>", "other-custom-field");

  const resCookieName = nextMarker("response.cookies[].name", "cookie-metadata");
  const resCookieValue = nextMarker("response.cookies[].value", "cookie");
  const resCookiePath = nextMarker("response.cookies[].path", "cookie-metadata");
  const resCookieDomain = nextMarker("response.cookies[].domain", "cookie-metadata");
  const resCookieExpires = nextMarker("response.cookies[].expires", "cookie-metadata");
  const resCookieComment = nextMarker("response.cookies[].comment", "comment");
  const resCookieCustom = nextMarker("response.cookies[].<custom>", "other-custom-field");

  const resHeaderName = nextMarker("response.headers[].name", "header-name");
  const resHeaderSecret = nextMarker("response.headers[].value", "header-value-secret");
  const resHeaderAllowlisted = nextMarker("response.headers[].value", "header-value-allowlisted");
  const resHeaderUrl = nextMarker("response.headers[].value", "url-header");
  const resHeaderUrlUserinfo = nextMarker("response.headers[].value", "request-url-userinfo");
  const resHeaderUrlQuerySecret = nextMarker(
    "response.headers[].value",
    "request-url-query-secret",
  );
  const resHeaderNamed = nextMarker("response.headers[].value", "named-header");
  const resHeaderComment = nextMarker("response.headers[].comment", "comment");
  const resHeaderCustom = nextMarker("response.headers[].<custom>", "other-custom-field");

  const contentMime = nextMarker("response.content.mimeType", "protocol-metadata");
  const contentTextJson = nextMarker("response.content.text", "response-body-json");
  const contentTextB64 = nextMarker("response.content.text", "response-body-base64");
  const contentTextOther = nextMarker("response.content.text", "response-body-other");
  const contentEncoding = nextMarker("response.content.encoding", "protocol-metadata");
  const contentComment = nextMarker("response.content.comment", "comment");
  const contentCustom = nextMarker("response.content.<custom>", "other-custom-field");

  const cacheComment = nextMarker("cache.comment", "comment");
  const cacheCustom = nextMarker("cache.<custom>", "other-custom-field");

  const beforeExpires = nextMarker("cache.beforeRequest.expires", "cache");
  const beforeLastAccess = nextMarker("cache.beforeRequest.lastAccess", "cache");
  const beforeLastFetched = nextMarker("cache.beforeRequest.lastFetched", "cache");
  const beforeETag = nextMarker("cache.beforeRequest.eTag", "cache");
  const beforeFetchCount = nextMarker("cache.beforeRequest.fetchCount", "cache");
  const beforeComment = nextMarker("cache.beforeRequest.comment", "cache");
  const beforeDataSize = nextMarker("cache.beforeRequest._dataSize", "cache");
  const beforeLastModified = nextMarker("cache.beforeRequest._lastModified", "cache");
  const beforeDevice = nextMarker("cache.beforeRequest._device", "cache");
  const beforeCustom = nextMarker("cache.beforeRequest.<custom>", "cache");

  const afterExpires = nextMarker("cache.afterRequest.expires", "cache");
  const afterLastAccess = nextMarker("cache.afterRequest.lastAccess", "cache");
  const afterLastFetched = nextMarker("cache.afterRequest.lastFetched", "cache");
  const afterETag = nextMarker("cache.afterRequest.eTag", "cache");
  const afterFetchCount = nextMarker("cache.afterRequest.fetchCount", "cache");
  const afterComment = nextMarker("cache.afterRequest.comment", "cache");
  const afterDataSize = nextMarker("cache.afterRequest._dataSize", "cache");
  const afterLastModified = nextMarker("cache.afterRequest._lastModified", "cache");
  const afterDevice = nextMarker("cache.afterRequest._device", "cache");
  const afterCustom = nextMarker("cache.afterRequest.<custom>", "cache");

  const timingsComment = nextMarker("timings.comment", "comment");
  const timingsCustom = nextMarker("timings.<custom>", "other-custom-field");

  const pages = [
    {
      startedDateTime: pageStarted,
      id: pageId,
      title: `https://user:${pageTitleUserinfo}@page.example/${pageTitlePlain}?token=${pageTitleQuerySecret}`,
      pageTimings: {
        onContentLoad: 10,
        onLoad: 20,
        comment: pageTimingsComment,
        _customPageTimings: pageTimingsCustom,
      },
      comment: pageComment,
      _customPage: pageCustom,
    },
    {
      startedDateTime: "2026-01-01T00:00:00.000Z",
      id: entryPageref,
      title: "https://page.example/second",
      pageTimings: { onContentLoad: -1, onLoad: -1 },
    },
    {
      startedDateTime: "2026-01-01T00:00:00.000Z",
      id: "p_base",
      title: "https://page.example/base",
      pageTimings: { onContentLoad: -1, onLoad: -1 },
    },
  ];

  const mainEntry = {
    pageref: entryPageref,
    startedDateTime: entryStarted,
    time: 10,
    request: {
      method: reqMethod,
      url: `https://user:${reqUrlUserinfo}@${reqUrlHost}/${reqUrlPath}?access_token=${reqUrlQuerySecret}&note=${reqUrlQueryOther}#${reqUrlFragment}`,
      httpVersion: reqHttpVersion,
      cookies: [
        {
          name: reqCookieName,
          value: reqCookieValue,
          path: reqCookiePath,
          domain: reqCookieDomain,
          expires: reqCookieExpires,
          comment: reqCookieComment,
          _customReqCookie: reqCookieCustom,
        },
      ],
      headers: [
        {
          name: reqHeaderName,
          value: reqHeaderNamed,
          comment: reqHeaderComment,
          _customReqHeader: reqHeaderCustom,
        },
        { name: "Authorization", value: reqHeaderSecret },
        { name: "Content-Type", value: `application/json; extra=${reqHeaderAllowlisted}` },
        { name: "Referer", value: reqHeaderUrl },
        {
          name: "Referer",
          value: `https://user:${reqHeaderUrlUserinfo}@ref.example/?token=${reqHeaderUrlQuerySecret}`,
        },
      ],
      queryString: [
        {
          name: qsName,
          value: qsOther,
          comment: qsComment,
          _customQuery: qsCustom,
        },
        { name: "access_token", value: qsSecret },
      ],
      postData: {
        mimeType: `application/json; boundary=${postMime}`,
        params: [
          {
            name: paramName,
            value: paramOther,
            fileName: paramFile,
            contentType: `text/plain; v=${paramContentType}`,
            comment: paramComment,
            _customParam: paramCustom,
          },
          { name: "password", value: paramSecret },
        ],
        text: JSON.stringify({ key: postTextJson }),
        comment: postComment,
        _customPostData: postCustom,
      },
      headersSize: 100,
      bodySize: 50,
      comment: reqComment,
      _customRequest: reqCustom,
    },
    response: {
      status: 200,
      statusText: resStatusText,
      httpVersion: resHttpVersion,
      cookies: [
        {
          name: resCookieName,
          value: resCookieValue,
          path: resCookiePath,
          domain: resCookieDomain,
          expires: resCookieExpires,
          comment: resCookieComment,
          _customResCookie: resCookieCustom,
        },
      ],
      headers: [
        {
          name: resHeaderName,
          value: resHeaderNamed,
          comment: resHeaderComment,
          _customResHeader: resHeaderCustom,
        },
        { name: "Set-Cookie", value: resHeaderSecret },
        { name: "Content-Length", value: resHeaderAllowlisted },
        { name: "Location", value: resHeaderUrl },
        {
          name: "Location",
          value: `https://user:${resHeaderUrlUserinfo}@next.example/?token=${resHeaderUrlQuerySecret}`,
        },
      ],
      content: {
        size: 50,
        mimeType: `application/json; v=${contentMime}`,
        text: JSON.stringify({ data: contentTextJson }),
        encoding: contentEncoding,
        comment: contentComment,
        _customContent: contentCustom,
      },
      redirectURL: `https://user:${resRedirectUserinfo}@redirect.example/${resRedirectUrl}?token=${resRedirectQuerySecret}`,
      headersSize: 80,
      bodySize: 50,
      comment: resComment,
      _error: resError,
      _customResponse: resCustom,
    },
    cache: {
      beforeRequest: {
        expires: beforeExpires,
        lastAccess: beforeLastAccess,
        lastFetched: beforeLastFetched,
        eTag: beforeETag,
        fetchCount: beforeFetchCount,
        comment: beforeComment,
        _dataSize: beforeDataSize,
        _lastModified: beforeLastModified,
        _device: beforeDevice,
        _customBefore: beforeCustom,
      },
      afterRequest: {
        expires: afterExpires,
        lastAccess: afterLastAccess,
        lastFetched: afterLastFetched,
        eTag: afterETag,
        fetchCount: afterFetchCount,
        comment: afterComment,
        _dataSize: afterDataSize,
        _lastModified: afterLastModified,
        _device: afterDevice,
        _customAfter: afterCustom,
      },
      comment: cacheComment,
      _customCache: cacheCustom,
    },
    timings: {
      send: 1,
      wait: 2,
      receive: 3,
      comment: timingsComment,
      _customTimings: timingsCustom,
    },
    serverIPAddress: entryServerIp,
    connection: entryConnection,
    comment: entryComment,
    _securityState: entrySecurityState,
    _priority: entryPriority,
    _initiator: {
      type: initiatorType,
      url: initiatorUrl,
      requestId: initiatorRequestId,
      stack: {
        callFrames: [
          {
            functionName: frameFn,
            scriptId: frameScript,
            url: frameUrl,
            lineNumber: 1,
            columnNumber: 1,
            _frameNote: frameCustom,
          },
        ],
        description: stackCustom,
      },
      _initiatorNote: initiatorCustom,
    },
    _resourceType: entryResourceType,
    _fromCache: entryFromCache,
    _connectionId: entryConnectionId,
    _webSocketMessages: [
      {
        type: wsType,
        time: 1,
        opcode: 1,
        data: wsData,
        _frameNote: wsCustom,
      },
    ],
    _customEntry: entryCustom,
    _harExport: {
      source: exportSource,
      bodyState: exportBodyState,
      bodyMissing: exportBodyMissing,
      bodyIncomplete: false,
      bodyCheck: exportBodyCheck,
      redactedFields: [exportRedacted],
      capturedBy: exportCustom,
    },
  };

  const formEntry = baseEntry(1);
  (formEntry.request as Record<string, unknown>).method = "POST";
  (formEntry.request as Record<string, unknown>).postData = {
    mimeType: "application/x-www-form-urlencoded",
    params: [],
    text: `password=${postTextForm}`,
  };
  (formEntry.response as Record<string, unknown>).content = {
    size: 40,
    mimeType: "application/json",
    encoding: "base64",
    text: encodeAsciiBase64(JSON.stringify({ b64: contentTextB64 })),
  };

  const multipartEntry = baseEntry(2);
  (multipartEntry.request as Record<string, unknown>).method = "POST";
  (multipartEntry.request as Record<string, unknown>).postData = {
    mimeType: "multipart/form-data; boundary=B",
    params: [],
    text: `--B\r\nContent-Disposition: form-data; name="password"\r\n\r\n${postTextMultipart}\r\n--B--`,
  };
  (multipartEntry.response as Record<string, unknown>).content = {
    size: 20,
    mimeType: "text/html",
    text: `<p>${contentTextOther}</p>`,
  };

  const otherBodyEntry = baseEntry(
    3,
    `data:text/plain,${nextMarker("request.url", "request-url-opaque")}`,
  );
  (otherBodyEntry.request as Record<string, unknown>).method = "POST";
  (otherBodyEntry.request as Record<string, unknown>).postData = {
    mimeType: "text/plain",
    params: [],
    text: `raw ${postTextOther}`,
  };

  const parsed = parseHar({
    log: {
      version: logVersion,
      creator: {
        name: creatorName,
        version: creatorVersion,
        comment: creatorComment,
        _customCreator: creatorCustom,
      },
      browser: {
        name: browserName,
        version: browserVersion,
        comment: browserComment,
        _customBrowser: browserCustom,
      },
      pages,
      entries: [mainEntry, formEntry, multipartEntry, otherBodyEntry],
      comment: logComment,
      _customLog: logCustom,
      _harExport: {
        redaction: { applied: true, level: "shareable", guarantee: logExportRedaction },
        exportedBy: logExportCustom,
      },
    },
  });
  if (!parsed.ok) {
    throw new Error(
      `Failed to parse marker document: ${parsed.problems.map((p) => `${p.path} ${p.rule}`).join(", ")}`,
    );
  }

  for (const [field, place, path, value] of NUMBER_MARKERS) {
    markedFields.add(field);
    setAt(parsed.document, path, value);
    markers.push({ field, place, marker: `${path.join(".")}=${String(value)}`, path, value });
  }

  // Parse replaces text in a number field, so this marker goes in after parse, as a caller that
  // skips parse would pass it.
  const malformed = "MARKER_text_in_timings_ssl";
  markers.push({ field: "timings.ssl", place: "wrong-type", marker: malformed });
  setAt(parsed.document, ["log", "entries", 1, "timings", "ssl"], malformed);

  return { document: parsed.document, markers, markedFields };
}

function haystackFor(document: HarDocument): string {
  const b64Texts = document.log.entries
    .filter((entry) => entry.response.content.encoding === "base64" && entry.response.content.text)
    .map((entry) => decodeAsciiBase64(entry.response.content.text ?? ""));
  return `${JSON.stringify(document)}\n${b64Texts.join("\n")}`;
}
