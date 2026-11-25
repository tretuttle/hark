import * as HarValidator from "har-validator";
import type {
  AbandonedExchange,
  AnsweredExchange,
  LiveExchange,
  UnansweredExchange,
} from "@hark/recording/exchange";
import type { ByteCount } from "@hark/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import { materialFromRecording } from "../src/from-recording.ts";
import { PACK_AT, failStopFacts, requestFacts, responseFacts, stopFacts } from "./fixtures.ts";

function asHarDoc(entry: ReturnType<typeof materialFromRecording>["entry"]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Hark", version: "0.0.0" },
      entries: [entry],
    },
  };
}

describe("materialFromRecording validates against HAR 1.2 schema", () => {
  it("maps answered exchange with stored body, Set-Cookie Expires conversion, and upload", async () => {
    const settled: AnsweredExchange = {
      kind: "answered",
      request: {
        ...requestFacts,
        method: "POST",
        headers: [
          ["cookie", "a=1; b=two"],
          ["content-type", "application/json"],
        ],
      },
      response: {
        ...responseFacts,
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["set-cookie", "s=xyz; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure"],
        ],
        source: "cache",
      },
      stop: stopFacts,
      route: "small",
      body: { kind: "stored", at: PACK_AT, encoding: null, check: "length-matched" },
      upload: { kind: "stored", at: PACK_AT, mimeType: "application/json" },
    };

    const mat = materialFromRecording({
      kind: "settled",
      settled,
      body: { kind: "available", at: PACK_AT, encoding: null, check: "length-matched" },
      upload: { kind: "available", at: PACK_AT, encoding: null, check: "length-matched" },
    });

    expect(mat.entry.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(mat.entry.request.cookies).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "two" },
    ]);
    expect(mat.entry.request.queryString).toEqual([{ name: "page", value: "1" }]);
    expect(mat.entry.response.cookies[0]).toMatchObject({
      name: "s",
      value: "xyz",
      path: "/",
      expires: "2015-10-21T07:28:00.000Z",
      httpOnly: true,
      secure: true,
    });
    expect(mat.entry.response.bodySize).toBe(14);
    expect(mat.entry._resourceType).toBe("fetch");
    expect(mat.entry._fromCache).toBe("disk");
    expect(mat.body.kind).toBe("candidates");
    expect(mat.upload.kind).toBe("candidates");

    const doc = asHarDoc(mat.entry);
    await expect(HarValidator.har(doc)).resolves.toBe(doc);
  });

  it("maps unanswered exchange with status 0, response._error, and no-response body reason", async () => {
    const settled: UnansweredExchange = {
      kind: "unanswered",
      request: requestFacts,
      stop: failStopFacts,
      upload: { kind: "none" },
    };

    const mat = materialFromRecording({
      kind: "settled",
      settled,
      body: { kind: "missing", reason: "no-response" },
      upload: { kind: "empty" },
    });

    expect(mat.entry.response.status).toBe(0);
    expect(mat.entry.response.statusText).toBe("");
    expect(mat.entry.response.headers).toEqual([]);
    expect(mat.entry.response._error).toBe("NS_ERROR_CONNECTION_REFUSED");
    expect(mat.body).toEqual({ kind: "none", reason: "no-response" });
    const whateverStored = materialFromRecording({
      kind: "settled",
      settled,
      body: { kind: "empty" },
      upload: { kind: "empty" },
    });
    expect(whateverStored.body).toEqual({ kind: "none", reason: "no-response" });
    const doc = asHarDoc(mat.entry);
    await expect(HarValidator.har(doc)).resolves.toBe(doc);
  });

  it("maps abandoned exchanges (with and without response) and upload-never-stored", async () => {
    const headless: AbandonedExchange = {
      kind: "abandoned",
      request: requestFacts,
      response: null,
      reason: "browser-closed",
      body: { kind: "incomplete" },
      upload: { kind: "none" },
    };
    const matHeadless = materialFromRecording({
      kind: "settled",
      settled: headless,
      body: { kind: "missing", reason: "browser-closed" },
      upload: { kind: "empty" },
    });
    expect(matHeadless.entry.response.status).toBe(0);
    expect(matHeadless.entry.timings).toEqual({
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: -1,
      wait: -1,
      receive: -1,
    });
    expect(matHeadless.body).toEqual({ kind: "none", reason: "browser-closed" });
    const doc1 = asHarDoc(matHeadless.entry);
    await expect(HarValidator.har(doc1)).resolves.toBe(doc1);

    const withRes: AbandonedExchange = {
      kind: "abandoned",
      request: { ...requestFacts, method: "POST" },
      response: { ...responseFacts, contentLength: 1024 as ByteCount },
      reason: "recording-stopped",
      body: { kind: "incomplete" },
      upload: { kind: "not-kept", reason: "upload-never-stored" },
    };
    const matWithRes = materialFromRecording({
      kind: "settled",
      settled: withRes,
      body: { kind: "missing", reason: "recording-stopped" },
      upload: { kind: "empty" },
    });
    expect(matWithRes.upload).toEqual({ kind: "none", reason: "upload-never-stored" });
    const doc2 = asHarDoc(matWithRes.entry);
    await expect(HarValidator.har(doc2)).resolves.toBe(doc2);
  });

  it("maps live exchanges as in-progress with or without a response head", async () => {
    const liveOpen: LiveExchange = {
      request: requestFacts,
      response: null,
      phase: "opened",
    };
    const matOpen = materialFromRecording({ kind: "live", live: liveOpen });
    expect(matOpen.body).toEqual({ kind: "none", reason: "in-progress" });
    const doc1 = asHarDoc(matOpen.entry);
    await expect(HarValidator.har(doc1)).resolves.toBe(doc1);

    const liveCopying: LiveExchange = {
      request: requestFacts,
      response: responseFacts,
      phase: "copying",
    };
    const matCopying = materialFromRecording({ kind: "live", live: liveCopying });
    expect(matCopying.entry.response.status).toBe(200);
    expect(matCopying.body).toEqual({ kind: "none", reason: "in-progress" });
    const fromCache = (source: (typeof responseFacts)["source"]) =>
      materialFromRecording({
        kind: "live",
        live: { ...liveCopying, response: { ...responseFacts, source } },
      }).entry._fromCache;
    expect([
      fromCache("revalidated"),
      fromCache("cache"),
      fromCache("network"),
      fromCache("service-worker"),
    ]).toEqual(["disk", "disk", undefined, undefined]);
    const upload = (headers: LiveExchange["request"]["headers"]) =>
      materialFromRecording({
        kind: "live",
        live: { ...liveOpen, request: { ...requestFacts, method: "POST", headers } },
      }).upload;
    expect(upload([["content-length", "12"]])).toEqual({ kind: "none", reason: "in-progress" });
    expect(upload([["transfer-encoding", "chunked"]])).toEqual({
      kind: "none",
      reason: "in-progress",
    });
    expect(upload([["content-length", "0"]])).toEqual({ kind: "empty" });
    expect(upload([])).toEqual({ kind: "empty" });
    const doc2 = asHarDoc(matCopying.entry);
    await expect(HarValidator.har(doc2)).resolves.toBe(doc2);
  });

  it("flags headersNeverStored when secret header values are null, and leaves wire-empty headers unflagged", () => {
    const dropped = materialFromRecording({
      kind: "settled",
      settled: {
        kind: "answered",
        request: {
          ...requestFacts,
          headers: [
            ["host", "app.example"],
            ["authorization", null],
            ["x-empty", ""],
          ],
        },
        response: {
          ...responseFacts,
          headers: [
            ["content-type", "text/plain"],
            ["set-cookie", null],
          ],
        },
        stop: stopFacts,
        route: "no-body",
        body: { kind: "empty" },
        upload: { kind: "none" },
      },
      body: { kind: "empty" },
      upload: { kind: "empty" },
    });
    expect(dropped.headersNeverStored).toBe(true);
    expect(dropped.entry.request.headers.find((h) => h.name === "authorization")?.value).toBe("");

    const wireEmpty = materialFromRecording({
      kind: "settled",
      settled: {
        kind: "answered",
        request: { ...requestFacts, headers: [["x-empty", ""]] },
        response: { ...responseFacts, headers: [["x-empty-res", ""]] },
        stop: stopFacts,
        route: "no-body",
        body: { kind: "empty" },
        upload: { kind: "none" },
      },
      body: { kind: "empty" },
      upload: { kind: "empty" },
    });
    expect(wireEmpty.headersNeverStored).toBeUndefined();
  });
});
