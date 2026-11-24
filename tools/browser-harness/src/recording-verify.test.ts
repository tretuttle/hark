import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { BodyLocation, SettledExchange, StopFacts } from "@hark/recording/exchange";
import type {
  ByteCount,
  EpochMs,
  ExchangeId,
  LogSegmentId,
  PackId,
  Site,
} from "@hark/recording/ids";
import { encodeLine, encodeSummary, summarize } from "@hark/recording/log";
import type { BodyRouteId } from "@hark/recording/routes";
import type { ArchiveEntry, ArchiveLine } from "./archive.ts";
import { ID_ENDLESS_CHUNK } from "./extended-fixtures.ts";
import {
  BODY_ROUTE_FIXTURES,
  compareArchiveLedger,
  flipFirstByte,
  identityExpectations,
  checkArchiveModes,
  checkDownloads,
  checkExcludeDuringTee,
  checkExpectations,
  checkRetentionRun,
  checkStoredBodies,
  checkSummaryFiles,
  routeExpectations,
} from "./recording-verify.ts";
import { endlessPrefix, expectedFromServer } from "./recording-truth.ts";
import type { SequenceTruth } from "./server.ts";

const ORIGIN = "http://127.0.0.1:9";
const sha = (bytes: Buffer): string => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const ok: StopFacts = {
  status: { kind: "ok" },
  endedAt: 0 as EpochMs,
  timings: {
    blocked: null,
    dns: null,
    connect: null,
    ssl: null,
    send: null,
    wait: null,
    receive: null,
  },
  transferSize: 0 as ByteCount,
  encodedBodySize: 0 as ByteCount,
};

let packOffset = 0;
const at = (length: number): BodyLocation => {
  const location: BodyLocation = {
    kind: "pack",
    pack: "s/r-0" as PackId,
    offset: packOffset,
    length: length as ByteCount,
  };
  packOffset += length;
  return location;
};

const request = (path: string) => ({
  id: `r.${String(path.length)}` as ExchangeId,
  url: `${ORIGIN}${path}`,
  method: "GET",
  httpVersion: "HTTP/1.1",
  headers: [],
  startedAt: 0 as EpochMs,
  tab: null,
  topSite: "127.0.0.1" as Site,
  policyType: 1,
});

type Body = "empty" | "not-kept" | "stored" | "aborted";
const answered = (
  path: string,
  options: {
    route?: BodyRouteId;
    body?: Body;
    status?: number;
    seq?: number;
    source?: "network" | "cache" | "service-worker";
    length?: number;
  } = {},
): SettledExchange => {
  const body = options.body ?? "stored";
  return {
    kind: "answered",
    request: request(path),
    response: {
      status: options.status ?? 200,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: options.seq === undefined ? [] : [["X-Seq", String(options.seq)]],
      mimeType: null,
      contentLength: null,
      contentEncoding: null,
      source: options.source ?? "network",
      redirectTo: null,
      remoteAddress: null,
    },
    stop:
      body === "aborted"
        ? { ...ok, status: { kind: "failed", error: "NS_BINDING_ABORTED" as never } }
        : ok,
    upload: { kind: "none" },
    route: options.route ?? "small",
    body:
      body === "stored"
        ? { kind: "stored", at: at(options.length ?? 4), encoding: null, check: "length-matched" }
        : body === "aborted"
          ? { kind: "incomplete", reason: "network-aborted" }
          : body === "empty"
            ? { kind: "empty" }
            : { kind: "not-kept", reason: "streaming-response" },
  } as SettledExchange;
};
const line = (exchange: SettledExchange): ArchiveLine => ({
  siteDir: "127.0.0.1",
  segment: "r-0.jsonl",
  exchange,
});

describe("stored bodies", () => {
  const first = Buffer.from("first body");
  const second = Buffer.from("r".repeat(20));
  const truths: SequenceTruth[] = [
    {
      seq: 1,
      method: "GET",
      path: "/a",
      url: "/a",
      status: 200,
      expectedLength: 10,
      wireBytesSent: 10,
      wireSha256: sha(first),
      decodedLength: 10,
      decodedSha256: sha(first),
      aborted: false,
    },
    {
      seq: 2,
      method: "GET",
      path: "/reval",
      url: "/reval",
      status: 200,
      expectedLength: 20,
      wireBytesSent: 20,
      wireSha256: sha(second),
      decodedLength: 20,
      decodedSha256: sha(second),
      aborted: false,
    },
    {
      seq: 3,
      method: "GET",
      path: "/reval",
      url: "/reval",
      status: 304,
      expectedLength: 0,
      wireBytesSent: 0,
      wireSha256: sha(Buffer.alloc(0)),
      decodedLength: 0,
      decodedSha256: null,
      aborted: false,
    },
  ];
  const server = {
    getSequenceTruth: (seq: number) => truths.find((t) => t.seq === seq),
    getAllSequenceTruth: () => new Map(truths.map((t) => [t.seq, t])),
  };
  const lines = [
    line(answered("/a", { seq: 1, length: first.length })),
    line(answered("/reval", { seq: 3, status: 304, length: second.length })),
  ];
  const bytes = new Map<number, Buffer>();
  const stored = lines.map((l) =>
    l.exchange.kind === "answered" && l.exchange.body.kind === "stored" ? l.exchange.body.at : null,
  );
  bytes.set(0, first);
  bytes.set(1, second);
  const read = (location: BodyLocation): Buffer | null =>
    bytes.get(stored.indexOf(location)) ?? null;

  it("is exact against the server's digest, and a merged 304 against the 200 it revalidated", () => {
    const verdicts = checkStoredBodies(lines, expectedFromServer(server), read);
    expect(verdicts.map((v) => v.verdict)).toEqual(["exact", "exact"]);
  });

  it("reads one flipped byte as exactly one wrong body, and a missing file as missing", () => {
    const target = stored[1];
    if (target === null || target === undefined) throw new Error("no stored location");
    const flipped = checkStoredBodies(
      lines,
      expectedFromServer(server),
      flipFirstByte(read, target),
    );
    expect(flipped.map((v) => v.verdict)).toEqual(["exact", "wrong"]);
    expect(
      checkStoredBodies(lines, expectedFromServer(server), () => null).map((v) => v.verdict),
    ).toEqual(["missing", "missing"]);
  });

  it("expects a capped body to be the endless stream's first bytes", () => {
    const prefix = ID_ENDLESS_CHUNK.toString("utf8").repeat(3).slice(0, 5000);
    expect(endlessPrefix(5000)).toEqual({ sha256: sha(Buffer.from(prefix)), length: 5000 });
  });
});

describe("body routes", () => {
  const correct = BODY_ROUTE_FIXTURES.map(({ route, path, body }) =>
    line(answered(path, { route, body })),
  );

  it("holds when each route's fixture settles to its route and body", () => {
    expect(checkExpectations(routeExpectations, correct)).toEqual([]);
  });

  it("catches two routes swapped", () => {
    const [a, b] = BODY_ROUTE_FIXTURES;
    if (a === undefined || b === undefined) throw new Error("two routes");
    const swapped = [
      line(answered(a.path, { route: b.route, body: a.body })),
      line(answered(b.path, { route: a.route, body: b.body })),
      ...correct.slice(2),
    ];
    expect(checkExpectations(routeExpectations, swapped)).toHaveLength(2);
  });
});

describe("identity fixtures", () => {
  const correct: SettledExchange[] = [
    answered("/poll"),
    answered("/poll"),
    answered("/id/big", { route: "large-or-unknown", body: "aborted" }),
    answered("/id/reval"),
    answered("/id/reval", { status: 304 }),
    answered("/id/cached"),
    answered("/id/cached", { source: "cache" }),
    answered("/id/r1", { route: "redirect", body: "empty", status: 302 }),
    answered("/id/r2", { route: "redirect", body: "empty", status: 307 }),
    answered("/id/rfinal"),
    answered("/sw/synth", { route: "large-or-unknown", source: "service-worker" }),
    answered("/sw/pass", { source: "service-worker" }),
    {
      kind: "unanswered",
      request: request("/refused"),
      stop: { ...ok, status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" as never } },
      upload: { kind: "none" },
    },
  ];

  it("holds for an archive that records every identity fixture as expected", () => {
    expect(checkExpectations(identityExpectations, correct.map(line))).toEqual([]);
  });

  it.each([
    [
      "the 304 kept as a second 200",
      (all: SettledExchange[]) =>
        all.map((e) =>
          e.kind === "answered" && e.response.status === 304 ? answered("/id/reval") : e,
        ),
    ],
    [
      "a redirect hop that kept a body",
      (all: SettledExchange[]) =>
        all.map((e) => (e.request.url.endsWith("/id/r1") ? answered("/id/r1") : e)),
    ],
    [
      "the cancelled download stored as complete",
      (all: SettledExchange[]) =>
        all.map((e) => (e.request.url.endsWith("/id/big") ? answered("/id/big") : e)),
    ],
    [
      "the refused port missing",
      (all: SettledExchange[]) => all.filter((e) => !e.request.url.endsWith("/refused")),
    ],
  ])("catches %s", (_name, change) => {
    expect(checkExpectations(identityExpectations, change(correct).map(line))).toHaveLength(1);
  });
});

describe("archive files", () => {
  const entries: ArchiveEntry[] = [
    { path: ".", kind: "directory", mode: 0o700, size: 0 },
    { path: "k/sites/a/log/r-0.jsonl", kind: "file", mode: 0o600, size: 9 },
  ];

  it("flags a file readable by others and a kind the run never wrote", () => {
    expect(checkArchiveModes(entries, ["jsonl"])).toEqual([]);
    expect(
      checkArchiveModes(
        [...entries, { path: "k/settings.json", kind: "file", mode: 0o644, size: 2 }],
        ["jsonl", "pack"],
      ),
    ).toEqual(["k/settings.json is file mode 644", "no .pack file was written to check"]);
  });

  it("flags a download that points into the data home", () => {
    expect(checkDownloads(["/home/u/Downloads/a.bin"], "/data")).toBeNull();
    expect(checkDownloads(["/data/hark/x.har"], "/data")).toMatch(/points into the data home/);
  });

  it("flags torn, missing, size-mismatched, or line-dropping summary files", () => {
    const segId = "127.0.0.1/r0-0" as LogSegmentId;
    const first = { v: 2 as const, exchange: answered("/poll") };
    const second = { v: 2 as const, exchange: answered("/poll", { status: 200 }) };
    const oneText = encodeLine(first);
    const twoText = `${oneText}${encodeLine(second)}`;
    const validOne = encodeSummary(summarize(segId, [first], oneText.length as ByteCount));
    const droppedLineSameBytes = encodeSummary(
      summarize(segId, [second], twoText.length as ByteCount),
    );
    expect(
      checkSummaryFiles([
        {
          name: "r0-0.summary.json",
          raw: validOne,
          segmentBytes: oneText.length,
          segmentText: oneText,
        },
      ]),
    ).toEqual([]);
    expect(
      checkSummaryFiles([
        {
          name: "r0-0.summary.json",
          raw: "{corrupt",
          segmentBytes: oneText.length,
          segmentText: oneText,
        },
      ]),
    ).toHaveLength(1);
    expect(
      checkSummaryFiles([
        {
          name: "r0-0.summary.json",
          raw: validOne,
          segmentBytes: 999,
          segmentText: oneText,
        },
      ]),
    ).toHaveLength(1);
    expect(
      checkSummaryFiles([
        {
          name: "r0-0.summary.json",
          raw: null,
          segmentBytes: oneText.length,
          segmentText: oneText,
        },
      ]),
    ).toHaveLength(1);
    expect(
      checkSummaryFiles([
        {
          name: "r0-0.summary.json",
          raw: droppedLineSameBytes,
          segmentBytes: twoText.length,
          segmentText: twoText,
        },
      ]).join("\n"),
    ).toMatch(/summary lines 1 != segment lines 2/);
  });

  it("flags ledger/disk skew, missing or modified pins, leftover parts, and missing summaries", () => {
    const cleanDisk = {
      partBytes: 0,
      partCount: 0,
      packBytes: 1000,
      bodyFileBytes: 2000,
      bodyBytes: 3000,
      logBytes: 400,
      summaryBytes: 120,
      detailBytes: 520,
      summaries: [],
      missingSummarySegments: [],
    };
    const cleanUsage = { bodyBytes: 3000, detailBytes: 520 };
    expect(
      compareArchiveLedger({
        step: "clean",
        usage: cleanUsage,
        disk: cleanDisk,
        pinned: [{ label: "p0", exists: true, expectedSha256: "abc", actualSha256: "abc" }],
        expectZeroParts: true,
        maxBodyBytes: 5000,
        requireAllSummarized: true,
      }),
    ).toEqual([]);
    expect(
      compareArchiveLedger({
        step: "bad-body",
        usage: { bodyBytes: 13000, detailBytes: 520 },
        disk: cleanDisk,
      }).join("\n"),
    ).toMatch(/usage\.bodyBytes 13000 != disk 3000/);
    expect(
      compareArchiveLedger({
        step: "bad-detail",
        usage: { bodyBytes: 3000, detailBytes: 999 },
        disk: cleanDisk,
      }).join("\n"),
    ).toMatch(/usage\.detailBytes 999 != disk 520/);
    expect(
      compareArchiveLedger({
        step: "deleted-pin",
        usage: cleanUsage,
        disk: cleanDisk,
        pinned: [{ label: "p0", exists: false }],
      }).join("\n"),
    ).toMatch(/pinned file missing/);
    expect(
      compareArchiveLedger({
        step: "leftover-part",
        usage: cleanUsage,
        disk: { ...cleanDisk, partCount: 1 },
        expectZeroParts: true,
      }).join("\n"),
    ).toMatch(/expected 0 parts/);
    expect(
      compareArchiveLedger({
        step: "missing-summary",
        usage: cleanUsage,
        disk: { ...cleanDisk, missingSummarySegments: ["site/seg.jsonl"] },
        requireAllSummarized: true,
      }).join("\n"),
    ).toMatch(/missing summary/);
  });

  it("catches retention failures: uncapped growth, deleted pinned pack, deleted newest pack, missing problem", () => {
    const clean = {
      capBytes: 64 * 1_048_576,
      flushBatchBytes: 2 * 1_048_576,
      totalServedBytes: 90 * 1_048_576,
      duSamples: [30 * 1_048_576, 65 * 1_048_576, 64 * 1_048_576],
      duAfterFlush: 63 * 1_048_576,
      pinCheck: {
        oldestPackIsActuallyOldest: true,
        oldestPackExistsBeforeUnpin: true,
        newestPackExistsBeforeUnpin: true,
        problemsBeforeUnpin: ["over-cap-while-exporting"],
        oldestPackExistsAfterUnpin: false,
        problemsAfterUnpin: [],
        duAfterUnpin: 62 * 1_048_576,
      },
    };
    expect(checkRetentionRun(clean)).toEqual([]);
    expect(checkRetentionRun({ ...clean, duSamples: [80 * 1_048_576] }).join("\n")).toMatch(
      /> cap\+batch/,
    );
    expect(
      checkRetentionRun({
        ...clean,
        usageBodyBytesAfterFlush: 50_000_000,
        diskBodyBytesAfterFlush: 60_000_000,
      }).join("\n"),
    ).toMatch(/usage\.bodyBytes after flush/);
    expect(
      checkRetentionRun({
        ...clean,
        pinCheck: { ...clean.pinCheck, oldestPackIsActuallyOldest: false },
      }).join("\n"),
    ).toMatch(/did not pin the oldest pack/);
    expect(
      checkRetentionRun({
        ...clean,
        pinCheck: { ...clean.pinCheck, oldestPackExistsBeforeUnpin: false },
      }).join("\n"),
    ).toMatch(/deleted a pinned pack/);
    expect(
      checkRetentionRun({
        ...clean,
        pinCheck: { ...clean.pinCheck, newestPackExistsBeforeUnpin: false },
      }).join("\n"),
    ).toMatch(/deleted the newest pack/);
    expect(
      checkRetentionRun({
        ...clean,
        pinCheck: { ...clean.pinCheck, problemsBeforeUnpin: [] },
      }).join("\n"),
    ).toMatch(/over-cap-while-exporting not reported/);
  });

  it("catches exclude-during-tee failures", () => {
    const clean = {
      excludedSite: "127.0.0.1",
      siteDirExistsDuringTee: false,
      sitesIndexDuringTee: [],
      partCountDuringTee: 1,
      siteDirExistsAfterStop: false,
      partsAfterStop: [],
      sitesIndexAfterStop: [],
      problems: [],
    };
    expect(checkExcludeDuringTee(clean)).toEqual([]);
    expect(checkExcludeDuringTee({ ...clean, siteDirExistsAfterStop: true }).join("\n")).toMatch(
      /site directory reappeared/,
    );
    expect(checkExcludeDuringTee({ ...clean, partsAfterStop: ["r.1.part"] }).join("\n")).toMatch(
      /part files left/,
    );
    expect(
      checkExcludeDuringTee({ ...clean, sitesIndexAfterStop: ["127.0.0.1"] }).join("\n"),
    ).toMatch(/reappeared in index/);
  });
});
