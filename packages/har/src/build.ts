import {
  OWNED_FIELDS,
  pickCustomFields,
  safeDecodeQueryComponent,
  utf8ByteLength,
} from "./internal.ts";
import {
  isHarUrl,
  isMimeType,
  toPageId,
  type ChromeInitiator,
  type ChromeWebSocketMessage,
  type CustomHarFields,
  type FirefoxSecurityState,
  type HarCache,
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

export interface BuildHarPageInput extends CustomHarFields {
  readonly id?: PageId | undefined;
  readonly title: string;
  readonly startedDateTime: IsoDateTime;
  readonly pageTimings?: Partial<HarPageTimings> | undefined;
  readonly comment?: string | undefined;
}

export interface BuildHarPostDataInput extends CustomHarFields {
  readonly mimeType?: string | undefined;
  readonly params?: readonly HarPostDataParam[] | undefined;
  readonly text?: string | null | undefined;
  readonly comment?: string | undefined;
}

export interface BuildHarRequestInput extends CustomHarFields {
  readonly method: string;
  readonly url: HarUrl;
  readonly httpVersion?: string | undefined;
  readonly cookies?: readonly HarCookie[] | undefined;
  readonly headers?: readonly HarNameValue[] | undefined;
  readonly queryString?: readonly HarNameValue[] | undefined;
  readonly postData?: BuildHarPostDataInput | undefined;
  readonly headersSize?: number | undefined;
  readonly bodySize?: number | undefined;
  readonly comment?: string | undefined;
}

export interface BuildHarContentInput extends CustomHarFields {
  readonly size?: number | undefined;
  readonly compression?: number | undefined;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly encoding?: "base64" | (string & {}) | undefined;
  readonly comment?: string | undefined;
}

export interface BuildHarResponseInput extends CustomHarFields {
  readonly status?: number | undefined;
  readonly statusText?: string | undefined;
  readonly httpVersion?: string | undefined;
  readonly cookies?: readonly HarCookie[] | undefined;
  readonly headers?: readonly HarNameValue[] | undefined;
  readonly content?: BuildHarContentInput | undefined;
  readonly redirectURL?: string | undefined;
  readonly headersSize?: number | undefined;
  readonly bodySize?: number | undefined;
  readonly comment?: string | undefined;
  readonly _transferSize?: number | undefined;
  readonly _error?: string | null | undefined;
}

export interface BuildHarEntryInput extends CustomHarFields {
  readonly pageref?: PageId | undefined;
  readonly startedDateTime: IsoDateTime;
  readonly time?: number | undefined;
  readonly request: BuildHarRequestInput;
  readonly response: BuildHarResponseInput;
  readonly cache?: HarCache | undefined;
  readonly timings?: Partial<HarTimings> | undefined;
  readonly serverIPAddress?: string | undefined;
  readonly connection?: string | undefined;
  readonly comment?: string | undefined;
  readonly _securityState?: FirefoxSecurityState | undefined;
  readonly _priority?: string | undefined;
  readonly _initiator?: ChromeInitiator | undefined;
  readonly _resourceType?: string | undefined;
  readonly _fromCache?: "disk" | "memory" | (string & {}) | undefined;
  readonly _connectionId?: string | undefined;
  readonly _webSocketMessages?: readonly ChromeWebSocketMessage[] | undefined;
  readonly _harExport?: HarEntryExtension | undefined;
}

export interface BuildHarEntryOptions {
  readonly pages?: readonly HarPage[] | undefined;
  readonly pageIds?: ReadonlySet<PageId> | undefined;
}

export interface BuildHarInput extends CustomHarFields {
  readonly version?: string | undefined;
  readonly creator: HarCreator;
  readonly browser?: HarCreator | undefined;
  readonly pages?: readonly BuildHarPageInput[] | undefined;
  readonly entries: readonly BuildHarEntryInput[];
  readonly defaultPageTitle?: string | undefined;
  readonly comment?: string | undefined;
  readonly _harExport?: HarLogExtension | undefined;
}

const SPEC_TIME_PHASES = ["blocked", "dns", "connect", "send", "wait", "receive"] as const;

function parseUrlQueryString(url: HarUrl): readonly HarNameValue[] {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return [];
  }
  const hashStart = url.indexOf("#", queryStart + 1);
  const querySlice =
    hashStart === -1 ? url.slice(queryStart + 1) : url.slice(queryStart + 1, hashStart);
  if (querySlice.length === 0) {
    return [];
  }
  const pairs: HarNameValue[] = [];
  for (const segment of querySlice.split("&")) {
    if (segment.length === 0) {
      continue;
    }
    const eqIndex = segment.indexOf("=");
    if (eqIndex === -1) {
      pairs.push({ name: safeDecodeQueryComponent(segment), value: "" });
    } else {
      pairs.push({
        name: safeDecodeQueryComponent(segment.slice(0, eqIndex)),
        value: safeDecodeQueryComponent(segment.slice(eqIndex + 1)),
      });
    }
  }
  return pairs;
}

function findHeaderValue(headers: readonly HarNameValue[], headerName: string): string | undefined {
  const needle = headerName.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === needle) {
      return header.value;
    }
  }
  return undefined;
}

function allocatePageId(usedIds: Set<PageId>): PageId {
  let counter = 0;
  while (true) {
    const candidate = toPageId(`page_${String(counter)}`);
    if (candidate && !usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

function normalizePageTimings(timings: Partial<HarPageTimings> | undefined): HarPageTimings {
  if (!timings) {
    return { onContentLoad: -1, onLoad: -1 };
  }
  return {
    ...pickCustomFields(timings, OWNED_FIELDS.pageTimings),
    onContentLoad: timings.onContentLoad ?? -1,
    onLoad: timings.onLoad ?? -1,
    ...(timings.comment !== undefined ? { comment: timings.comment } : {}),
  };
}

function normalizePages(
  rawPages: readonly BuildHarPageInput[] | undefined,
  sortedEntries: readonly BuildHarEntryInput[],
  defaultPageTitle: string | undefined,
): readonly HarPage[] {
  const usedIds = new Set<PageId>();
  for (const page of rawPages ?? []) {
    if (page.id) {
      usedIds.add(page.id);
    }
  }

  const assignedIds = new Set<PageId>();
  const normalized = (rawPages ?? [])
    .map((page, index) => {
      const id = page.id && !assignedIds.has(page.id) ? page.id : allocatePageId(usedIds);
      assignedIds.add(id);
      return {
        index,
        epochMs: Date.parse(page.startedDateTime),
        page: {
          ...pickCustomFields(page, OWNED_FIELDS.page),
          startedDateTime: page.startedDateTime,
          id,
          title: page.title,
          pageTimings: normalizePageTimings(page.pageTimings),
          ...(page.comment !== undefined ? { comment: page.comment } : {}),
        } satisfies HarPage,
      };
    })
    .sort((left, right) => left.epochMs - right.epochMs || left.index - right.index)
    .map((item) => item.page);

  const earliestEntry = sortedEntries[0];
  if (!earliestEntry) {
    return normalized;
  }

  const earliestPage = normalized[0];
  if (
    !earliestPage ||
    Date.parse(earliestEntry.startedDateTime) < Date.parse(earliestPage.startedDateTime)
  ) {
    const fallbackPage: HarPage = {
      startedDateTime: earliestEntry.startedDateTime,
      id: allocatePageId(usedIds),
      title: defaultPageTitle ?? earliestEntry.request.url,
      pageTimings: { onContentLoad: -1, onLoad: -1 },
    };
    return [fallbackPage, ...normalized];
  }

  return normalized;
}

function resolvePageForEntry(
  entry: BuildHarEntryInput,
  sortedPages: readonly HarPage[],
  pageIds: ReadonlySet<PageId>,
): PageId | undefined {
  if (entry.pageref && pageIds.has(entry.pageref)) {
    return entry.pageref;
  }
  if (sortedPages.length === 0) {
    return undefined;
  }
  const entryEpoch = Date.parse(entry.startedDateTime);
  let chosen = sortedPages[0]!;
  for (const page of sortedPages) {
    if (Date.parse(page.startedDateTime) <= entryEpoch) {
      chosen = page;
    } else {
      break;
    }
  }
  return chosen.id;
}

function normalizeTimings(raw: Partial<HarTimings> | undefined): HarTimings {
  const custom = raw ? pickCustomFields(raw, OWNED_FIELDS.timings) : {};
  return {
    ...custom,
    ...(raw?.blocked !== undefined ? { blocked: raw.blocked } : {}),
    ...(raw?.dns !== undefined ? { dns: raw.dns } : {}),
    ...(raw?.connect !== undefined ? { connect: raw.connect } : {}),
    send: raw?.send ?? 0,
    wait: raw?.wait ?? 0,
    receive: raw?.receive ?? 0,
    ...(raw?.ssl !== undefined ? { ssl: raw.ssl } : {}),
    ...(raw?.comment !== undefined ? { comment: raw.comment } : {}),
  };
}

function sumEntryTimings(timings: HarTimings): number {
  let total = 0;
  for (const key of SPEC_TIME_PHASES) {
    const value = timings[key];
    if (value !== undefined && value >= 0) {
      total += value;
    }
  }
  return total;
}

function normalizePostData(
  raw: BuildHarPostDataInput | undefined,
  headers: readonly HarNameValue[],
): HarPostData | undefined {
  if (!raw) {
    return undefined;
  }
  const headerContentType = findHeaderValue(headers, "content-type");
  const fallbackMime = headerContentType && isMimeType(headerContentType) ? headerContentType : "";
  return {
    ...pickCustomFields(raw, OWNED_FIELDS.postData),
    mimeType: raw.mimeType ?? fallbackMime,
    params: raw.params ?? [],
    text: raw.text === undefined ? "" : raw.text,
    ...(raw.comment !== undefined ? { comment: raw.comment } : {}),
  };
}

function normalizeRequest(raw: BuildHarRequestInput): HarRequest {
  const headers = raw.headers ?? [];
  const postData = normalizePostData(raw.postData, headers);
  const bodySize =
    raw.bodySize ??
    (typeof postData?.text === "string" && postData.text.length > 0
      ? utf8ByteLength(postData.text)
      : -1);
  return {
    ...pickCustomFields(raw, OWNED_FIELDS.request),
    method: raw.method,
    url: raw.url,
    httpVersion: raw.httpVersion ?? "",
    cookies: raw.cookies ?? [],
    headers,
    queryString: raw.queryString ?? parseUrlQueryString(raw.url),
    ...(postData !== undefined ? { postData } : {}),
    headersSize: raw.headersSize ?? -1,
    bodySize,
    ...(raw.comment !== undefined ? { comment: raw.comment } : {}),
  };
}

function normalizeContent(
  raw: BuildHarContentInput | undefined,
  headers: readonly HarNameValue[],
): HarContent {
  const headerContentType = findHeaderValue(headers, "content-type");
  const fallbackMime = headerContentType && isMimeType(headerContentType) ? headerContentType : "";
  const defaultSize =
    raw?.text !== undefined && raw.encoding !== "base64" ? utf8ByteLength(raw.text) : -1;
  return {
    ...(raw ? pickCustomFields(raw, OWNED_FIELDS.content) : {}),
    size: raw?.size ?? defaultSize,
    ...(raw?.compression !== undefined ? { compression: raw.compression } : {}),
    mimeType: raw?.mimeType ?? fallbackMime,
    ...(raw?.text !== undefined ? { text: raw.text } : {}),
    ...(raw?.encoding !== undefined ? { encoding: raw.encoding } : {}),
    ...(raw?.comment !== undefined ? { comment: raw.comment } : {}),
  };
}

function normalizeResponse(raw: BuildHarResponseInput): HarResponse {
  const status = raw.status ?? 0;
  const headers = raw.headers ?? [];
  const locationHeader = findHeaderValue(headers, "location");
  const fallbackRedirect = locationHeader && isHarUrl(locationHeader) ? locationHeader : "";
  const content = normalizeContent(raw.content, headers);
  const bodySize = raw.bodySize ?? (status === 304 ? 0 : -1);
  return {
    ...pickCustomFields(raw, OWNED_FIELDS.response),
    status,
    statusText: raw.statusText ?? "",
    httpVersion: raw.httpVersion ?? "",
    cookies: raw.cookies ?? [],
    headers,
    content,
    redirectURL: raw.redirectURL ?? fallbackRedirect,
    headersSize: raw.headersSize ?? -1,
    bodySize,
    ...(raw.comment !== undefined ? { comment: raw.comment } : {}),
  };
}

export function buildHarEntry(entry: BuildHarEntryInput, options?: BuildHarEntryOptions): HarEntry {
  const timings = normalizeTimings(entry.timings);
  let pageref: PageId | undefined;
  if (options?.pages !== undefined) {
    const pageIds = options.pageIds ?? new Set(options.pages.map((page) => page.id));
    pageref = resolvePageForEntry(entry, options.pages, pageIds);
  } else if (options?.pageIds !== undefined) {
    pageref = entry.pageref && options.pageIds.has(entry.pageref) ? entry.pageref : undefined;
  } else {
    pageref = entry.pageref;
  }
  return {
    ...pickCustomFields(entry, OWNED_FIELDS.entry),
    ...(pageref !== undefined ? { pageref } : {}),
    startedDateTime: entry.startedDateTime,
    time: entry.time ?? sumEntryTimings(timings),
    request: normalizeRequest(entry.request),
    response: normalizeResponse(entry.response),
    cache: entry.cache ?? {},
    timings,
    ...(entry.serverIPAddress !== undefined ? { serverIPAddress: entry.serverIPAddress } : {}),
    ...(entry.connection !== undefined ? { connection: entry.connection } : {}),
    ...(entry.comment !== undefined ? { comment: entry.comment } : {}),
  };
}

export function buildHar(input: BuildHarInput): HarDocument {
  if (input.creator.name.length === 0 || input.creator.version.length === 0) {
    throw new TypeError("buildHar requires a creator name and version.");
  }
  const sortedInputs = input.entries
    .map((entry, index) => ({
      entry,
      index,
      epochMs: Date.parse(entry.startedDateTime),
    }))
    .sort((left, right) => left.epochMs - right.epochMs || left.index - right.index)
    .map((item) => item.entry);

  const pages = normalizePages(input.pages, sortedInputs, input.defaultPageTitle);
  const pageIds = new Set(pages.map((page) => page.id));

  const entries: HarEntry[] = sortedInputs.map((entry) => buildHarEntry(entry, { pages, pageIds }));

  const log: HarLog = {
    ...pickCustomFields(input, new Set([...OWNED_FIELDS.log, "defaultPageTitle"])),
    version: input.version && input.version.length > 0 ? input.version : "1.2",
    creator: input.creator,
    ...(input.browser !== undefined ? { browser: input.browser } : {}),
    pages,
    entries,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };

  return { log };
}
