import { buildHarEntry } from "@hark/har/build";
import { isoDateTimeFromEpochMs, toHarUrl, type HarEntry } from "@hark/har/model";
import type {
  BodyLocation,
  NetError,
  RequestFacts,
  ResponseFacts,
  StopFacts,
} from "@hark/recording/exchange";
import {
  exchangeId,
  toMinute,
  type ByteCount,
  type ChannelKey,
  type EpochMs,
  type PackId,
  type RunId,
  type Site,
  type TabKey,
} from "@hark/recording/ids";
import type { BodyCandidates, Material, SourceItem, SourceName, SourceRef } from "../src/source.ts";

export const RUN_ID = "mhz02" as RunId;
export const OLD_RUN_ID = "mhz01" as RunId;
const SITE = "app.example" as Site;
const TAB_KEY: TabKey = { run: RUN_ID, browserId: 7 };
export const T0 = 1_794_800_040_000 as EpochMs;
export const M0 = toMinute(T0);

export const EX_ID = exchangeId(RUN_ID, "101" as ChannelKey);
export const PACK_AT: BodyLocation = {
  kind: "pack",
  pack: `${SITE}/${RUN_ID}-0` as PackId,
  offset: 0,
  length: 14 as ByteCount,
};

export const requestFacts: RequestFacts = {
  id: EX_ID,
  url: "https://app.example/api/data?page=1",
  method: "GET",
  httpVersion: "HTTP/2.0",
  headers: [
    ["host", "app.example"],
    ["cookie", "sid=secret-cookie"],
  ],
  startedAt: T0,
  tab: TAB_KEY,
  topSite: SITE,
  policyType: 20,
};

export const responseFacts: ResponseFacts = {
  status: 200,
  statusText: "OK",
  httpVersion: "HTTP/2.0",
  headers: [["content-type", "application/json; charset=utf-8"]],
  mimeType: "application/json",
  contentLength: 14 as ByteCount,
  contentEncoding: null,
  source: "network",
  redirectTo: null,
  remoteAddress: "93.184.216.34",
};

export const stopFacts: StopFacts = {
  status: { kind: "ok" },
  endedAt: (T0 + 45) as EpochMs,
  timings: {
    blocked: 1,
    dns: 2,
    connect: 5,
    ssl: 3,
    send: 2,
    wait: 25,
    receive: 10,
  },
  transferSize: 120 as ByteCount,
  encodedBodySize: 14 as ByteCount,
};

export const failStopFacts: StopFacts = {
  status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" as NetError },
  endedAt: (T0 + 12) as EpochMs,
  timings: {
    blocked: 0,
    dns: null,
    connect: null,
    ssl: null,
    send: 0,
    wait: 0,
    receive: 0,
  },
  transferSize: 0 as ByteCount,
  encodedBodySize: 0 as ByteCount,
};

export function makeSourceItem(
  overrides: Partial<SourceItem> & { readonly source: SourceName },
): SourceItem {
  const startedAt = overrides.startedAt ?? T0;
  return {
    source: overrides.source,
    key: overrides.key !== undefined ? overrides.key : EX_ID,
    startedAt,
    startedMinute: overrides.startedMinute ?? toMinute(startedAt),
    url: overrides.url ?? "https://app.example/api/data",
    method: overrides.method ?? "GET",
    tab: overrides.tab !== undefined ? overrides.tab : TAB_KEY,
    site: overrides.site !== undefined ? overrides.site : SITE,
    navigation: overrides.navigation ?? false,
    fetchOrXhr: overrides.fetchOrXhr ?? true,
    inProgress: overrides.inProgress ?? false,
    ref: overrides.ref ?? ("ref" as unknown as SourceRef),
  };
}

export function makeHarEntry(
  overrides: {
    readonly url?: string;
    readonly startedAt?: EpochMs;
    readonly status?: number;
    readonly statusText?: string;
    readonly mimeType?: string;
    readonly headers?: readonly { readonly name: string; readonly value: string }[];
    readonly timings?: Partial<HarEntry["timings"]>;
    readonly serverIPAddress?: string;
    readonly connection?: string;
    readonly _securityState?: string;
    readonly _priority?: string;
    readonly _connectionId?: string;
    readonly _resourceType?: string;
    readonly _fromCache?: string;
    readonly bodySize?: number;
    readonly _transferSize?: number;
  } = {},
): HarEntry {
  return buildHarEntry({
    startedDateTime: isoDateTimeFromEpochMs(overrides.startedAt ?? T0),
    request: {
      method: "GET",
      url: toHarUrl(overrides.url ?? "https://app.example/api/data")!,
      httpVersion: "HTTP/2.0",
      headers: overrides.headers ?? [{ name: "Accept", value: "application/json" }],
      headersSize: 64,
      bodySize: -1,
    },
    response: {
      status: overrides.status ?? 200,
      statusText: overrides.statusText ?? "OK",
      httpVersion: "HTTP/2.0",
      headers: [{ name: "Content-Type", value: overrides.mimeType ?? "application/json" }],
      content: { size: -1, mimeType: overrides.mimeType ?? "application/json" },
      headersSize: 80,
      bodySize: overrides.bodySize ?? 14,
      ...(overrides._transferSize !== undefined ? { _transferSize: overrides._transferSize } : {}),
    },
    timings: overrides.timings ?? {
      blocked: 1,
      dns: 2,
      connect: 3,
      ssl: 4,
      send: 5,
      wait: 6,
      receive: 7,
    },
    ...(overrides.serverIPAddress !== undefined
      ? { serverIPAddress: overrides.serverIPAddress }
      : {}),
    ...(overrides.connection !== undefined ? { connection: overrides.connection } : {}),
    ...(overrides._securityState !== undefined ? { _securityState: overrides._securityState } : {}),
    ...(overrides._priority !== undefined ? { _priority: overrides._priority } : {}),
    ...(overrides._connectionId !== undefined ? { _connectionId: overrides._connectionId } : {}),
    ...(overrides._resourceType !== undefined ? { _resourceType: overrides._resourceType } : {}),
    ...(overrides._fromCache !== undefined ? { _fromCache: overrides._fromCache } : {}),
  });
}

export function makeMaterial(
  entry: HarEntry,
  body: BodyCandidates = { kind: "empty" },
  upload: BodyCandidates = { kind: "empty" },
): Material {
  return { entry, body, upload };
}
