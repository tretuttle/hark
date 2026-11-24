import type { ExchangeFacts, RequestFacts, ResponseFacts, StopFacts } from "../src/exchange.ts";
import type { ByteCount, EpochMs, ExchangeId, RunId, Site } from "../src/ids.ts";

export const RUN = "mhz02" as RunId;
export const SITE = "example.com" as Site;
export const ID = "mhz02.15032385539" as ExchangeId;
export const T0 = 1_794_800_000_000 as EpochMs;

export const request: RequestFacts = {
  id: ID,
  url: "https://example.com/api/items?page=2",
  method: "GET",
  httpVersion: "HTTP/1.1",
  headers: [
    ["Accept", "application/json"],
    ["Cookie", null],
  ],
  startedAt: T0,
  tab: { run: RUN, browserId: 7 },
  topSite: SITE,
  policyType: 20,
};

export const response: ResponseFacts = {
  status: 200,
  statusText: "OK",
  httpVersion: "HTTP/1.1",
  headers: [["Content-Type", "application/json; charset=utf-8"]],
  mimeType: "application/json",
  contentLength: 14 as ByteCount,
  contentEncoding: null,
  source: "network",
  redirectTo: null,
  remoteAddress: "93.184.216.34",
};

export const stop: StopFacts = {
  status: { kind: "ok" },
  endedAt: (T0 + 41) as EpochMs,
  timings: { blocked: 1, dns: null, connect: null, ssl: null, send: 0, wait: 38, receive: 2 },
  transferSize: 312 as ByteCount,
  encodedBodySize: 14 as ByteCount,
};

export const facts: ExchangeFacts = { request, response };
