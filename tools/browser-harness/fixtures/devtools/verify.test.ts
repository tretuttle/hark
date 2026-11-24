import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  DEVTOOLS_GROUND_TRUTH,
  DEVTOOLS_STACK_FRAMES,
  prng,
  startDevtoolsFixtureServer,
} from "./server.ts";
import { DEVTOOLS_FAULTS, harValidatorOk, verifyDevtoolsHar } from "./verify.ts";

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hark-devtools-verify-"));
afterAll(() => NodeFS.rmSync(workDir, { recursive: true, force: true }));

function makeSampleHar(): string {
  const txtBuf = Buffer.from(prng(300_000, 29).toString("hex"), "utf8");
  const bigBuf = prng(50_000_000, 7);
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Hark", version: "0.1.0" },
      comment: "Exported 3 requests. Left out 1 non-network row (1 data:).",
      pages: [
        {
          startedDateTime: "2026-11-17T10:00:00.000Z",
          id: "page_0",
          title: "http://127.0.0.1:8791/page.html",
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      _harExport: {
        report: {
          requests: 3,
          sources: { both: 2, recordingOnly: 0, devtoolsOnly: 1 },
          notNetwork: { "data:": 1 },
          bodies: { response: { filledIn: 1, missing: {} } },
        },
      },
      entries: [
        {
          pageref: "page_0",
          startedDateTime: "2026-11-17T10:00:00.000Z",
          time: 3,
          request: {
            method: "GET",
            url: "http://127.0.0.1:8791/text.txt?stack=k1",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [{ name: "stack", value: "k1" }],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            content: {
              size: txtBuf.length,
              mimeType: "text/plain; charset=utf-8",
              text: txtBuf.toString("utf8"),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: txtBuf.length,
          },
          cache: {},
          timings: { send: 1, wait: 1, receive: 1 },
          _initiator: {
            type: "script",
            stack: {
              callFrames: DEVTOOLS_STACK_FRAMES.map((name, i) => ({
                functionName: name,
                scriptId: "",
                url: "http://127.0.0.1:8791/page.html",
                lineNumber: 10 + i,
                columnNumber: 1,
              })),
            },
          },
          _harExport: { source: "both", bodyState: "present" },
        },
        {
          pageref: "page_0",
          startedDateTime: "2026-11-17T10:00:00.010Z",
          time: 3,
          request: {
            method: "GET",
            url: "http://127.0.0.1:8791/big.bin?k=k1",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [{ name: "k", value: "k1" }],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            content: {
              size: bigBuf.length,
              mimeType: "application/octet-stream",
              text: bigBuf.toString("base64"),
              encoding: "base64",
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: bigBuf.length,
          },
          cache: {},
          timings: { send: 1, wait: 1, receive: 1 },
          _harExport: { source: "both", bodyState: "present" },
        },
        {
          pageref: "page_0",
          startedDateTime: "2026-11-17T10:00:00.020Z",
          time: 3,
          request: {
            method: "GET",
            url: "http://127.0.0.1:8791/mid.bin?old=1",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [{ name: "old", value: "1" }],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            content: { size: -1, mimeType: "application/octet-stream" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 1, wait: 1, receive: 1 },
          _harExport: {
            source: "devtools-only",
            bodyState: "discarded",
            bodyMissing: "devtools-discarded",
          },
        },
      ],
    },
  });
}

describe("devtools fixture server and HAR verification", () => {
  it("serves known bodies with monotonic X-Seq headers", async () => {
    await using server = await startDevtoolsFixtureServer();
    const res = await fetch(`${server.origin}/text.txt`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const seq = Number(res.headers.get("x-seq"));
    expect(seq).toBe(1);
    expect(bytes.length).toBe(DEVTOOLS_GROUND_TRUTH["text.txt"].size);
    const truth = server.getSequenceTruth(seq);
    expect(truth?.decodedSha256).toBe(DEVTOOLS_GROUND_TRUTH["text.txt"].sha256);
    expect(server.getRequestLog()).toHaveLength(1);
  });

  it("passes a clean HAR and catches every deliberately broken copy", async () => {
    const clean = makeSampleHar();
    expect(await harValidatorOk(clean)).toBe(true);
    const ok = await verifyDevtoolsHar(clean, {
      entries: 3,
      sources: { both: 2, recordingOnly: 0, devtoolsOnly: 1 },
      filledInMin: 1,
      stubs: { minCount: 1 },
      stackUrlIncludes: "text.txt",
      notNetworkDataMin: 1,
      requireDevtoolsSources: true,
      disallowBothFromPrefix: "old=1",
      workDir,
    });
    expect(ok.problems).toEqual([]);

    expect(
      (await verifyDevtoolsHar(DEVTOOLS_FAULTS.dropEntry(clean), { entries: 3 })).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (await verifyDevtoolsHar(DEVTOOLS_FAULTS.emptyFile(), { stubs: { minCount: 1 } })).problems
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.zeroDevtoolsSources(clean), {
          requireDevtoolsSources: true,
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (await verifyDevtoolsHar(DEVTOOLS_FAULTS.zeroPaddedBig(clean), { workDir })).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (await verifyDevtoolsHar(DEVTOOLS_FAULTS.unfilledBig(clean), { filledInMin: 1 })).problems
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.dropStackFrame(clean, "text.txt"), {
          stackUrlIncludes: "text.txt",
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (await verifyDevtoolsHar(DEVTOOLS_FAULTS.addDataEntry(clean), { workDir })).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.dropNotNetworkCount(clean), {
          notNetworkDataMin: 1,
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.pairAcrossRuns(clean, "old=1"), {
          disallowBothFromPrefix: "old=1",
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.wrongSourceCounts(clean), {
          sources: { both: 2, recordingOnly: 0, devtoolsOnly: 1 },
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(DEVTOOLS_FAULTS.stripHeadersAndTimings(clean), {
          requireHeadersAndTimings: true,
        })
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await verifyDevtoolsHar(
          DEVTOOLS_FAULTS.stripMetadataFlags(DEVTOOLS_FAULTS.stripHeadersAndTimings(clean)),
          {
            checkMetadataFlags: true,
          },
        )
      ).problems.length,
    ).toBeGreaterThan(0);
  });
});
