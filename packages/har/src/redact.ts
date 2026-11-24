import { OWNED_FIELDS, safeDecodeQueryComponent } from "./internal.ts";
import { DEFAULT_REDACTION_RULES, type HarRedactionRule } from "./rules.ts";
import { parseUrl, type UrlParts, type UrlSpan } from "./url-standard.ts";
import {
  HAR_REDACTION_PLACES,
  isHarUrl,
  toIsoDateTime,
  toPageId,
  type HarCache,
  type HarContent,
  type HarCookie,
  type HarCreator,
  type HarDocument,
  type HarEntry,
  type HarEntryExtension,
  type HarLogRedactionExtension,
  type HarModelField,
  type HarModelFieldIsOptional,
  type HarModelFieldValues,
  type HarModelItemKind,
  type HarModelKind,
  type HarValueKind,
  type IsExactly,
  type HarNameValue,
  type HarPage,
  type HarPlaceCoverage,
  type HarPostData,
  type HarPostDataParam,
  type HarRedactionPlace,
  type HarRedactionRecord,
  type HarRedactionTarget,
  type HarTimings,
  type HarUrl,
  type IsoDateTime,
  type MimeType,
  type PageId,
  type PlaceExamStatus,
  type PlaceReportDetail,
  type RedactionLevel,
  type RedactionLevelInput,
} from "./model.ts";

export interface HarPlaceRule {
  readonly place: HarRedactionPlace;
  readonly standard: "removed" | "kept-not-examined";
  readonly shareable: "removed" | "kept-by-allowlist";
  readonly label: string;
  // Under `standard` a selected place is removed only while a rule of this target is in force, and its
  // label names what those rules select.
  readonly selectedBy?:
    | { readonly target: HarRedactionTarget; readonly byName: boolean }
    | undefined;
  readonly listedNames?: ReadonlySet<string> | undefined;
}

export interface HarModelFieldSpec {
  readonly kinds: readonly HarValueKind[];
  readonly places: readonly HarRedactionPlace[];
  // What a required field holds once its value is removed. An optional field is deleted instead.
  readonly whenRemoved?: unknown;
  readonly items?: HarValueKind | undefined;
  // Where the fields of this object, or of its array items, are listed when not under its own path.
  readonly children?: string | undefined;
  // The object is one place, kept or removed whole, so its removal never leaves an object missing
  // members HAR 1.2 requires.
  readonly wholePlace?: true | undefined;
}

export type HarModelFieldRow<F extends HarModelField = HarModelField> = HarModelFieldSpec & {
  readonly field: F;
};

export interface RedactHarOptions {
  readonly rules?: readonly HarRedactionRule[] | undefined;
  readonly extraRules?: readonly HarRedactionRule[] | undefined;
  readonly replacement?: string | undefined;
  readonly level?: RedactionLevelInput | undefined;
  readonly placeTable?: Readonly<Record<HarRedactionPlace, HarPlaceRule>> | undefined;
}

export interface RedactHarResult {
  readonly document: HarDocument;
  readonly report: HarLogRedactionExtension;
}

export interface RedactHarEntryResult {
  readonly entry: HarEntry;
  readonly url: HarUrl;
  readonly touched: boolean;
  readonly records: readonly HarRedactionRecord[];
  readonly covered: readonly HarRedactionPlace[];
  readonly places: readonly HarPlaceCoverage[];
}

export interface RedactUrlResult {
  readonly url: string;
  readonly touched: boolean;
  readonly records: readonly HarRedactionRecord[];
}

export const ALLOWLISTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "vary",
  "upgrade",
]);

export const URL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "location",
  "referer",
  "referrer",
  ":path",
  "link",
  "refresh",
  "origin",
  "content-location",
]);

export const HAR_PLACE_TABLE: {
  readonly [P in HarRedactionPlace]: HarPlaceRule & { readonly place: P };
} = {
  "request-url-userinfo": {
    place: "request-url-userinfo",
    standard: "removed",
    shareable: "removed",
    label:
      "the username and password of request URLs, and of page titles, URL header values and redirect URLs that are a URL, as the URL Standard parses them, including the URL inside up to 3 blob:, view-source:, jar: or filesystem: wrappers",
    selectedBy: { target: "url-userinfo", byName: false },
  },
  "request-url-host": {
    place: "request-url-host",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "the scheme, host and port of request URLs",
  },
  "request-url-path": {
    place: "request-url-path",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "the path of request URLs",
  },
  "request-url-query-secret": {
    place: "request-url-query-secret",
    standard: "removed",
    shareable: "removed",
    label:
      "values of query parameters in request URLs, URL page titles, URL header values and redirect URLs",
    selectedBy: { target: "query", byName: true },
  },
  "request-url-query": {
    place: "request-url-query",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "query parameter names and every other query value in request URLs",
  },
  "request-url-opaque": {
    place: "request-url-opaque",
    standard: "kept-not-examined",
    shareable: "removed",
    label:
      "the content after the scheme of request URLs that have no host, such as data:, mailto:, about: and javascript: URLs, which becomes redacted when removed",
  },
  "request-url-fragment": {
    place: "request-url-fragment",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "the fragment of request URLs",
  },
  "header-name": {
    place: "header-name",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "header names",
  },
  "header-value-secret": {
    place: "header-value-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of request and response headers",
    selectedBy: { target: "header", byName: true },
  },
  "header-value-allowlisted": {
    place: "header-value-allowlisted",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "values of headers",
    listedNames: ALLOWLISTED_HEADER_NAMES,
  },
  "named-header": {
    place: "named-header",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "values of every header not named in another place",
  },
  "url-header": {
    place: "url-header",
    standard: "kept-not-examined",
    shareable: "removed",
    label:
      "values of headers, which are not examined unless the whole value is a URL with no space or control character",
    listedNames: URL_HEADER_NAMES,
  },
  cookie: {
    place: "cookie",
    standard: "removed",
    shareable: "removed",
    label: "cookie values",
    selectedBy: { target: "cookie", byName: false },
  },
  "cookie-metadata": {
    place: "cookie-metadata",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "cookie names, paths, domains, expiry dates and flags",
  },
  "query-string-secret": {
    place: "query-string-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of queryString items",
    selectedBy: { target: "query", byName: true },
  },
  "query-string": {
    place: "query-string",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "queryString item names and every other queryString value",
  },
  "body-param-secret": {
    place: "body-param-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of postData params",
    selectedBy: { target: "body", byName: true },
  },
  "body-param": {
    place: "body-param",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "postData param names, file names, content types and every other param value",
  },
  "body-json": {
    place: "body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "JSON request bodies",
  },
  "body-form": {
    place: "body-form",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "form-encoded request bodies",
  },
  "body-multipart": {
    place: "body-multipart",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "multipart request bodies",
  },
  "request-body-other": {
    place: "request-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "every other request body",
  },
  "redirect-url": {
    place: "redirect-url",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "the rest of redirect URLs",
  },
  "response-body-json": {
    place: "response-body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "JSON response bodies",
  },
  "response-body-base64": {
    place: "response-body-base64",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "base64 response bodies",
  },
  "response-body-other": {
    place: "response-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "every other response body",
  },
  "page-title": {
    place: "page-title",
    standard: "kept-not-examined",
    shareable: "removed",
    label:
      "page titles, which are text and not examined unless the whole title is a URL with no space or control character",
  },
  initiator: {
    place: "initiator",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "request initiators and their call stacks",
  },
  websocket: {
    place: "websocket",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "WebSocket messages",
  },
  cache: {
    place: "cache",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "cache entries in cache.beforeRequest and cache.afterRequest, kept or removed whole",
  },
  comment: {
    place: "comment",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "comments",
  },
  "other-custom-field": {
    place: "other-custom-field",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "custom and unknown fields from any tool, server IP addresses and connection ids",
  },
  "protocol-metadata": {
    place: "protocol-metadata",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label:
      "the HAR version, creator and browser names and versions, page ids, start times, page references, methods, HTTP versions, status text, MIME types and content encodings",
  },
  "export-annotation": {
    place: "export-annotation",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "body state, body source and missing-body notes written by the export",
  },
  "redaction-record": {
    place: "redaction-record",
    standard: "removed",
    shareable: "removed",
    label: "redaction records from an earlier run, replaced by this run's records",
  },
  measurement: {
    place: "measurement",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "sizes, timings, status codes and the other numbers HAR 1.2 defines",
  },
  "wrong-type": {
    place: "wrong-type",
    standard: "removed",
    shareable: "removed",
    label:
      "values whose JSON type is not the one the HAR model gives their field, and request URLs that are not URLs by the URL Standard, wrap more than 3 URLs, or are not URLs once redacted",
  },
};

const REDACTED_URL = "https://redacted.invalid/";

const REQUEST_WHEN_REMOVED = {
  method: "",
  url: REDACTED_URL,
  httpVersion: "",
  cookies: [],
  headers: [],
  queryString: [],
  headersSize: -1,
  bodySize: -1,
};

const RESPONSE_WHEN_REMOVED = {
  status: 0,
  statusText: "",
  httpVersion: "",
  cookies: [],
  headers: [],
  content: { size: -1, mimeType: "" },
  redirectURL: "",
  headersSize: -1,
  bodySize: -1,
};

// One row for every key of every model interface, at every depth. The type checks below fail when a
// key has no row, or when a row's kinds, item kind or removal value disagree with the model type.
const HAR_MODEL_ROWS = {
  "log.version": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "1.2" },
  "log.creator": { kinds: ["object"], places: [], whenRemoved: { name: "redacted", version: "0" } },
  "log.browser": { kinds: ["object"], places: [] },
  "log.pages": { kinds: ["array"], places: [], items: "object" },
  "log.entries": {
    kinds: ["array"],
    places: [],
    whenRemoved: [],
    items: "object",
    children: "entry",
  },
  "log.comment": { kinds: ["string"], places: ["comment"] },
  "log._harExport": { kinds: ["object"], places: [] },
  "log._harExportId": { kinds: ["string"], places: [] },
  "log.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "log.creator.name": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "redacted" },
  "log.creator.version": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "0" },
  "log.creator.comment": { kinds: ["string"], places: ["comment"] },
  "log.creator.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "log.browser.name": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "redacted" },
  "log.browser.version": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "0" },
  "log.browser.comment": { kinds: ["string"], places: ["comment"] },
  "log.browser.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "log.pages[].startedDateTime": {
    kinds: ["string"],
    places: ["protocol-metadata"],
    whenRemoved: "1970-01-01T00:00:00.000Z",
  },
  "log.pages[].id": {
    kinds: ["string"],
    places: ["protocol-metadata"],
    whenRemoved: "page_redacted",
  },
  "log.pages[].title": {
    kinds: ["string"],
    places: ["request-url-userinfo", "request-url-query-secret", "page-title"],
    whenRemoved: "",
  },
  "log.pages[].pageTimings": { kinds: ["object"], places: [], whenRemoved: {} },
  "log.pages[].comment": { kinds: ["string"], places: ["comment"] },
  "log.pages[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "log.pages[].pageTimings.onContentLoad": { kinds: ["number"], places: ["measurement"] },
  "log.pages[].pageTimings.onLoad": { kinds: ["number"], places: ["measurement"] },
  "log.pages[].pageTimings.comment": { kinds: ["string"], places: ["comment"] },
  "log.pages[].pageTimings.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "log._harExport.redaction": { kinds: ["object"], places: ["redaction-record"] },
  "log._harExport.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "entry.pageref": { kinds: ["string"], places: ["protocol-metadata"] },
  "entry.startedDateTime": {
    kinds: ["string"],
    places: ["protocol-metadata"],
    whenRemoved: "1970-01-01T00:00:00.000Z",
  },
  "entry.time": { kinds: ["number"], places: ["measurement"], whenRemoved: 0 },
  "entry.request": {
    kinds: ["object"],
    places: [],
    whenRemoved: REQUEST_WHEN_REMOVED,
    children: "request",
  },
  "entry.response": {
    kinds: ["object"],
    places: [],
    whenRemoved: RESPONSE_WHEN_REMOVED,
    children: "response",
  },
  "entry.cache": { kinds: ["object"], places: [], whenRemoved: {}, children: "cache" },
  "entry.timings": {
    kinds: ["object"],
    places: [],
    whenRemoved: { send: 0, wait: 0, receive: 0 },
    children: "timings",
  },
  "entry.serverIPAddress": { kinds: ["string"], places: ["other-custom-field"] },
  "entry.connection": { kinds: ["string"], places: ["other-custom-field"] },
  "entry.comment": { kinds: ["string"], places: ["comment"] },
  "entry._securityState": { kinds: ["string"], places: ["other-custom-field"] },
  "entry._priority": { kinds: ["string"], places: ["other-custom-field"] },
  "entry._initiator": { kinds: ["object"], places: ["initiator"], wholePlace: true },
  "entry._resourceType": { kinds: ["string"], places: ["other-custom-field"] },
  "entry._fromCache": { kinds: ["string"], places: ["other-custom-field"] },
  "entry._connectionId": { kinds: ["string"], places: ["other-custom-field"] },
  "entry._webSocketMessages": {
    kinds: ["array"],
    places: ["websocket"],
    items: "object",
    wholePlace: true,
  },
  "entry._harExport": { kinds: ["object"], places: [] },
  "entry.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "entry._initiator.type": { kinds: ["string"], places: ["initiator"], whenRemoved: "" },
  "entry._initiator.url": { kinds: ["string"], places: ["initiator"] },
  "entry._initiator.lineNumber": { kinds: ["number"], places: ["initiator"] },
  "entry._initiator.columnNumber": { kinds: ["number"], places: ["initiator"] },
  "entry._initiator.requestId": { kinds: ["string"], places: ["initiator"] },
  "entry._initiator.stack": { kinds: ["object"], places: ["initiator"] },
  "entry._initiator.<custom>": { kinds: ["unknown"], places: ["initiator"] },
  "entry._initiator.stack.callFrames": {
    kinds: ["array"],
    places: ["initiator"],
    whenRemoved: [],
    items: "object",
  },
  "entry._initiator.stack.parent": {
    kinds: ["object"],
    places: ["initiator"],
    children: "entry._initiator.stack",
  },
  "entry._initiator.stack.<custom>": { kinds: ["unknown"], places: ["initiator"] },
  "entry._initiator.stack.callFrames[].functionName": {
    kinds: ["string"],
    places: ["initiator"],
    whenRemoved: "",
  },
  "entry._initiator.stack.callFrames[].scriptId": {
    kinds: ["string"],
    places: ["initiator"],
    whenRemoved: "",
  },
  "entry._initiator.stack.callFrames[].url": {
    kinds: ["string"],
    places: ["initiator"],
    whenRemoved: "",
  },
  "entry._initiator.stack.callFrames[].lineNumber": {
    kinds: ["number"],
    places: ["initiator"],
    whenRemoved: 0,
  },
  "entry._initiator.stack.callFrames[].columnNumber": {
    kinds: ["number"],
    places: ["initiator"],
    whenRemoved: 0,
  },
  "entry._initiator.stack.callFrames[].<custom>": { kinds: ["unknown"], places: ["initiator"] },
  "entry._webSocketMessages[].type": {
    kinds: ["string"],
    places: ["websocket"],
    whenRemoved: "receive",
  },
  "entry._webSocketMessages[].time": { kinds: ["number"], places: ["websocket"], whenRemoved: 0 },
  "entry._webSocketMessages[].opcode": { kinds: ["number"], places: ["websocket"], whenRemoved: 0 },
  "entry._webSocketMessages[].data": { kinds: ["string"], places: ["websocket"], whenRemoved: "" },
  "entry._webSocketMessages[].<custom>": { kinds: ["unknown"], places: ["websocket"] },
  "entry._harExport.source": { kinds: ["string"], places: ["export-annotation"] },
  "entry._harExport.bodyState": { kinds: ["string"], places: ["export-annotation"] },
  "entry._harExport.bodyMissing": { kinds: ["string"], places: ["export-annotation"] },
  "entry._harExport.bodyIncomplete": { kinds: ["boolean"], places: ["export-annotation"] },
  "entry._harExport.bodyCheck": { kinds: ["string"], places: ["export-annotation"] },
  "entry._harExport.lossyText": { kinds: ["number"], places: ["export-annotation"] },
  "entry._harExport.inProgress": { kinds: ["boolean"], places: ["export-annotation"] },
  "entry._harExport.redactedFields": {
    kinds: ["array"],
    places: ["redaction-record"],
    items: "string",
  },
  "entry._harExport.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.method": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "" },
  "request.url": {
    kinds: ["string"],
    places: [
      "request-url-userinfo",
      "request-url-host",
      "request-url-path",
      "request-url-query-secret",
      "request-url-query",
      "request-url-fragment",
      "request-url-opaque",
    ],
    whenRemoved: "https://redacted.invalid/",
  },
  "request.httpVersion": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "" },
  "request.cookies": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "request.headers": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "request.queryString": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "request.postData": { kinds: ["object"], places: [] },
  "request.headersSize": { kinds: ["number"], places: ["measurement"], whenRemoved: -1 },
  "request.bodySize": { kinds: ["number"], places: ["measurement"], whenRemoved: -1 },
  "request.comment": { kinds: ["string"], places: ["comment"] },
  "request.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.cookies[].name": { kinds: ["string"], places: ["cookie-metadata"], whenRemoved: "" },
  "request.cookies[].value": { kinds: ["string"], places: ["cookie"], whenRemoved: "" },
  "request.cookies[].path": { kinds: ["string"], places: ["cookie-metadata"] },
  "request.cookies[].domain": { kinds: ["string"], places: ["cookie-metadata"] },
  "request.cookies[].expires": { kinds: ["string", "null"], places: ["cookie-metadata"] },
  "request.cookies[].httpOnly": { kinds: ["boolean"], places: ["cookie-metadata"] },
  "request.cookies[].secure": { kinds: ["boolean"], places: ["cookie-metadata"] },
  "request.cookies[].comment": { kinds: ["string"], places: ["comment"] },
  "request.cookies[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.headers[].name": { kinds: ["string"], places: ["header-name"], whenRemoved: "" },
  "request.headers[].value": {
    kinds: ["string"],
    places: [
      "header-value-secret",
      "header-value-allowlisted",
      "url-header",
      "named-header",
      "request-url-userinfo",
      "request-url-query-secret",
    ],
    whenRemoved: "",
  },
  "request.headers[].comment": { kinds: ["string"], places: ["comment"] },
  "request.headers[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.queryString[].name": { kinds: ["string"], places: ["query-string"], whenRemoved: "" },
  "request.queryString[].value": {
    kinds: ["string"],
    places: ["query-string-secret", "query-string"],
    whenRemoved: "",
  },
  "request.queryString[].comment": { kinds: ["string"], places: ["comment"] },
  "request.queryString[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.postData.mimeType": {
    kinds: ["string"],
    places: ["protocol-metadata"],
    whenRemoved: "",
  },
  "request.postData.params": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "request.postData.text": {
    kinds: ["string", "null"],
    places: ["body-json", "body-form", "body-multipart", "request-body-other"],
    whenRemoved: "",
  },
  "request.postData.comment": { kinds: ["string"], places: ["comment"] },
  "request.postData.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "request.postData.params[].name": { kinds: ["string"], places: ["body-param"], whenRemoved: "" },
  "request.postData.params[].value": {
    kinds: ["string"],
    places: ["body-param-secret", "body-param"],
  },
  "request.postData.params[].fileName": { kinds: ["string"], places: ["body-param"] },
  "request.postData.params[].contentType": { kinds: ["string"], places: ["body-param"] },
  "request.postData.params[].comment": { kinds: ["string"], places: ["comment"] },
  "request.postData.params[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "response.status": { kinds: ["number"], places: ["measurement"], whenRemoved: 0 },
  "response.statusText": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "" },
  "response.httpVersion": { kinds: ["string"], places: ["protocol-metadata"], whenRemoved: "" },
  "response.cookies": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "response.headers": { kinds: ["array"], places: [], whenRemoved: [], items: "object" },
  "response.content": { kinds: ["object"], places: [], whenRemoved: { size: -1, mimeType: "" } },
  "response.redirectURL": {
    kinds: ["string"],
    places: ["redirect-url", "request-url-userinfo", "request-url-query-secret"],
    whenRemoved: "",
  },
  "response.headersSize": { kinds: ["number"], places: ["measurement"], whenRemoved: -1 },
  "response.bodySize": { kinds: ["number"], places: ["measurement"], whenRemoved: -1 },
  "response.comment": { kinds: ["string"], places: ["comment"] },
  "response._transferSize": { kinds: ["number"], places: ["other-custom-field"] },
  "response._error": { kinds: ["string", "null"], places: ["other-custom-field"] },
  "response.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "response.cookies[].name": { kinds: ["string"], places: ["cookie-metadata"], whenRemoved: "" },
  "response.cookies[].value": { kinds: ["string"], places: ["cookie"], whenRemoved: "" },
  "response.cookies[].path": { kinds: ["string"], places: ["cookie-metadata"] },
  "response.cookies[].domain": { kinds: ["string"], places: ["cookie-metadata"] },
  "response.cookies[].expires": { kinds: ["string", "null"], places: ["cookie-metadata"] },
  "response.cookies[].httpOnly": { kinds: ["boolean"], places: ["cookie-metadata"] },
  "response.cookies[].secure": { kinds: ["boolean"], places: ["cookie-metadata"] },
  "response.cookies[].comment": { kinds: ["string"], places: ["comment"] },
  "response.cookies[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "response.headers[].name": { kinds: ["string"], places: ["header-name"], whenRemoved: "" },
  "response.headers[].value": {
    kinds: ["string"],
    places: [
      "header-value-secret",
      "header-value-allowlisted",
      "url-header",
      "named-header",
      "request-url-userinfo",
      "request-url-query-secret",
    ],
    whenRemoved: "",
  },
  "response.headers[].comment": { kinds: ["string"], places: ["comment"] },
  "response.headers[].<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "response.content.size": { kinds: ["number"], places: ["measurement"], whenRemoved: -1 },
  "response.content.compression": { kinds: ["number"], places: ["measurement"] },
  "response.content.mimeType": {
    kinds: ["string"],
    places: ["protocol-metadata"],
    whenRemoved: "",
  },
  "response.content.text": {
    kinds: ["string"],
    places: ["response-body-json", "response-body-base64", "response-body-other"],
  },
  "response.content.encoding": { kinds: ["string"], places: ["protocol-metadata"] },
  "response.content.comment": { kinds: ["string"], places: ["comment"] },
  "response.content.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "cache.beforeRequest": { kinds: ["object", "null"], places: ["cache"], wholePlace: true },
  "cache.afterRequest": { kinds: ["object", "null"], places: ["cache"], wholePlace: true },
  "cache.comment": { kinds: ["string"], places: ["comment"] },
  "cache.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
  "cache.beforeRequest.expires": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest.lastAccess": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest.lastFetched": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest.eTag": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest.hitCount": { kinds: ["number"], places: ["cache"] },
  "cache.beforeRequest.fetchCount": { kinds: ["string", "number"], places: ["cache"] },
  "cache.beforeRequest.comment": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest._dataSize": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest._lastModified": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest._device": { kinds: ["string"], places: ["cache"] },
  "cache.beforeRequest.<custom>": { kinds: ["unknown"], places: ["cache"] },
  "cache.afterRequest.expires": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest.lastAccess": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest.lastFetched": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest.eTag": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest.hitCount": { kinds: ["number"], places: ["cache"] },
  "cache.afterRequest.fetchCount": { kinds: ["string", "number"], places: ["cache"] },
  "cache.afterRequest.comment": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest._dataSize": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest._lastModified": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest._device": { kinds: ["string"], places: ["cache"] },
  "cache.afterRequest.<custom>": { kinds: ["unknown"], places: ["cache"] },
  "timings.blocked": { kinds: ["number"], places: ["measurement"] },
  "timings.dns": { kinds: ["number"], places: ["measurement"] },
  "timings.connect": { kinds: ["number"], places: ["measurement"] },
  "timings.send": { kinds: ["number"], places: ["measurement"], whenRemoved: 0 },
  "timings.wait": { kinds: ["number"], places: ["measurement"], whenRemoved: 0 },
  "timings.receive": { kinds: ["number"], places: ["measurement"], whenRemoved: 0 },
  "timings.ssl": { kinds: ["number"], places: ["measurement"] },
  "timings.comment": { kinds: ["string"], places: ["comment"] },
  "timings._blocked_queueing": { kinds: ["number"], places: ["other-custom-field"] },
  "timings._blocked_proxy": { kinds: ["number"], places: ["other-custom-field"] },
  "timings._workerStart": { kinds: ["number"], places: ["other-custom-field"] },
  "timings._workerReady": { kinds: ["number"], places: ["other-custom-field"] },
  "timings._workerFetchStart": { kinds: ["number"], places: ["other-custom-field"] },
  "timings._workerRespondWithSettled": { kinds: ["number"], places: ["other-custom-field"] },
  "timings.<custom>": { kinds: ["unknown"], places: ["other-custom-field"] },
} as const satisfies { readonly [F in HarModelField]: HarModelFieldSpec };

type Rows = typeof HAR_MODEL_ROWS;
type KindsDisagree = {
  [F in HarModelField]: IsExactly<Rows[F]["kinds"][number], HarModelKind<F>> extends true
    ? never
    : F;
}[HarModelField];
type ItemsDisagree = {
  [F in HarModelField]: IsExactly<
    Rows[F] extends { readonly items: infer Item } ? Item : never,
    HarModelItemKind<F>
  > extends true
    ? never
    : F;
}[HarModelField];
// A removal value is plain JSON, so a branded string in the model type is checked as a string.
type Unbranded<V> = V extends IsoDateTime | HarUrl | PageId | MimeType
  ? string
  : V extends readonly (infer Item)[]
    ? readonly Unbranded<Item>[]
    : V extends object
      ? { readonly [K in keyof V]: Unbranded<V[K]> }
      : V;
type RemovalDisagrees = {
  [F in HarModelField]: HarModelFieldIsOptional<F> extends (
    "whenRemoved" extends keyof Rows[F] ? false : true
  )
    ? Rows[F] extends { readonly whenRemoved: infer Removed }
      ? [Removed] extends [Unbranded<HarModelFieldValues[F]>]
        ? never
        : F
      : never
    : F;
}[HarModelField];
type RowsDisagree = KindsDisagree | ItemsDisagree | RemovalDisagrees;
const _assertRowsMatchModel: [RowsDisagree] extends [never] ? true : RowsDisagree = true;
void _assertRowsMatchModel;

type PlaceOf<F extends HarModelField> = Rows[F]["places"][number] | "wrong-type";
type FieldIn<P extends HarRedactionPlace> = {
  [F in HarModelField]: P extends PlaceOf<F> ? F : never;
}[HarModelField];

type UnmappedPlaces = Exclude<HarRedactionPlace, PlaceOf<HarModelField>>;
const _assertEveryPlaceMappedToModelField: UnmappedPlaces extends never ? true : never = true;
void _assertEveryPlaceMappedToModelField;

// Every field whose kind the model fixes can also land in `wrong-type`.
export const HAR_MODEL_FIELD_TABLE = Object.fromEntries(
  Object.entries(HAR_MODEL_ROWS).map(([field, row]: [string, HarModelFieldSpec]) => [
    field,
    {
      ...row,
      field,
      places: row.kinds.includes("unknown") ? row.places : [...row.places, "wrong-type"],
    },
  ]),
) as { readonly [F in HarModelField]: HarModelFieldRow<F> };

const FIELDS_BY_PLACE: ReadonlyMap<HarRedactionPlace, readonly HarModelField[]> = (() => {
  const map = new Map<HarRedactionPlace, HarModelField[]>();
  for (const row of Object.values(HAR_MODEL_FIELD_TABLE) as HarModelFieldRow[]) {
    for (const place of row.places) {
      map.set(place, [...(map.get(place) ?? []), row.field]);
    }
  }
  return map;
})();

const PREFIXES_WITH_ROWS: ReadonlySet<string> = new Set(
  Object.keys(HAR_MODEL_ROWS).map((field) => field.slice(0, field.lastIndexOf("."))),
);

function rowFieldFor(prefix: string, key: string): HarModelField | undefined {
  for (const field of [`${prefix}.${key}`, `${prefix}.<custom>`]) {
    if (Object.hasOwn(HAR_MODEL_ROWS, field)) {
      return field as HarModelField;
    }
  }
  return undefined;
}

function rowOf(field: HarModelField): HarModelFieldSpec {
  return HAR_MODEL_ROWS[field];
}

const DEFAULT_REPLACEMENT = "[REDACTED]";

function resolveLevel(input: RedactionLevelInput | undefined): RedactionLevel {
  if (input === undefined || input === "standard" || input === "default") {
    return "standard";
  }
  if (input === "shareable" || input === "strict") {
    return "shareable";
  }
  throw new RangeError(`Unknown redaction level: ${String(input)}`);
}

function foldKey(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
}

function findMatchingRule(
  rules: readonly HarRedactionRule[],
  target: HarRedactionTarget,
  fieldName: string,
): HarRedactionRule | undefined {
  const lower = fieldName.toLowerCase();
  for (const rule of rules) {
    if (rule.target !== target) {
      continue;
    }
    if (rule.matchAll === true) {
      return rule;
    }
    for (const candidate of rule.names) {
      if (candidate.toLowerCase() === lower) {
        return rule;
      }
    }
  }
  return undefined;
}

function findBodyRule(
  rules: readonly HarRedactionRule[],
  fieldName: string,
): HarRedactionRule | undefined {
  const direct = findMatchingRule(rules, "body", fieldName);
  if (direct) {
    return direct;
  }
  const folded = foldKey(fieldName);
  for (const rule of rules) {
    if (rule.target !== "body" || rule.matchAll === true) {
      continue;
    }
    for (const candidate of rule.names) {
      if (foldKey(candidate) === folded) {
        return rule;
      }
    }
  }
  return undefined;
}

function rulesSelecting(
  rule: HarPlaceRule,
  rules: readonly HarRedactionRule[],
): readonly HarRedactionRule[] {
  const selector = rule.selectedBy;
  if (!selector) {
    return [];
  }
  return rules.filter(
    (candidate) =>
      candidate.target === selector.target &&
      (!selector.byName || candidate.matchAll === true || candidate.names.length > 0),
  );
}

function effectivePlaceStatus(
  place: HarRedactionPlace,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): PlaceExamStatus {
  const row = table[place];
  const configured = row[level];
  if (
    configured === "removed" &&
    level === "standard" &&
    row.selectedBy !== undefined &&
    rulesSelecting(row, rules).length === 0
  ) {
    return "kept-not-examined";
  }
  return configured;
}

function placeLabel(
  place: HarRedactionPlace,
  rules: readonly HarRedactionRule[],
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): string {
  const row = table[place];
  let names: readonly string[] | "any" | undefined = row.listedNames
    ? [...row.listedNames]
    : undefined;
  if (row.selectedBy?.byName === true) {
    const selecting = rulesSelecting(row, rules);
    names = selecting.some((rule) => rule.matchAll === true)
      ? "any"
      : [...new Set(selecting.flatMap((rule) => rule.names.map((name) => name.toLowerCase())))];
  }
  if (names === undefined) {
    return row.label;
  }
  if (names === "any") {
    return `${row.label} with any name`;
  }
  return names.length > 0
    ? `${row.label} named ${names.join(", ")}`
    : `${row.label} named by a rule (no rule is in force)`;
}

interface StatusWording {
  readonly detail: PlaceReportDetail;
  readonly clause: string;
  readonly canStillHold: (label: string) => string;
}

const STATUS_WORDING: Readonly<Record<PlaceExamStatus, StatusWording>> = {
  removed: {
    detail: "removed",
    clause: "Removes",
    canStillHold: (label) => `Nothing. Every value in ${label} is removed.`,
  },
  "kept-by-allowlist": {
    detail: "kept by allowlist",
    clause: "Keeps by allowlist",
    canStillHold: (label) =>
      `Any secret written into ${label} remains: the allowlist keeps it without examining it.`,
  },
  "kept-not-examined": {
    detail: "not examined: may contain secrets",
    clause: "Keeps without examining",
    canStillHold: (label) => `Any secret in ${label} remains: it was not examined.`,
  },
};

const STATUS_ORDER: readonly PlaceExamStatus[] = [
  "removed",
  "kept-by-allowlist",
  "kept-not-examined",
];

export const PLACE_SEPARATOR = "; ";

function describeLevel(places: readonly HarPlaceCoverage[]): {
  readonly guarantee: string;
  readonly remainingRisk: string;
} {
  const phrase = (place: HarPlaceCoverage): string => `${place.label} (${place.fields.join(", ")})`;
  const clauses = STATUS_ORDER.flatMap((status) => {
    const matching = places.filter((place) => place.status === status);
    return matching.length > 0
      ? [`${STATUS_WORDING[status].clause}: ${matching.map(phrase).join(PLACE_SEPARATOR)}.`]
      : [];
  });
  const kept = places.filter((place) => place.status !== "removed");
  return {
    guarantee: [
      ...clauses,
      "Every kept value and the order of keys stay as they were.",
      "Each removal is listed by field path in log._harExport.redaction.records and in _harExport.redactedFields on its entry.",
    ].join(" "),
    remainingRisk:
      kept.length > 0
        ? `Any secret in a kept place remains: ${kept.map((place) => place.label).join(PLACE_SEPARATOR)}.`
        : "No place is kept.",
  };
}

function buildPlacesReport(
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  counts: ReadonlyMap<HarRedactionPlace, number>,
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): readonly HarPlaceCoverage[] {
  return HAR_REDACTION_PLACES.map((place) => {
    const status = effectivePlaceStatus(place, level, rules, table);
    const label = placeLabel(place, rules, table);
    return {
      place,
      label,
      fields: FIELDS_BY_PLACE.get(place) ?? [],
      status,
      count: counts.get(place) ?? 0,
      detail: STATUS_WORDING[status].detail,
      canStillHold: STATUS_WORDING[status].canStillHold(label),
    };
  });
}

class RedactionTracker {
  readonly #entryIndex: number;
  readonly #removals = new Map<
    string,
    { place: HarRedactionPlace; field: HarModelField; ruleId: string; count: number }
  >();
  readonly #fields = new Set<HarModelField>();
  readonly placeCounts = new Map<HarRedactionPlace, number>();

  constructor(entryIndex: number) {
    this.#entryIndex = entryIndex;
  }

  kept<F extends HarModelField>(field: F, place: PlaceOf<F>, amount = 1): void {
    this.keptField(field, place, amount);
  }

  removed<F extends HarModelField>(field: F, place: PlaceOf<F>, ruleId: string, amount = 1): void {
    this.removedField(field, place, ruleId, amount);
  }

  // For table-driven code, where the field and its place come from the same row.
  keptField(_field: HarModelField, place: HarRedactionPlace, amount = 1): void {
    if (amount > 0) {
      this.placeCounts.set(place, (this.placeCounts.get(place) ?? 0) + amount);
    }
  }

  removedField(field: HarModelField, place: HarRedactionPlace, ruleId: string, amount = 1): void {
    if (amount <= 0) {
      return;
    }
    this.placeCounts.set(place, (this.placeCounts.get(place) ?? 0) + amount);
    this.#fields.add(field);
    const key = `${place}\0${field}\0${ruleId}`;
    const prior = this.#removals.get(key);
    if (prior) {
      prior.count += amount;
    } else {
      this.#removals.set(key, { place, field, ruleId, count: amount });
    }
  }

  records(): readonly HarRedactionRecord[] {
    return [...this.#removals.values()].map((item) => ({
      entryIndex: this.#entryIndex,
      place: item.place,
      field: item.field,
      ruleId: item.ruleId,
      count: item.count,
    }));
  }

  get fields(): readonly HarModelField[] {
    return [...this.#fields];
  }
}

interface RedactContext {
  readonly level: RedactionLevel;
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly tracker: RedactionTracker;
  isRemoved(place: HarRedactionPlace): boolean;
  levelRule(place: HarRedactionPlace): string;
  emptied(): string;
}

function createContext(
  entryIndex: number,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  replacement: string,
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): RedactContext {
  return {
    level,
    rules,
    replacement,
    tracker: new RedactionTracker(entryIndex),
    isRemoved(place) {
      return effectivePlaceStatus(place, level, rules, table) === "removed";
    },
    levelRule(place) {
      return `${level}:${place}`;
    },
    emptied() {
      return level === "shareable" ? "" : replacement;
    },
  };
}

// Rebuilds `source` in its own key order. A key in `changes` takes the new value, or is deleted when
// the new value is undefined. Keys only in `changes` go last.
function rebuild<T extends object>(source: T, changes: Readonly<Record<string, unknown>>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(changes, key)) {
      out[key] = value;
    } else if (changes[key] !== undefined) {
      out[key] = changes[key];
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(source, key) && value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function runtimeKind(value: unknown): HarValueKind {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "object"
    ? kind
    : "unknown";
}

// The one rule for a value whose JSON type is not the one its row gives: both levels remove it,
// record it under `wrong-type`, and put the row's removal value in a required field.
function enforceKinds<T extends object>(
  source: T,
  prefix: string,
  ctx: RedactContext,
  shallow: ReadonlySet<string> = new Set(),
): T {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = rowFieldFor(prefix, key);
    if (value === undefined || field === undefined) {
      continue;
    }
    const row = rowOf(field);
    if (row.kinds.includes("unknown")) {
      continue;
    }
    if (!row.kinds.includes(runtimeKind(value))) {
      ctx.tracker.removedField(field, "wrong-type", ctx.levelRule("wrong-type"));
      changes[key] = row.whenRemoved;
      continue;
    }
    const next = Array.isArray(value)
      ? enforceItems(value, field, row, ctx, !shallow.has(key))
      : typeof value === "object" && value !== null && !shallow.has(key)
        ? enforceObject(value, row.children ?? field, ctx)
        : value;
    if (next !== value && row.wholePlace === true) {
      // A whole place that held a value of the wrong type goes whole, so no object is left
      // missing a member HAR 1.2 requires.
      changes[key] = row.whenRemoved;
      ctx.tracker.removedField(field, "wrong-type", ctx.levelRule("wrong-type"));
    } else if (next !== value) {
      changes[key] = next;
    }
  }
  return Object.keys(changes).length > 0 ? rebuild(source, changes) : source;
}

function enforceObject(value: object, prefix: string, ctx: RedactContext): object {
  return PREFIXES_WITH_ROWS.has(prefix) ? enforceKinds(value, prefix, ctx) : value;
}

function enforceItems(
  items: readonly unknown[],
  field: HarModelField,
  row: HarModelFieldSpec,
  ctx: RedactContext,
  descend: boolean,
): readonly unknown[] {
  const itemPrefix = row.children ?? `${field}[]`;
  let changed = false;
  const out: unknown[] = [];
  for (const item of items) {
    if (runtimeKind(item) !== row.items) {
      ctx.tracker.removedField(field, "wrong-type", ctx.levelRule("wrong-type"));
      changed = true;
      continue;
    }
    const next =
      descend && typeof item === "object" && item !== null
        ? enforceObject(item, itemPrefix, ctx)
        : item;
    changed ||= next !== item;
    out.push(next);
  }
  return changed ? out : items;
}

// Fields whose row names one place: that place's status decides, and each present value counts.
function redactSingleFields(
  source: object,
  fields: readonly HarModelField[],
  ctx: RedactContext,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.slice(field.lastIndexOf(".") + 1);
    const row = rowOf(field);
    const place = row.places[0];
    if ((source as Record<string, unknown>)[key] === undefined || place === undefined) {
      continue;
    }
    if (ctx.isRemoved(place)) {
      ctx.tracker.removedField(field, place, ctx.levelRule(place));
      changes[key] = row.whenRemoved;
    } else {
      ctx.tracker.keptField(field, place);
    }
  }
  return changes;
}

// Counts every present value under an object whose whole subtree is one place, by its row.
function countValues(
  value: unknown,
  field: HarModelField,
  counts: Map<HarModelField, number>,
): void {
  if (value === undefined) {
    return;
  }
  counts.set(field, (counts.get(field) ?? 0) + 1);
  const row = rowOf(field);
  if (Array.isArray(value) && row.items === "object") {
    const itemPrefix = row.children ?? `${field}[]`;
    for (const item of value) {
      countObject(item, itemPrefix, counts);
    }
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    countObject(value, row.children ?? field, counts);
  }
}

function countObject(value: unknown, prefix: string, counts: Map<HarModelField, number>): void {
  if (typeof value !== "object" || value === null || !PREFIXES_WITH_ROWS.has(prefix)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const field = rowFieldFor(prefix, key);
    if (field === undefined) {
      continue;
    }
    if (field.endsWith(".<custom>")) {
      counts.set(field, (counts.get(field) ?? 0) + (child === undefined ? 0 : 1));
    } else {
      countValues(child, field, counts);
    }
  }
}

function redactProtocolString(
  value: string,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): string {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return "";
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactProtocolIso(
  value: IsoDateTime,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): IsoDateTime {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return toIsoDateTime("1970-01-01T00:00:00.000Z")!;
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactProtocolPageId(
  value: PageId,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): PageId {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return toPageId("page_redacted")!;
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactComment(
  comment: string | undefined,
  field: FieldIn<"comment">,
  ctx: RedactContext,
): string | undefined {
  if (comment === undefined) {
    return undefined;
  }
  if (ctx.isRemoved("comment")) {
    ctx.tracker.removed(field, "comment", ctx.levelRule("comment"));
    return undefined;
  }
  ctx.tracker.kept(field, "comment");
  return comment;
}

// Each custom key counts once, whatever its value holds. A key the model declares is recorded under
// its own field, any other under the object's `<custom>` field.
function redactCustomFields(
  source: object,
  owned: ReadonlySet<string>,
  field: FieldIn<"other-custom-field">,
  ctx: RedactContext,
  extraOwned?: ReadonlySet<string>,
): Record<string, undefined> {
  const prefix = field.slice(0, -".<custom>".length);
  const keys = Object.keys(source).filter(
    (key) =>
      !owned.has(key) &&
      !(extraOwned?.has(key) ?? false) &&
      (source as Record<string, unknown>)[key] !== undefined,
  );
  const removed = ctx.isRemoved("other-custom-field");
  for (const key of keys) {
    const keyField = rowFieldFor(prefix, key) ?? field;
    if (removed) {
      ctx.tracker.removedField(keyField, "other-custom-field", ctx.levelRule("other-custom-field"));
    } else {
      ctx.tracker.keptField(keyField, "other-custom-field");
    }
  }
  return removed ? Object.fromEntries(keys.map((key) => [key, undefined])) : {};
}

function redactDeclaredCustomField(
  value: unknown,
  field: FieldIn<"other-custom-field">,
  ctx: RedactContext,
): unknown {
  if (ctx.isRemoved("other-custom-field")) {
    ctx.tracker.removed(field, "other-custom-field", ctx.levelRule("other-custom-field"));
    return undefined;
  }
  ctx.tracker.kept(field, "other-custom-field");
  return value;
}

// A URL is what the WHATWG URL Standard parses as one; `parseUrl` applies its rules. These schemes
// carry another URL after their colon, which is redacted the same way, up to MAX_WRAPPER_DEPTH deep.
const URL_WRAPPERS: ReadonlySet<string> = new Set(["blob", "view-source", "jar", "filesystem"]);
// What the removed content of a URL with no host becomes, so the URL keeps a non-empty path, which
// the HAR 1.2 schema's `uri` format requires.
const OPAQUE_PLACEHOLDER = "redacted";
const MAX_WRAPPER_DEPTH = 3;

interface Cut {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// The parts of the URL itself, or of the URL a wrapper carries, with indices into `value`.
function innermostUrl(value: string): { readonly parts: UrlParts; readonly offset: number } | null {
  let parts = parseUrl(value);
  let offset = 0;
  for (
    let depth = 0;
    parts !== null && parts.opaquePath && URL_WRAPPERS.has(parts.scheme);
    depth += 1
  ) {
    if (depth === MAX_WRAPPER_DEPTH) {
      return null;
    }
    const inner = parseUrl(value.slice(offset + parts.afterScheme));
    if (inner === null) {
      break;
    }
    offset += parts.afterScheme;
    parts = inner;
  }
  return parts === null ? null : { parts, offset };
}

// Redacts a value that is a URL, cutting each removed part out of the original string so every
// other byte stays as it was. Returns null when the value is not a URL by the URL Standard, or
// wraps more than MAX_WRAPPER_DEPTH URLs.
type UrlField =
  | "request.url"
  | "log.pages[].title"
  | "request.headers[].value"
  | "response.headers[].value"
  | "response.redirectURL";

function redactUrlValue(value: string, ctx: RedactContext, field: UrlField): string | null {
  const found = innermostUrl(value);
  if (found === null) {
    return null;
  }
  const { parts, offset } = found;
  // A URL inside another value keeps its host, path and fragment; only its userinfo and query secrets are examined.
  const isPage = field !== "request.url";
  const cuts: Cut[] = [];
  const span = (part: UrlSpan) => ({ start: offset + part.start, end: offset + part.end });

  if (parts.credentials !== null) {
    if (ctx.isRemoved("request-url-userinfo")) {
      const rule = findMatchingRule(ctx.rules, "url-userinfo", "userinfo");
      ctx.tracker.removed(
        field,
        "request-url-userinfo",
        rule?.id ?? ctx.levelRule("request-url-userinfo"),
      );
      cuts.push({ ...span(parts.credentials), text: "" });
    } else {
      ctx.tracker.kept(field, "request-url-userinfo");
    }
  }

  if (!isPage) {
    if (ctx.isRemoved("request-url-host")) {
      ctx.tracker.removed("request.url", "request-url-host", ctx.levelRule("request-url-host"));
      if (parts.host !== null) {
        cuts.push({ ...span(parts.host), text: "redacted.invalid" });
      }
    } else {
      ctx.tracker.kept("request.url", "request-url-host");
    }
    const pathPlace = parts.opaquePath ? "request-url-opaque" : "request-url-path";
    if (parts.path.end > parts.path.start) {
      if (ctx.isRemoved(pathPlace)) {
        ctx.tracker.removed("request.url", pathPlace, ctx.levelRule(pathPlace));
        cuts.push({ ...span(parts.path), text: parts.opaquePath ? OPAQUE_PLACEHOLDER : "/" });
      } else {
        ctx.tracker.kept("request.url", pathPlace);
      }
    } else if (parts.opaquePath && ctx.isRemoved(pathPlace)) {
      cuts.push({ ...span(parts.path), text: OPAQUE_PLACEHOLDER });
    }
  }

  if (parts.query !== null) {
    const query = span(parts.query);
    const text = value.slice(query.start + 1, query.end);
    const next = redactQuery(text, ctx, field);
    if (next === null) {
      cuts.push({ ...query, text: "" });
    } else if (next !== text) {
      cuts.push({ ...query, text: `?${next}` });
    }
  }

  if (parts.fragment !== null && !isPage) {
    if (ctx.isRemoved("request-url-fragment")) {
      ctx.tracker.removed(
        "request.url",
        "request-url-fragment",
        ctx.levelRule("request-url-fragment"),
      );
      cuts.push({ ...span(parts.fragment), text: "" });
    } else {
      ctx.tracker.kept("request.url", "request-url-fragment");
    }
  }

  let out = "";
  let cursor = 0;
  for (const cut of cuts.sort((a, b) => a.start - b.start)) {
    out += value.slice(cursor, cut.start) + cut.text;
    cursor = cut.end;
  }
  return out + value.slice(cursor);
}

// Redacts the text after a query's `?`. Returns null when the whole query, `?` included, goes.
function redactQuery(query: string, ctx: RedactContext, field: UrlField): string | null {
  const isPage = field !== "request.url";
  const encodedReplacement = encodeURIComponent(ctx.replacement);
  const otherQueryRemoved = !isPage && ctx.isRemoved("request-url-query");
  const keptSegments: string[] = [];
  for (const segment of query.split("&")) {
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const secretRule =
      segment.length > 0
        ? findMatchingRule(ctx.rules, "query", safeDecodeQueryComponent(rawName))
        : undefined;
    if (secretRule) {
      if (ctx.isRemoved("request-url-query-secret")) {
        ctx.tracker.removed(field, "request-url-query-secret", secretRule.id);
        if (!otherQueryRemoved) {
          keptSegments.push(`${rawName}=${encodedReplacement}`);
        }
      } else {
        ctx.tracker.kept(field, "request-url-query-secret");
        keptSegments.push(segment);
      }
    } else if (otherQueryRemoved) {
      if (segment.length > 0) {
        ctx.tracker.removed("request.url", "request-url-query", ctx.levelRule("request-url-query"));
      }
    } else {
      if (!isPage && segment.length > 0) {
        ctx.tracker.kept("request.url", "request-url-query");
      }
      keptSegments.push(segment);
    }
  }
  return otherQueryRemoved ? null : keptSegments.join("&");
}

// A page title is examined as a URL only when the whole title is one, with no space or control
// character anywhere. Any other title is text, which is not examined.
function isWholeUrl(title: string): boolean {
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return parseUrl(title) !== null;
}

function redactPageTitle(title: string, ctx: RedactContext): string {
  const afterUrl = isWholeUrl(title)
    ? (redactUrlValue(title, ctx, "log.pages[].title") ?? title)
    : title;
  if (ctx.isRemoved("page-title")) {
    ctx.tracker.removed("log.pages[].title", "page-title", ctx.levelRule("page-title"));
    return "";
  }
  ctx.tracker.kept("log.pages[].title", "page-title");
  return afterUrl;
}

type HeaderValuePlace = PlaceOf<"request.headers[].value">;

function classifyHeaderValuePlace(
  headerName: string,
  rules: readonly HarRedactionRule[],
): { readonly place: HeaderValuePlace; readonly rule?: HarRedactionRule | undefined } {
  // Some proxies keep the colon or stray spaces in a header name; the rule still applies.
  const rule = findMatchingRule(rules, "header", headerName.trim().replace(/\s*:$/u, ""));
  if (rule) {
    return { place: "header-value-secret", rule };
  }
  const lower = headerName.toLowerCase();
  if (ALLOWLISTED_HEADER_NAMES.has(lower)) {
    return { place: "header-value-allowlisted" };
  }
  if (URL_HEADER_NAMES.has(lower)) {
    return { place: "url-header" };
  }
  return { place: "named-header" };
}

type Side = "request" | "response";

function redactHeaders(
  headers: readonly HarNameValue[],
  side: Side,
  ctx: RedactContext,
): readonly HarNameValue[] {
  return headers.map((header) => {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(header, OWNED_FIELDS.nameValue, `${side}.headers[].<custom>`, ctx),
      comment: redactComment(header.comment, `${side}.headers[].comment`, ctx),
    };

    if (ctx.isRemoved("header-name")) {
      ctx.tracker.removed(`${side}.headers[].name`, "header-name", ctx.levelRule("header-name"));
      changes.name = "";
    } else {
      ctx.tracker.kept(`${side}.headers[].name`, "header-name");
    }

    const { place, rule } = classifyHeaderValuePlace(header.name, ctx.rules);
    // A Referer or Location carries the page's own URL, query secrets included, so a whole URL is examined as one.
    const afterUrl =
      place === "url-header" && typeof header.value === "string" && isWholeUrl(header.value)
        ? (redactUrlValue(header.value, ctx, `${side}.headers[].value`) ?? header.value)
        : header.value;
    if (ctx.isRemoved(place)) {
      ctx.tracker.removed(`${side}.headers[].value`, place, rule?.id ?? ctx.levelRule(place));
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept(`${side}.headers[].value`, place);
      if (afterUrl !== header.value) changes.value = afterUrl;
    }
    return rebuild(header, changes);
  });
}

const COOKIE_METADATA_KEYS = ["name", "path", "domain", "expires"] as const;

function redactCookies(
  cookies: readonly HarCookie[],
  side: Side,
  ctx: RedactContext,
): readonly HarCookie[] {
  const metaRemoved = ctx.isRemoved("cookie-metadata");
  const valueRemoved = ctx.isRemoved("cookie");
  const result: HarCookie[] = [];

  for (const cookie of cookies) {
    const changes: Record<string, unknown> = {
      ...redactSingleFields(
        cookie,
        [`${side}.cookies[].httpOnly`, `${side}.cookies[].secure`],
        ctx,
      ),
      ...redactCustomFields(cookie, OWNED_FIELDS.cookie, `${side}.cookies[].<custom>`, ctx),
      comment: redactComment(cookie.comment, `${side}.cookies[].comment`, ctx),
    };

    for (const key of COOKIE_METADATA_KEYS) {
      if (cookie[key] === undefined) {
        continue;
      }
      if (metaRemoved) {
        ctx.tracker.removed(
          `${side}.cookies[].${key}`,
          "cookie-metadata",
          ctx.levelRule("cookie-metadata"),
        );
        changes[key] = key === "name" ? "" : undefined;
      } else {
        ctx.tracker.kept(`${side}.cookies[].${key}`, "cookie-metadata");
      }
    }

    if (valueRemoved) {
      const rule = findMatchingRule(ctx.rules, "cookie", cookie.name);
      ctx.tracker.removed(`${side}.cookies[].value`, "cookie", rule?.id ?? ctx.levelRule("cookie"));
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept(`${side}.cookies[].value`, "cookie");
    }

    const next = rebuild(cookie, changes);
    if (metaRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.cookie, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

// True when every key left on `item` is one of `emptiedKeys` or a non-string field the spec owns, so
// the item no longer carries anything worth keeping.
function keepsOnly(
  item: object,
  owned: ReadonlySet<string>,
  emptiedKeys: readonly string[],
): boolean {
  return Object.entries(item).every(
    ([key, value]) =>
      emptiedKeys.includes(key) ||
      (owned.has(key) && key !== "comment" && typeof value !== "string"),
  );
}

function redactQueryString(
  queryString: readonly HarNameValue[],
  ctx: RedactContext,
): readonly HarNameValue[] {
  const nameRemoved = ctx.isRemoved("query-string");
  const result: HarNameValue[] = [];

  for (const item of queryString) {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(item, OWNED_FIELDS.nameValue, "request.queryString[].<custom>", ctx),
      comment: redactComment(item.comment, "request.queryString[].comment", ctx),
    };

    if (nameRemoved) {
      ctx.tracker.removed(
        "request.queryString[].name",
        "query-string",
        ctx.levelRule("query-string"),
      );
      changes.name = "";
    } else {
      ctx.tracker.kept("request.queryString[].name", "query-string");
    }

    const rule = findMatchingRule(ctx.rules, "query", item.name);
    const valuePlace = rule ? "query-string-secret" : "query-string";
    const valueRemoved = ctx.isRemoved(valuePlace);
    if (valueRemoved) {
      ctx.tracker.removed(
        "request.queryString[].value",
        valuePlace,
        rule?.id ?? ctx.levelRule(valuePlace),
      );
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept("request.queryString[].value", valuePlace);
    }

    const next = rebuild(item, changes);
    if (nameRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.nameValue, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function classifyRequestBodyPlace(
  mimeType: string,
  text: string,
): PlaceOf<"request.postData.text"> {
  const mime = mimeType.toLowerCase();
  if (mime.includes("json") || looksLikeJson(text)) {
    return "body-json";
  }
  if (mime.includes("x-www-form-urlencoded")) {
    return "body-form";
  }
  if (mime.includes("multipart/")) {
    return "body-multipart";
  }
  return "request-body-other";
}

function classifyResponseBodyPlace(
  mimeType: string,
  encoding: string | undefined,
  text: string,
): PlaceOf<"response.content.text"> {
  if (encoding?.toLowerCase() === "base64") {
    return "response-body-base64";
  }
  const mime = mimeType.toLowerCase();
  if (mime.includes("json") || looksLikeJson(text)) {
    return "response-body-json";
  }
  return "response-body-other";
}

const PARAM_METADATA_KEYS = ["name", "fileName", "contentType"] as const;

function redactParams(
  params: readonly HarPostDataParam[],
  ctx: RedactContext,
): readonly HarPostDataParam[] {
  const metaRemoved = ctx.isRemoved("body-param");
  const result: HarPostDataParam[] = [];

  for (const param of params) {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(
        param,
        OWNED_FIELDS.postParam,
        "request.postData.params[].<custom>",
        ctx,
      ),
      comment: redactComment(param.comment, "request.postData.params[].comment", ctx),
    };

    for (const key of PARAM_METADATA_KEYS) {
      if (param[key] === undefined) {
        continue;
      }
      if (metaRemoved) {
        ctx.tracker.removed(
          `request.postData.params[].${key}`,
          "body-param",
          ctx.levelRule("body-param"),
        );
        changes[key] = key === "name" ? "" : undefined;
      } else {
        ctx.tracker.kept(`request.postData.params[].${key}`, "body-param");
      }
    }

    const rule = findBodyRule(ctx.rules, param.name);
    const valuePlace = rule ? "body-param-secret" : "body-param";
    let valueRemoved = param.value === undefined;
    if (param.value !== undefined) {
      if (ctx.isRemoved(valuePlace)) {
        ctx.tracker.removed(
          "request.postData.params[].value",
          valuePlace,
          rule?.id ?? ctx.levelRule(valuePlace),
        );
        changes.value = ctx.emptied();
        valueRemoved = true;
      } else {
        ctx.tracker.kept("request.postData.params[].value", valuePlace);
      }
    }

    const next = rebuild(param, changes);
    if (metaRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.postParam, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

function redactPostData(
  postData: HarPostData | undefined,
  ctx: RedactContext,
): HarPostData | undefined {
  if (!postData) {
    return undefined;
  }
  const changes: Record<string, unknown> = {
    ...redactCustomFields(postData, OWNED_FIELDS.postData, "request.postData.<custom>", ctx),
    comment: redactComment(postData.comment, "request.postData.comment", ctx),
    mimeType: redactProtocolString(postData.mimeType, "request.postData.mimeType", ctx),
    params: redactParams(postData.params, ctx),
  };

  const text = postData.text;
  if (text !== undefined) {
    const bodyPlace =
      typeof text === "string" && text.length > 0
        ? classifyRequestBodyPlace(postData.mimeType, text)
        : "request-body-other";
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.removed("request.postData.text", bodyPlace, ctx.levelRule(bodyPlace));
      changes.text = "";
    } else {
      ctx.tracker.kept("request.postData.text", bodyPlace);
    }
  }
  return rebuild(postData, changes);
}

function redactContent(content: HarContent, ctx: RedactContext): HarContent {
  const changes: Record<string, unknown> = {
    ...redactSingleFields(content, ["response.content.size", "response.content.compression"], ctx),
    ...redactCustomFields(content, OWNED_FIELDS.content, "response.content.<custom>", ctx),
    comment: redactComment(content.comment, "response.content.comment", ctx),
    mimeType: redactProtocolString(content.mimeType, "response.content.mimeType", ctx),
  };
  if (typeof content.encoding === "string") {
    changes.encoding = redactProtocolString(content.encoding, "response.content.encoding", ctx);
  }

  const text = content.text;
  if (text !== undefined) {
    const bodyPlace =
      text.length > 0
        ? classifyResponseBodyPlace(content.mimeType, content.encoding, text)
        : "response-body-other";
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.removed("response.content.text", bodyPlace, ctx.levelRule(bodyPlace));
      changes.text = undefined;
    } else {
      ctx.tracker.kept("response.content.text", bodyPlace);
    }
  }
  return rebuild(content, changes);
}

function redactCache(cache: HarCache, ctx: RedactContext): HarCache {
  return rebuild(cache, {
    ...redactCustomFields(cache, OWNED_FIELDS.cache, "cache.<custom>", ctx),
    comment: redactComment(cache.comment, "cache.comment", ctx),
    beforeRequest: redactWholePlace(cache.beforeRequest, "cache.beforeRequest", ctx),
    afterRequest: redactWholePlace(cache.afterRequest, "cache.afterRequest", ctx),
  });
}

const TIMING_FIELDS = [
  "timings.blocked",
  "timings.dns",
  "timings.connect",
  "timings.send",
  "timings.wait",
  "timings.receive",
  "timings.ssl",
] as const;

function redactTimings(timings: HarTimings, ctx: RedactContext): HarTimings {
  return rebuild(timings, {
    ...redactSingleFields(timings, TIMING_FIELDS, ctx),
    ...redactCustomFields(timings, OWNED_FIELDS.timings, "timings.<custom>", ctx),
    comment: redactComment(timings.comment, "timings.comment", ctx),
  });
}

type WholePlaceField = {
  [F in HarModelField]: Rows[F] extends { readonly wholePlace: true } ? F : never;
}[HarModelField];

// A whole place (initiator, WebSocket messages, a cache entry) is kept or removed as one object.
function redactWholePlace<T>(
  value: T | undefined,
  field: WholePlaceField,
  ctx: RedactContext,
): T | undefined {
  const place = HAR_MODEL_ROWS[field].places[0];
  const counts = new Map<HarModelField, number>();
  countValues(value, field, counts);
  const removed = ctx.isRemoved(place);
  for (const [counted, amount] of counts) {
    if (removed) {
      ctx.tracker.removedField(counted, place, ctx.levelRule(place), amount);
    } else {
      ctx.tracker.keptField(counted, place, amount);
    }
  }
  return removed ? undefined : value;
}

const EXPORT_ANNOTATION_FIELDS = (FIELDS_BY_PLACE.get("export-annotation") ?? []).filter((field) =>
  field.startsWith("entry._harExport."),
);

function redactEntryExport(
  extension: HarEntryExtension | undefined,
  ctx: RedactContext,
): Record<string, unknown> {
  if (typeof extension !== "object" || extension === null) {
    return {};
  }
  const changes: Record<string, unknown> = {
    ...redactCustomFields(extension, OWNED_FIELDS.entryExport, "entry._harExport.<custom>", ctx),
  };
  for (const field of EXPORT_ANNOTATION_FIELDS) {
    const key = field.slice("entry._harExport.".length);
    if (extension[key] === undefined) {
      continue;
    }
    if (ctx.isRemoved("export-annotation")) {
      ctx.tracker.removedField(field, "export-annotation", ctx.levelRule("export-annotation"));
      changes[key] = undefined;
    } else {
      ctx.tracker.keptField(field, "export-annotation");
    }
  }
  if (extension.redactedFields !== undefined) {
    ctx.tracker.removed(
      "entry._harExport.redactedFields",
      "redaction-record",
      ctx.levelRule("redaction-record"),
    );
    changes.redactedFields = undefined;
  }
  return changes;
}

const ENTRY_DECLARED_CUSTOM = new Set<string>([
  "_securityState",
  "_priority",
  "_initiator",
  "_resourceType",
  "_fromCache",
  "_connectionId",
  "_webSocketMessages",
  "_harExport",
]);

const ENTRY_CUSTOM_STRING_FIELDS = [
  ["serverIPAddress", "entry.serverIPAddress"],
  ["connection", "entry.connection"],
  ["_securityState", "entry._securityState"],
  ["_priority", "entry._priority"],
  ["_resourceType", "entry._resourceType"],
  ["_fromCache", "entry._fromCache"],
  ["_connectionId", "entry._connectionId"],
] as const;

const RESPONSE_DECLARED_CUSTOM = new Set<string>(["_error"]);

// A request URL that is not a URL, or is no longer one once redacted, is replaced, never put back.
function redactRequestUrl(url: string, ctx: RedactContext): HarUrl {
  const redacted = redactUrlValue(url, ctx, "request.url");
  if (redacted !== null && isHarUrl(redacted)) {
    return redacted;
  }
  ctx.tracker.removed("request.url", "wrong-type", ctx.levelRule("wrong-type"));
  return REDACTED_URL as HarUrl;
}

function redactRequest(entry: HarEntry, ctx: RedactContext): HarEntry["request"] {
  const request = entry.request;
  return rebuild(request, {
    ...redactSingleFields(request, ["request.headersSize", "request.bodySize"], ctx),
    ...redactCustomFields(request, OWNED_FIELDS.request, "request.<custom>", ctx),
    method: redactProtocolString(request.method, "request.method", ctx),
    url: redactRequestUrl(request.url, ctx),
    httpVersion: redactProtocolString(request.httpVersion, "request.httpVersion", ctx),
    cookies: redactCookies(request.cookies, "request", ctx),
    headers: redactHeaders(request.headers, "request", ctx),
    queryString: redactQueryString(request.queryString, ctx),
    postData: redactPostData(request.postData, ctx),
    comment: redactComment(request.comment, "request.comment", ctx),
  });
}

function redactResponse(entry: HarEntry, ctx: RedactContext): HarEntry["response"] {
  const response = entry.response;
  const changes: Record<string, unknown> = {
    ...redactSingleFields(
      response,
      ["response.status", "response.headersSize", "response.bodySize"],
      ctx,
    ),
    ...redactCustomFields(
      response,
      OWNED_FIELDS.response,
      "response.<custom>",
      ctx,
      RESPONSE_DECLARED_CUSTOM,
    ),
    statusText: redactProtocolString(response.statusText, "response.statusText", ctx),
    httpVersion: redactProtocolString(response.httpVersion, "response.httpVersion", ctx),
    cookies: redactCookies(response.cookies, "response", ctx),
    headers: redactHeaders(response.headers, "response", ctx),
    content: redactContent(response.content, ctx),
    comment: redactComment(response.comment, "response.comment", ctx),
  };
  if (response.redirectURL !== undefined) {
    const afterUrl =
      typeof response.redirectURL === "string" && isWholeUrl(response.redirectURL)
        ? (redactUrlValue(response.redirectURL, ctx, "response.redirectURL") ??
          response.redirectURL)
        : response.redirectURL;
    if (ctx.isRemoved("redirect-url")) {
      ctx.tracker.removed("response.redirectURL", "redirect-url", ctx.levelRule("redirect-url"));
      changes.redirectURL = "";
    } else {
      ctx.tracker.kept("response.redirectURL", "redirect-url");
      if (afterUrl !== response.redirectURL) changes.redirectURL = afterUrl;
    }
  }
  if (response._error !== undefined) {
    changes._error = redactDeclaredCustomField(response._error, "response._error", ctx);
  }
  return rebuild(response, changes);
}

function redactEntryWithContext(
  input: HarEntry,
  ctx: RedactContext,
): { readonly entry: HarEntry; readonly records: readonly HarRedactionRecord[] } {
  const entry = enforceKinds(input, "entry", ctx);
  const exportChanges = redactEntryExport(entry._harExport, ctx);
  const changes: Record<string, unknown> = {
    ...redactSingleFields(entry, ["entry.time"], ctx),
    ...redactCustomFields(entry, OWNED_FIELDS.entry, "entry.<custom>", ctx, ENTRY_DECLARED_CUSTOM),
    pageref:
      entry.pageref !== undefined
        ? redactProtocolPageId(entry.pageref, "entry.pageref", ctx)
        : undefined,
    startedDateTime: redactProtocolIso(entry.startedDateTime, "entry.startedDateTime", ctx),
    request: redactRequest(entry, ctx),
    response: redactResponse(entry, ctx),
    cache: redactCache(entry.cache, ctx),
    timings: redactTimings(entry.timings, ctx),
    comment: redactComment(entry.comment, "entry.comment", ctx),
    _initiator: redactWholePlace(entry._initiator, "entry._initiator", ctx),
    _webSocketMessages: redactWholePlace(entry._webSocketMessages, "entry._webSocketMessages", ctx),
  };
  for (const [key, field] of ENTRY_CUSTOM_STRING_FIELDS) {
    if (entry[key] !== undefined) {
      changes[key] = redactDeclaredCustomField(entry[key], field, ctx);
    }
  }

  const removedFields = ctx.tracker.fields;
  if (entry._harExport !== undefined || removedFields.length > 0) {
    changes._harExport = rebuild(entry._harExport ?? {}, {
      ...exportChanges,
      ...(removedFields.length > 0 ? { redactedFields: removedFields } : {}),
    });
  }
  return { entry: rebuild(entry, changes), records: ctx.tracker.records() };
}

function redactCreator(
  creator: HarCreator,
  prefix: "log.creator" | "log.browser",
  ctx: RedactContext,
): HarCreator {
  const removed = ctx.isRemoved("protocol-metadata");
  const name = redactProtocolString(creator.name, `${prefix}.name`, ctx);
  const version = redactProtocolString(creator.version, `${prefix}.version`, ctx);
  return rebuild(creator, {
    ...redactCustomFields(creator, OWNED_FIELDS.creator, `${prefix}.<custom>`, ctx),
    name: removed ? "redacted" : name,
    version: removed ? "0" : version,
    comment: redactComment(creator.comment, `${prefix}.comment`, ctx),
  });
}

function redactPage(page: HarPage, ctx: RedactContext): HarPage {
  return rebuild(page, {
    ...redactCustomFields(page, OWNED_FIELDS.page, "log.pages[].<custom>", ctx),
    startedDateTime: redactProtocolIso(page.startedDateTime, "log.pages[].startedDateTime", ctx),
    id: redactProtocolPageId(page.id, "log.pages[].id", ctx),
    title: redactPageTitle(page.title, ctx),
    pageTimings: rebuild(page.pageTimings, {
      ...redactSingleFields(
        page.pageTimings,
        ["log.pages[].pageTimings.onContentLoad", "log.pages[].pageTimings.onLoad"],
        ctx,
      ),
      ...redactCustomFields(
        page.pageTimings,
        OWNED_FIELDS.pageTimings,
        "log.pages[].pageTimings.<custom>",
        ctx,
      ),
      comment: redactComment(page.pageTimings.comment, "log.pages[].pageTimings.comment", ctx),
    }),
    comment: redactComment(page.comment, "log.pages[].comment", ctx),
  });
}

function normalizeOptions(optionsOrRules?: RedactHarOptions | readonly HarRedactionRule[]): {
  readonly level: RedactionLevel;
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>;
} {
  if (Array.isArray(optionsOrRules)) {
    return {
      level: "standard",
      rules: optionsOrRules,
      replacement: DEFAULT_REPLACEMENT,
      table: HAR_PLACE_TABLE,
    };
  }
  const options = optionsOrRules as RedactHarOptions | undefined;
  return {
    level: resolveLevel(options?.level),
    rules: [...(options?.rules ?? DEFAULT_REDACTION_RULES), ...(options?.extraRules ?? [])],
    replacement: options?.replacement ?? DEFAULT_REPLACEMENT,
    table: options?.placeTable ?? HAR_PLACE_TABLE,
  };
}

export function redactUrl(
  url: string,
  optionsOrRules?: RedactHarOptions | readonly HarRedactionRule[],
): RedactUrlResult {
  const { level, rules, replacement, table } = normalizeOptions(optionsOrRules);
  const ctx = createContext(-1, level, rules, replacement, table);
  const next = redactRequestUrl(url, ctx);
  const records = ctx.tracker.records();
  return { url: next, touched: records.length > 0 || next !== url, records };
}

export function redactHarEntry(
  entry: HarEntry,
  optionsOrRules: RedactHarOptions | readonly HarRedactionRule[] | undefined,
  entryIndex: number,
): RedactHarEntryResult {
  const { level, rules, replacement, table } = normalizeOptions(optionsOrRules);
  const ctx = createContext(entryIndex, level, rules, replacement, table);
  const result = redactEntryWithContext(entry, ctx);
  const places = buildPlacesReport(level, rules, ctx.tracker.placeCounts, table);
  return {
    entry: result.entry,
    url: result.entry.request.url,
    touched: result.records.length > 0,
    records: result.records,
    covered: places
      .filter((place) => place.status !== "kept-not-examined")
      .map((place) => place.place),
    places,
  };
}

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const { level, rules, replacement, table } = normalizeOptions(options);
  const allRecords: HarRedactionRecord[] = [];
  const totalCounts = new Map<HarRedactionPlace, number>();
  let entriesAffected = 0;

  const merge = (ctx: RedactContext): void => {
    for (const [place, count] of ctx.tracker.placeCounts) {
      totalCounts.set(place, (totalCounts.get(place) ?? 0) + count);
    }
    allRecords.push(...ctx.tracker.records());
  };

  const logCtx = createContext(-1, level, rules, replacement, table);
  // Entries are checked one at a time below, each with its own context and index.
  const log = enforceKinds(document.log, "log", logCtx, new Set(["entries"]));

  const pages = log.pages?.map((page) => {
    const ctx = createContext(-1, level, rules, replacement, table);
    const updated = redactPage(page, ctx);
    merge(ctx);
    return updated;
  });

  const entries = log.entries.map((entry, index) => {
    const ctx = createContext(index, level, rules, replacement, table);
    const result = redactEntryWithContext(entry, ctx);
    if (result.records.length > 0) {
      entriesAffected += 1;
    }
    merge(ctx);
    return result.entry;
  });

  const exportCustom =
    log._harExport !== undefined
      ? redactCustomFields(
          log._harExport,
          OWNED_FIELDS.logExport,
          "log._harExport.<custom>",
          logCtx,
        )
      : {};
  if (log._harExport?.redaction !== undefined) {
    logCtx.tracker.removed(
      "log._harExport.redaction",
      "redaction-record",
      logCtx.levelRule("redaction-record"),
    );
  }
  const version = redactProtocolString(log.version, "log.version", logCtx);
  const logChanges: Record<string, unknown> = {
    ...redactCustomFields(
      log,
      OWNED_FIELDS.log,
      "log.<custom>",
      logCtx,
      new Set(["_harExport", "_harExportId"]),
    ),
    version: logCtx.isRemoved("protocol-metadata") ? "1.2" : version,
    creator: redactCreator(log.creator, "log.creator", logCtx),
    browser: log.browser ? redactCreator(log.browser, "log.browser", logCtx) : undefined,
    pages,
    entries,
    comment: redactComment(log.comment, "log.comment", logCtx),
  };
  merge(logCtx);

  const places = buildPlacesReport(level, rules, totalCounts, table);
  const notExamined = places.filter((place) => place.status === "kept-not-examined");
  const report: HarLogRedactionExtension = {
    applied: true,
    level,
    ...describeLevel(places),
    totalRemoved: allRecords.reduce((sum, record) => sum + record.count, 0),
    entriesAffected,
    rules: [...new Set(allRecords.map((record) => record.ruleId))],
    records: allRecords,
    places,
    notExamined,
    notInspected: notExamined.map((place) => place.place),
  };
  logChanges._harExport = rebuild(log._harExport ?? {}, { ...exportCustom, redaction: report });

  return { document: { log: rebuild(log, logChanges) }, report };
}
