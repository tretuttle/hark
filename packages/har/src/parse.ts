import { OWNED_FIELDS, pickCustomFields } from "./internal.ts";
import {
  isHarUrl,
  isIsoDateTime,
  isMimeType,
  isPageId,
  toIsoDateTime,
  toPageId,
  type CustomHarFields,
  type HarCache,
  type HarCacheEntry,
  type HarContent,
  type HarCookie,
  type HarCreator,
  type HarDocument,
  type HarEntry,
  type HarEntryExtension,
  type HarLog,
  type HarLogExtension,
  type HarNameValue,
  type HarPage,
  type HarPageTimings,
  type HarPostData,
  type HarPostDataParam,
  type HarRequest,
  type HarResponse,
  type HarTimings,
  type HarUrl,
  type IsoDateTime,
  type PageId,
} from "./model.ts";

export const HAR_VALIDATION_RULES = [
  "json-syntax",
  "root-object",
  "log-object",
  "log-version",
  "creator-object",
  "browser-object",
  "pages-array",
  "page-object",
  "page-id-unique",
  "page-timings-object",
  "entries-array",
  "entry-object",
  "entry-pageref-exists",
  "iso-datetime",
  "non-negative-number",
  "size-or-sentinel",
  "timing-or-sentinel",
  "request-object",
  "request-url",
  "response-object",
  "response-status",
  "redirect-url",
  "content-object",
  "mime-type",
  "post-data-object",
  "post-data-param-object",
  "name-value-array",
  "cookie-array",
  "cache-object",
  "cache-entry-object",
  "timings-object",
  "browser-timings",
  "browser-cookie-expires",
] as const;

export type HarValidationRule = (typeof HAR_VALIDATION_RULES)[number];

export type HarValidationSeverity = "error" | "note" | "dropped";

const HAR_VALIDATION_SEVERITY: Record<HarValidationRule, HarValidationSeverity> = {
  "json-syntax": "error",
  "root-object": "error",
  "log-object": "error",
  "log-version": "error",
  "creator-object": "error",
  "browser-object": "error",
  "pages-array": "error",
  "page-object": "error",
  "page-id-unique": "error",
  "page-timings-object": "error",
  "entries-array": "error",
  "entry-object": "error",
  "entry-pageref-exists": "error",
  "iso-datetime": "error",
  "non-negative-number": "error",
  "size-or-sentinel": "error",
  "timing-or-sentinel": "error",
  "request-object": "error",
  "request-url": "error",
  "response-object": "error",
  "response-status": "error",
  "redirect-url": "note",
  "content-object": "error",
  "mime-type": "note",
  "post-data-object": "error",
  "post-data-param-object": "error",
  "name-value-array": "error",
  "cookie-array": "error",
  "cache-object": "error",
  "cache-entry-object": "error",
  "timings-object": "error",
  "browser-timings": "note",
  "browser-cookie-expires": "note",
};

const DOCUMENT_REJECTION_RULES = new Set<HarValidationRule>([
  "json-syntax",
  "root-object",
  "log-object",
  "log-version",
  "creator-object",
  "entries-array",
]);

export interface HarProblem {
  readonly path: string;
  readonly rule: HarValidationRule;
  readonly severity: HarValidationSeverity;
  readonly message: string;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
}

export type HarParseResult =
  | {
      readonly ok: true;
      readonly document: HarDocument;
      readonly problems: readonly HarProblem[];
    }
  | { readonly ok: false; readonly problems: readonly HarProblem[] };

type JsonRecord = Record<string, unknown>;

const HAR_VERSION_PATTERN = /^(\d+)\.(\d+)$/u;
const NUMERIC_STRING_PATTERN = /^\d+$/u;

function salvageDate(): IsoDateTime {
  const date = toIsoDateTime("1970-01-01T00:00:00.000Z");
  if (!date) {
    throw new RangeError("Salvage date is not ISO 8601.");
  }
  return date;
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSizeOrSentinel(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1;
}

class ProblemCollector {
  readonly items: HarProblem[] = [];

  add(
    path: string,
    rule: HarValidationRule,
    message: string,
    severity?: HarValidationSeverity,
    meta?: { readonly method?: string | undefined; readonly url?: string | undefined },
  ): void {
    this.items.push({
      path,
      rule,
      severity: severity ?? HAR_VALIDATION_SEVERITY[rule],
      message,
      ...(meta?.method !== undefined ? { method: meta.method } : {}),
      ...(meta?.url !== undefined ? { url: meta.url } : {}),
    });
  }
}

function readOptionalComment(
  record: JsonRecord,
  path: string,
  rule: HarValidationRule,
  problems: ProblemCollector,
): string | undefined {
  const raw = record.comment;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    problems.add(`${path}.comment`, rule, "Expected comment to be a string.");
    return undefined;
  }
  return raw;
}

function parseCreatorLike(
  value: unknown,
  path: string,
  rule: "creator-object" | "browser-object",
  problems: ProblemCollector,
): HarCreator | null {
  if (!isPlainRecord(value)) {
    problems.add(path, rule, `Expected ${path} to be an object.`);
    return null;
  }
  const name = value.name;
  const version = value.version;
  if (typeof name !== "string" || name.length === 0) {
    problems.add(`${path}.name`, rule, "Expected non-empty string name.");
  }
  if (typeof version !== "string") {
    problems.add(`${path}.version`, rule, "Expected string version.");
  } else if (version.length === 0) {
    problems.add(
      `${path}.version`,
      rule,
      "Creator version is empty. Kept because some exporters omit the version.",
      "note",
    );
  }
  const comment = readOptionalComment(value, path, rule, problems);
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string") {
    return null;
  }
  return {
    ...pickCustomFields(value, OWNED_FIELDS.creator),
    name,
    version,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseVersion(value: unknown, path: string, problems: ProblemCollector): string | null {
  if (typeof value !== "string") {
    problems.add(path, "log-version", "Expected log.version to be a string.");
    return null;
  }
  if (value === "") {
    return "1.1";
  }
  const match = HAR_VERSION_PATTERN.exec(value);
  if (!match) {
    problems.add(path, "log-version", `Invalid HAR version format "${value}".`);
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 1 || minor < 1) {
    problems.add(path, "log-version", `Unsupported HAR version "${value}".`);
    return null;
  }
  return value;
}

function parsePageTimings(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): HarPageTimings | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "page-timings-object", "Expected pageTimings to be an object.");
    return null;
  }
  let onContentLoad: number | undefined;
  if (value.onContentLoad !== undefined) {
    if (isSizeOrSentinel(value.onContentLoad)) {
      onContentLoad = value.onContentLoad;
    } else {
      problems.add(
        `${path}.onContentLoad`,
        "timing-or-sentinel",
        "Expected onContentLoad to be a finite number >= -1.",
      );
    }
  }
  let onLoad: number | undefined;
  if (value.onLoad !== undefined) {
    if (isSizeOrSentinel(value.onLoad)) {
      onLoad = value.onLoad;
    } else {
      problems.add(
        `${path}.onLoad`,
        "timing-or-sentinel",
        "Expected onLoad to be a finite number >= -1.",
      );
    }
  }
  const comment = readOptionalComment(value, path, "page-timings-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.pageTimings),
    ...(onContentLoad !== undefined ? { onContentLoad } : {}),
    ...(onLoad !== undefined ? { onLoad } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parsePages(
  rawPages: unknown,
  problems: ProblemCollector,
): { readonly pages: readonly HarPage[]; readonly ids: ReadonlySet<PageId> } {
  const pages: HarPage[] = [];
  const ids = new Set<PageId>();
  if (rawPages === undefined) {
    return { pages, ids };
  }
  if (!Array.isArray(rawPages)) {
    problems.add("$.log.pages", "pages-array", "Expected log.pages to be an array.");
    return { pages, ids };
  }
  for (let index = 0; index < rawPages.length; index++) {
    const path = `$.log.pages[${String(index)}]`;
    const item = rawPages[index];
    if (!isPlainRecord(item)) {
      problems.add(path, "page-object", "Expected page item to be an object.", "dropped");
      continue;
    }
    const rawId = item.id;
    let validId: PageId | null = null;
    if (typeof rawId !== "string" || !isPageId(rawId)) {
      problems.add(`${path}.id`, "page-object", "Expected non-empty string page id.");
    } else if (ids.has(rawId)) {
      problems.add(`${path}.id`, "page-id-unique", `Duplicate page id "${rawId}".`);
      const renamed = toPageId(`${rawId}__${String(index)}`);
      if (renamed && !ids.has(renamed)) {
        ids.add(renamed);
        validId = renamed;
      }
    } else {
      ids.add(rawId);
      validId = rawId;
    }
    const title = item.title;
    if (typeof title !== "string") {
      problems.add(`${path}.title`, "page-object", "Expected string page title.");
    }
    const rawStart = item.startedDateTime;
    let startedDateTime: IsoDateTime | null = null;
    if (typeof rawStart !== "string" || !isIsoDateTime(rawStart)) {
      problems.add(`${path}.startedDateTime`, "iso-datetime", "Expected ISO 8601 startedDateTime.");
    } else {
      startedDateTime = rawStart;
    }
    const pageTimings = parsePageTimings(item.pageTimings, `${path}.pageTimings`, problems);
    const comment = readOptionalComment(item, path, "page-object", problems);
    const keptStart = startedDateTime ?? salvageDate();
    if (validId && typeof title === "string" && keptStart && pageTimings) {
      pages.push({
        ...pickCustomFields(item, OWNED_FIELDS.page),
        startedDateTime: keptStart,
        id: validId,
        title,
        pageTimings,
        ...(comment !== undefined ? { comment } : {}),
      });
    } else {
      if (validId) {
        ids.delete(validId);
      }
      problems.add(
        path,
        "page-object",
        `Dropped page${typeof rawId === "string" && rawId.length > 0 ? ` "${rawId}"` : ""} because required page fields could not be salvaged.`,
        "dropped",
      );
    }
  }
  return { pages, ids };
}

function parseNameValueArray(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): readonly HarNameValue[] {
  if (!Array.isArray(value)) {
    problems.add(path, "name-value-array", `Expected ${path} to be an array.`);
    return [];
  }
  const result: HarNameValue[] = [];
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${String(index)}]`;
    const item = value[index];
    if (!isPlainRecord(item)) {
      problems.add(itemPath, "name-value-array", "Expected name/value object.");
      continue;
    }
    if (typeof item.name !== "string" || typeof item.value !== "string") {
      problems.add(itemPath, "name-value-array", "Expected string name and value.");
      continue;
    }
    const comment = readOptionalComment(item, itemPath, "name-value-array", problems);
    result.push({
      ...pickCustomFields(item, OWNED_FIELDS.nameValue),
      name: item.name,
      value: item.value,
      ...(comment !== undefined ? { comment } : {}),
    });
  }
  return result;
}

function parseCookieArray(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): readonly HarCookie[] {
  if (!Array.isArray(value)) {
    problems.add(path, "cookie-array", `Expected ${path} to be an array.`);
    return [];
  }
  const result: HarCookie[] = [];
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${String(index)}]`;
    const item = value[index];
    if (!isPlainRecord(item)) {
      problems.add(itemPath, "cookie-array", "Expected cookie object.");
      continue;
    }
    if (typeof item.name !== "string" || typeof item.value !== "string") {
      problems.add(itemPath, "cookie-array", "Expected cookie string name and value.");
      continue;
    }
    for (const optionalKey of ["path", "domain"] as const) {
      const val = item[optionalKey];
      if (val !== undefined && typeof val !== "string") {
        problems.add(
          `${itemPath}.${optionalKey}`,
          "cookie-array",
          `Expected cookie ${optionalKey} to be a string.`,
        );
      }
    }
    for (const boolKey of ["httpOnly", "secure"] as const) {
      const val = item[boolKey];
      if (val !== undefined && typeof val !== "boolean") {
        problems.add(
          `${itemPath}.${boolKey}`,
          "cookie-array",
          `Expected cookie ${boolKey} to be a boolean.`,
        );
      }
    }
    let expires: string | null | undefined;
    if (item.expires === null) {
      problems.add(
        `${itemPath}.expires`,
        "browser-cookie-expires",
        "Session cookie expires is null. Kept because browsers emit null instead of omitting it.",
      );
      expires = null;
    } else if (typeof item.expires === "string") {
      if (item.expires !== "" && !isIsoDateTime(item.expires)) {
        problems.add(
          `${itemPath}.expires`,
          "iso-datetime",
          "Expected cookie expires to be a valid ISO 8601 timestamp.",
        );
      }
      expires = item.expires;
    } else if (item.expires !== undefined) {
      problems.add(
        `${itemPath}.expires`,
        "iso-datetime",
        "Expected cookie expires to be a valid ISO 8601 timestamp.",
      );
    }
    const comment = readOptionalComment(item, itemPath, "cookie-array", problems);
    result.push({
      ...pickCustomFields(item, OWNED_FIELDS.cookie),
      name: item.name,
      value: item.value,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.domain === "string" ? { domain: item.domain } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(typeof item.httpOnly === "boolean" ? { httpOnly: item.httpOnly } : {}),
      ...(typeof item.secure === "boolean" ? { secure: item.secure } : {}),
      ...(comment !== undefined ? { comment } : {}),
    });
  }
  return result;
}

function parseMimeField(raw: unknown, path: string, problems: ProblemCollector): string | null {
  if (typeof raw !== "string") {
    problems.add(path, "mime-type", "Expected MIME type string.");
    return null;
  }
  if (raw === "") {
    return "";
  }
  if (!isMimeType(raw)) {
    problems.add(
      path,
      "mime-type",
      `Content type "${raw}" is not a type/subtype. Kept because browsers and servers emit it.`,
    );
    return raw;
  }
  return raw;
}

function parsePostData(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): HarPostData | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    problems.add(path, "post-data-object", "Expected postData to be an object.");
    return undefined;
  }
  const mimeType = parseMimeField(value.mimeType, `${path}.mimeType`, problems);
  const hasParams = value.params !== undefined;
  const hasText = value.text !== undefined;
  if (!hasParams && !hasText) {
    problems.add(path, "post-data-object", "Expected postData to provide params or text.");
  }
  const params: HarPostDataParam[] = [];
  if (hasParams) {
    if (!Array.isArray(value.params)) {
      problems.add(
        `${path}.params`,
        "post-data-object",
        "Expected postData.params to be an array.",
      );
    } else {
      for (let index = 0; index < value.params.length; index++) {
        const paramPath = `${path}.params[${String(index)}]`;
        const param = value.params[index];
        if (!isPlainRecord(param) || typeof param.name !== "string") {
          problems.add(
            paramPath,
            "post-data-param-object",
            "Expected postData param object with string name.",
          );
          continue;
        }
        for (const strKey of ["value", "fileName", "contentType"] as const) {
          if (param[strKey] !== undefined && typeof param[strKey] !== "string") {
            problems.add(
              `${paramPath}.${strKey}`,
              "post-data-param-object",
              `Expected ${strKey} to be a string.`,
            );
          }
        }
        const paramComment = readOptionalComment(
          param,
          paramPath,
          "post-data-param-object",
          problems,
        );
        params.push({
          ...pickCustomFields(param, OWNED_FIELDS.postParam),
          name: param.name,
          ...(typeof param.value === "string" ? { value: param.value } : {}),
          ...(typeof param.fileName === "string" ? { fileName: param.fileName } : {}),
          ...(typeof param.contentType === "string" ? { contentType: param.contentType } : {}),
          ...(paramComment !== undefined ? { comment: paramComment } : {}),
        });
      }
    }
  }
  let text: string | null = "";
  if (value.text === null) {
    problems.add(
      `${path}.text`,
      "post-data-object",
      "postData.text is null. Kept because the exporter had no text.",
      "note",
    );
    text = null;
  } else if (hasText) {
    if (typeof value.text !== "string") {
      problems.add(`${path}.text`, "post-data-object", "Expected postData.text to be a string.");
    } else {
      text = value.text;
    }
  }
  const comment = readOptionalComment(value, path, "post-data-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.postData),
    mimeType: mimeType ?? "",
    params,
    text,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseRequest(value: unknown, path: string, problems: ProblemCollector): HarRequest | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "request-object", "Expected entry.request to be an object.");
    return null;
  }
  const method = value.method;
  if (typeof method !== "string" || method.length === 0) {
    problems.add(`${path}.method`, "request-object", "Expected non-empty request method.");
  }
  const rawUrl = value.url;
  let url: HarUrl | null = null;
  if (typeof rawUrl !== "string" || !isHarUrl(rawUrl)) {
    problems.add(`${path}.url`, "request-url", "Expected valid absolute request URL.");
  } else {
    url = rawUrl;
  }
  const httpVersion = value.httpVersion;
  if (typeof httpVersion !== "string") {
    problems.add(`${path}.httpVersion`, "request-object", "Expected string httpVersion.");
  }
  const cookies = parseCookieArray(value.cookies, `${path}.cookies`, problems);
  const headers = parseNameValueArray(value.headers, `${path}.headers`, problems);
  const queryString = parseNameValueArray(value.queryString, `${path}.queryString`, problems);
  const postData = parsePostData(value.postData, `${path}.postData`, problems);
  if (!isSizeOrSentinel(value.headersSize)) {
    problems.add(
      `${path}.headersSize`,
      "size-or-sentinel",
      "Expected request.headersSize to be a finite number >= -1.",
    );
  }
  if (!isSizeOrSentinel(value.bodySize)) {
    problems.add(
      `${path}.bodySize`,
      "size-or-sentinel",
      "Expected request.bodySize to be a finite number >= -1.",
    );
  }
  const comment = readOptionalComment(value, path, "request-object", problems);
  if (!url) {
    return null;
  }
  const methodText = typeof method === "string" && method.length > 0 ? method : "";
  const httpVersionText = typeof httpVersion === "string" ? httpVersion : "";
  return {
    ...pickCustomFields(value, OWNED_FIELDS.request),
    method: methodText,
    url,
    httpVersion: httpVersionText,
    cookies,
    headers,
    queryString,
    ...(postData !== undefined ? { postData } : {}),
    headersSize: isSizeOrSentinel(value.headersSize) ? value.headersSize : -1,
    bodySize: isSizeOrSentinel(value.bodySize) ? value.bodySize : -1,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseContent(value: unknown, path: string, problems: ProblemCollector): HarContent | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "content-object", "Expected response.content to be an object.");
    return null;
  }
  if (!isSizeOrSentinel(value.size)) {
    problems.add(
      `${path}.size`,
      "size-or-sentinel",
      "Expected content.size to be a finite number >= -1.",
    );
  }
  const parsedMime = parseMimeField(value.mimeType, `${path}.mimeType`, problems);
  const mimeType = parsedMime ?? "";
  let compression: number | undefined;
  if (value.compression !== undefined) {
    if (typeof value.compression === "number" && Number.isFinite(value.compression)) {
      compression = value.compression;
    } else {
      problems.add(
        `${path}.compression`,
        "non-negative-number",
        "Expected content.compression to be a finite number.",
      );
    }
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    problems.add(`${path}.text`, "content-object", "Expected content.text to be a string.");
  }
  if (value.encoding !== undefined && typeof value.encoding !== "string") {
    problems.add(`${path}.encoding`, "content-object", "Expected content.encoding to be a string.");
  }
  const comment = readOptionalComment(value, path, "content-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.content),
    size: isSizeOrSentinel(value.size) ? value.size : -1,
    ...(compression !== undefined ? { compression } : {}),
    mimeType,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.encoding === "string" ? { encoding: value.encoding } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseRedirectUrl(value: unknown, path: string, problems: ProblemCollector): string | null {
  if (typeof value !== "string") {
    problems.add(path, "redirect-url", "Expected redirectURL to be a string.");
    return null;
  }
  if (value === "") {
    return "";
  }
  if (!isHarUrl(value)) {
    problems.add(
      path,
      "redirect-url",
      `Redirect URL "${value}" is not absolute. Kept because browsers copy Location raw.`,
    );
    return value;
  }
  return value;
}

function parseResponse(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): HarResponse | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "response-object", "Expected entry.response to be an object.");
    return null;
  }
  const status = value.status;
  const validStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 999;
  if (!validStatus) {
    problems.add(
      `${path}.status`,
      "response-status",
      "Expected response.status to be an integer from 0 to 999.",
    );
  }
  if (typeof value.statusText !== "string") {
    problems.add(`${path}.statusText`, "response-object", "Expected string statusText.");
  }
  if (typeof value.httpVersion !== "string") {
    problems.add(`${path}.httpVersion`, "response-object", "Expected string httpVersion.");
  }
  const cookies = parseCookieArray(value.cookies, `${path}.cookies`, problems);
  const headers = parseNameValueArray(value.headers, `${path}.headers`, problems);
  const content = parseContent(value.content, `${path}.content`, problems);
  const redirectURL = parseRedirectUrl(value.redirectURL, `${path}.redirectURL`, problems);
  if (!isSizeOrSentinel(value.headersSize)) {
    problems.add(
      `${path}.headersSize`,
      "size-or-sentinel",
      "Expected response.headersSize to be a finite number >= -1.",
    );
  }
  if (!isSizeOrSentinel(value.bodySize)) {
    problems.add(
      `${path}.bodySize`,
      "size-or-sentinel",
      "Expected response.bodySize to be a finite number >= -1.",
    );
  }
  const comment = readOptionalComment(value, path, "response-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.response),
    status: typeof status === "number" && validStatus ? status : 0,
    statusText: typeof value.statusText === "string" ? value.statusText : "",
    httpVersion: typeof value.httpVersion === "string" ? value.httpVersion : "",
    cookies,
    headers,
    content: content ?? { size: -1, mimeType: "" },
    redirectURL: redirectURL ?? "",
    headersSize: isSizeOrSentinel(value.headersSize) ? value.headersSize : -1,
    bodySize: isSizeOrSentinel(value.bodySize) ? value.bodySize : -1,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseCacheEntry(
  value: unknown,
  path: string,
  problems: ProblemCollector,
): HarCacheEntry | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    problems.add(path, "cache-entry-object", "Expected cache entry to be an object or null.");
    return undefined;
  }
  for (const strKey of ["expires", "lastAccess", "lastFetched", "eTag"] as const) {
    if (value[strKey] !== undefined && typeof value[strKey] !== "string") {
      problems.add(
        `${path}.${strKey}`,
        "cache-entry-object",
        `Expected cache ${strKey} to be a string.`,
      );
    }
  }
  if (value.hitCount !== undefined && !isNonNegativeNumber(value.hitCount)) {
    problems.add(
      `${path}.hitCount`,
      "non-negative-number",
      "Expected cache hitCount to be a finite number >= 0.",
    );
  }
  if (
    value.fetchCount !== undefined &&
    !isNonNegativeNumber(value.fetchCount) &&
    !(
      typeof value.fetchCount === "string" &&
      (value.fetchCount === "" || NUMERIC_STRING_PATTERN.test(value.fetchCount))
    )
  ) {
    problems.add(
      `${path}.fetchCount`,
      "cache-entry-object",
      "Expected cache fetchCount to be a non-negative number or numeric string.",
    );
  }
  const comment = readOptionalComment(value, path, "cache-entry-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.cacheEntry),
    ...(typeof value.expires === "string" ? { expires: value.expires } : {}),
    ...(typeof value.lastAccess === "string" ? { lastAccess: value.lastAccess } : {}),
    ...(typeof value.lastFetched === "string" ? { lastFetched: value.lastFetched } : {}),
    ...(typeof value.eTag === "string" ? { eTag: value.eTag } : {}),
    ...(isNonNegativeNumber(value.hitCount) ? { hitCount: value.hitCount } : {}),
    ...(typeof value.fetchCount === "number" || typeof value.fetchCount === "string"
      ? { fetchCount: value.fetchCount }
      : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseCache(value: unknown, path: string, problems: ProblemCollector): HarCache | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "cache-object", "Expected entry.cache to be an object.");
    return null;
  }
  const beforeRequest = parseCacheEntry(value.beforeRequest, `${path}.beforeRequest`, problems);
  const afterRequest = parseCacheEntry(value.afterRequest, `${path}.afterRequest`, problems);
  const comment = readOptionalComment(value, path, "cache-object", problems);
  return {
    ...pickCustomFields(value, OWNED_FIELDS.cache),
    ...(beforeRequest !== undefined ? { beforeRequest } : {}),
    ...(afterRequest !== undefined ? { afterRequest } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function parseTimings(value: unknown, path: string, problems: ProblemCollector): HarTimings | null {
  if (!isPlainRecord(value)) {
    problems.add(path, "timings-object", "Expected entry.timings to be an object.");
    return null;
  }
  const optionalPhases = ["blocked", "dns", "connect", "ssl"] as const;
  const parsedOptional: Partial<Record<(typeof optionalPhases)[number], number>> = {};
  for (const key of optionalPhases) {
    const raw = value[key];
    if (raw === undefined) {
      continue;
    }
    if (!isSizeOrSentinel(raw)) {
      problems.add(
        `${path}.${key}`,
        "timing-or-sentinel",
        `Expected timings.${key} to be a finite number >= -1.`,
      );
    } else {
      parsedOptional[key] = raw;
    }
  }
  const requiredPhases = ["send", "wait", "receive"] as const;
  const parsedRequired: Partial<Record<(typeof requiredPhases)[number], number>> = {};
  for (const key of requiredPhases) {
    const raw = value[key];
    if (raw === undefined) {
      problems.add(
        `${path}.${key}`,
        "browser-timings",
        `Missing timings.${key}. Kept as 0 because browsers omit phases they did not measure.`,
      );
      parsedRequired[key] = 0;
      continue;
    }
    if (!isNonNegativeNumber(raw)) {
      problems.add(
        `${path}.${key}`,
        "non-negative-number",
        `Expected timings.${key} to be a finite number >= 0.`,
      );
      parsedRequired[key] = 0;
    } else {
      parsedRequired[key] = raw;
    }
  }
  const comment = readOptionalComment(value, path, "timings-object", problems);
  if (
    parsedRequired.send === undefined ||
    parsedRequired.wait === undefined ||
    parsedRequired.receive === undefined
  ) {
    return null;
  }
  return {
    ...pickCustomFields(value, OWNED_FIELDS.timings),
    ...(parsedOptional.blocked !== undefined ? { blocked: parsedOptional.blocked } : {}),
    ...(parsedOptional.dns !== undefined ? { dns: parsedOptional.dns } : {}),
    ...(parsedOptional.connect !== undefined ? { connect: parsedOptional.connect } : {}),
    send: parsedRequired.send,
    wait: parsedRequired.wait,
    receive: parsedRequired.receive,
    ...(parsedOptional.ssl !== undefined ? { ssl: parsedOptional.ssl } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function readRawRequestMeta(rawRequest: unknown): {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly suffix: string;
} {
  if (!isPlainRecord(rawRequest)) {
    return { suffix: "" };
  }
  const method =
    typeof rawRequest.method === "string" && rawRequest.method.length > 0
      ? rawRequest.method
      : undefined;
  const url =
    typeof rawRequest.url === "string" && rawRequest.url.length > 0 ? rawRequest.url : undefined;
  const parts = [method, url].filter((part): part is string => part !== undefined);
  return {
    ...(method !== undefined ? { method } : {}),
    ...(url !== undefined ? { url } : {}),
    suffix: parts.length > 0 ? ` (${parts.join(" ")})` : "",
  };
}

function parseEntries(
  rawEntries: unknown,
  pageIds: ReadonlySet<PageId>,
  problems: ProblemCollector,
): readonly HarEntry[] {
  if (!Array.isArray(rawEntries)) {
    problems.add("$.log.entries", "entries-array", "Expected log.entries to be an array.");
    return [];
  }
  const entries: HarEntry[] = [];
  for (let index = 0; index < rawEntries.length; index++) {
    const path = `$.log.entries[${String(index)}]`;
    const item = rawEntries[index];
    if (!isPlainRecord(item)) {
      const hint = typeof item === "string" && item.length > 0 ? ` (${item})` : "";
      problems.add(path, "entry-object", `Expected entry to be an object.${hint}`, "dropped");
      continue;
    }
    let pageref: PageId | undefined;
    if (item.pageref !== undefined) {
      if (
        typeof item.pageref !== "string" ||
        !isPageId(item.pageref) ||
        !pageIds.has(item.pageref)
      ) {
        problems.add(
          `${path}.pageref`,
          "entry-pageref-exists",
          `Expected pageref to match an existing page id.`,
        );
      } else {
        pageref = item.pageref;
      }
    }
    let startedDateTime: IsoDateTime | null = null;
    if (typeof item.startedDateTime !== "string" || !isIsoDateTime(item.startedDateTime)) {
      problems.add(`${path}.startedDateTime`, "iso-datetime", "Expected ISO 8601 startedDateTime.");
    } else {
      startedDateTime = item.startedDateTime;
    }
    if (!isNonNegativeNumber(item.time)) {
      problems.add(
        `${path}.time`,
        "non-negative-number",
        "Expected entry.time to be a finite number >= 0.",
      );
    }
    for (const optStr of ["serverIPAddress", "connection"] as const) {
      if (item[optStr] !== undefined && typeof item[optStr] !== "string") {
        problems.add(`${path}.${optStr}`, "entry-object", `Expected ${optStr} to be a string.`);
      }
    }
    const request = parseRequest(item.request, `${path}.request`, problems);
    const response = parseResponse(item.response, `${path}.response`, problems);
    const cache = parseCache(item.cache, `${path}.cache`, problems);
    const timings = parseTimings(item.timings, `${path}.timings`, problems);
    const comment = readOptionalComment(item, path, "entry-object", problems);
    const requestMeta = readRawRequestMeta(item.request);

    if (!request) {
      problems.add(
        path,
        "entry-object",
        requestMeta.suffix.length > 0
          ? `Dropped this entry${requestMeta.suffix}: Dropped this entry because the request URL could not be salvaged.`
          : "Dropped this entry because the request URL could not be salvaged.",
        "dropped",
      );
      continue;
    }

    const custom = pickCustomFields(item, OWNED_FIELDS.entry) as CustomHarFields & {
      readonly _harExport?: HarEntryExtension | undefined;
    };
    const keptStart = startedDateTime ?? salvageDate();
    entries.push({
      ...custom,
      ...(pageref !== undefined ? { pageref } : {}),
      startedDateTime: keptStart,
      time: isNonNegativeNumber(item.time) ? item.time : 0,
      request,
      response: response ?? {
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
      cache: cache ?? {},
      timings: timings ?? { send: 0, wait: 0, receive: 0 },
      ...(typeof item.serverIPAddress === "string"
        ? { serverIPAddress: item.serverIPAddress }
        : {}),
      ...(typeof item.connection === "string" ? { connection: item.connection } : {}),
      ...(comment !== undefined ? { comment } : {}),
    });
  }
  return entries;
}

export function parseHar(input: unknown): HarParseResult {
  const problems = new ProblemCollector();
  if (!isPlainRecord(input) || !("log" in input)) {
    problems.add("$", "root-object", "Expected root HAR object containing a log property.");
    return { ok: false, problems: problems.items };
  }
  const rawLog = input.log;
  if (!isPlainRecord(rawLog)) {
    problems.add("$.log", "log-object", "Expected log to be an object.");
    return { ok: false, problems: problems.items };
  }

  const version = parseVersion(rawLog.version, "$.log.version", problems);
  const creator = parseCreatorLike(rawLog.creator, "$.log.creator", "creator-object", problems);
  const browser =
    rawLog.browser !== undefined
      ? parseCreatorLike(rawLog.browser, "$.log.browser", "browser-object", problems)
      : undefined;
  const { pages, ids } = parsePages(rawLog.pages, problems);
  const entries = parseEntries(rawLog.entries, ids, problems);
  const comment = readOptionalComment(rawLog, "$.log", "log-object", problems);

  const rejectsDocument = problems.items.some(
    (item) =>
      DOCUMENT_REJECTION_RULES.has(item.rule) &&
      (item.rule !== "creator-object" || item.severity === "error"),
  );
  if (rejectsDocument || version === null || !creator) {
    return { ok: false, problems: problems.items };
  }

  const custom = pickCustomFields(rawLog, OWNED_FIELDS.log) as CustomHarFields & {
    readonly _harExport?: HarLogExtension | undefined;
    readonly _harExportId?: string | undefined;
  };
  const log: HarLog = {
    ...custom,
    version,
    creator,
    ...(browser ? { browser } : {}),
    ...(rawLog.pages !== undefined ? { pages } : {}),
    entries,
    ...(comment !== undefined ? { comment } : {}),
  };

  return { ok: true, document: { log }, problems: problems.items };
}

export function parseHarJson(jsonText: string): HarParseResult {
  const withoutBom = jsonText.startsWith("\uFEFF") ? jsonText.slice(1) : jsonText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      problems: [
        {
          path: "$",
          rule: "json-syntax",
          severity: "error",
          message: `Invalid JSON: ${message}`,
        },
      ],
    };
  }
  return parseHar(parsed);
}
