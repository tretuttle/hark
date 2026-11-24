import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as HarValidator from "har-validator";
import type { HarDocument, HarEntry } from "@hark/har/model";
import { parseHarJson } from "@hark/har/parse";
import { summarizeHar } from "@hark/har/summarize";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { RedactionChoice } from "../src/redaction.ts";
import { BODY_WINDOW_BYTES } from "../src/run.ts";
import { FAKE_FILE_ID, runFake, sha256, utf8, writtenBytes, type FakeRow } from "./fake-ports.ts";
import type { HeapRun } from "./heap-runner.ts";
import { importAltered } from "./alter.ts";

const require = NodeModule.createRequire(import.meta.url);
const HAR_TO_K6_BIN = NodePath.join(
  NodePath.dirname(require.resolve("har-to-k6/package.json")),
  "bin",
  "har-to-k6.js",
);
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hark-export-run-"));
afterAll(() => NodeFS.rmSync(work, { recursive: true, force: true }));

/** har-to-k6 exits 0 even when it writes nothing, so the output file is the result. */
function harToK6(name: string, text: string): string | null {
  const har = NodePath.join(work, `${name}.har`);
  const out = NodePath.join(work, `${name}.js`);
  NodeFS.writeFileSync(har, text);
  NodeChildProcess.spawnSync(process.execPath, [HAR_TO_K6_BIN, har, "-o", out], {
    encoding: "utf8",
  });
  return NodeFS.existsSync(out) ? NodeFS.readFileSync(out, "utf8") : null;
}

const json = utf8(JSON.stringify({ ok: true, pad: "compressible ".repeat(200) }));
const png = new Uint8Array(NodeCrypto.createHash("sha512").update("png").digest());

const form = utf8("user=alice&password=hunter2");

/** Requests a browser makes, through every path: paired, one-sided, cut short, streamed, thrown, listed twice. */
const MIXED: readonly FakeRow[] = [
  {
    id: 20,
    url: "https://m.example/data.json?token=abc",
    navigation: true,
    tab: 1,
    recording: {
      entry: { response: { content: { size: -1, mimeType: "application/json" } } },
      body: { kind: "bytes", data: json, coding: "gzip", chunk: 64 },
    },
    devtools: {
      entry: { _initiator: { type: "script", url: "https://m.example/app.js" } },
      body: { kind: "text", slices: ["{}"] },
    },
  },
  {
    id: 21,
    url: "https://m.example/logo.png",
    tab: 1,
    recording: {
      entry: { response: { content: { size: -1, mimeType: "image/png" } } },
      body: { kind: "bytes", data: png },
    },
  },
  {
    id: 22,
    url: "data:image/png;base64,iVBORw0KGgo=",
    key: null,
    devtools: { body: { kind: "base64", slices: ["iVBORw0KGgo="] } },
  },
  {
    id: 23,
    url: "https://m.example/twice",
    recording: { body: { kind: "bytes", data: utf8("settled") } },
    listedTwice: "recording",
  },
  {
    id: 24,
    url: "https://m.example/login",
    method: "POST",
    recording: {
      entry: { request: { postData: { mimeType: "application/x-www-form-urlencoded", text: "" } } },
      upload: { kind: "bytes", data: form },
      body: { kind: "bytes", data: utf8("0123456789"), chunk: 3, failAt: 2 },
    },
  },
  {
    id: 25,
    url: "https://m.example/video",
    recording: {
      body: { kind: "generated", total: BODY_WINDOW_BYTES + 77, chunk: 700_001, seed: 3 },
    },
  },
  {
    id: 26,
    url: "https://m.example/gone",
    recording: { loadThrows: true },
    devtools: { body: { kind: "text", slices: ["dev", "tools"], failAt: 1 } },
  },
  {
    id: 27,
    url: "https://m.example/capped",
    recording: { body: { kind: "bytes", data: utf8("first part"), check: "first-part" } },
  },
  {
    id: 28,
    url: "https://other.example/",
    navigation: true,
    tab: 2,
    devtools: { body: { none: "devtools-discarded" } },
  },
  {
    id: 31,
    url: "https://m.example/cached.css",
    tab: 1,
    devtools: {
      entry: {
        _fromCache: "disk",
        cache: {
          beforeRequest: { lastAccess: "2026-11-16T00:00:00.000Z", eTag: 'W/"1"', hitCount: 2 },
        },
      },
      body: { kind: "text", slices: ["body{}"] },
    },
  },
  { id: 29, url: "https://:99999/", recording: {} },
  { id: 30, url: "http://", devtools: {} },
];

describe("runExport over fake ports", () => {
  for (const level of [
    "none",
    "standard",
    "shareable",
  ] as const satisfies readonly RedactionChoice[]) {
    it(`at ${level}: the file parses, validates, converts with har-to-k6, and keeps every body byte-exact`, async () => {
      const result = await runFake({ rows: MIXED, redaction: level });
      expect(result.error).toBeNull();
      const doc = JSON.parse(result.text) as HarDocument;
      await expect(HarValidator.har(doc)).resolves.toBe(doc);
      expect(parseHarJson(result.text).ok).toBe(true);
      const k6 = harToK6(`mixed-${level}`, result.text);
      expect(k6).toContain("https://m.example/login");

      const byUrl = (url: string): HarEntry =>
        doc.log.entries.find((e) => e.request.url.startsWith(url))!;
      expect(doc.log.entries.some((e) => e.request.url.startsWith("data:"))).toBe(false);
      expect(result.report!.notNetwork).toEqual({ "data:": 1, malformed: 2 });
      expect(
        doc.log.entries.filter((e) => e.request.url === "https://m.example/twice"),
      ).toHaveLength(1);
      expect(byUrl("https://m.example/twice")._harExport?.inProgress).toBeUndefined();
      expect(result.report!.duplicates).toEqual({ recording: 1, devtools: 0 });

      const gz = byUrl("https://m.example/data.json").response.content;
      expect(gz.size).toBe(json.length);
      expect(gz.compression).toBe(json.length - NodeZlib.gzipSync(json).length);
      if (level !== "shareable") {
        expect(sha256(writtenBytes(gz))).toBe(sha256(json));
        expect(sha256(writtenBytes(byUrl("https://m.example/logo.png").response.content))).toBe(
          sha256(png),
        );
      }
      if (level !== "shareable") {
        expect(summarizeHar(doc).bodies.incomplete).toBe(
          Object.values(result.report!.bodies.response.cutShort).reduce((a, b) => a + (b ?? 0), 0),
        );
      }
      for (const entry of doc.log.entries) {
        if (entry.pageref !== undefined)
          expect(doc.log.pages?.map((p) => p.id)).toContain(entry.pageref);
      }
    });
  }

  it("writes the export's file id first, alone, as log._harExportId, and the file still validates", async () => {
    const writes: string[] = [];
    const result = await runFake({ rows: MIXED, onWrite: (text) => writes.push(text) });
    expect(writes[0]).toBe(`{"log":{"_harExportId":"${FAKE_FILE_ID}","entries":[`);
    const doc = JSON.parse(result.text) as HarDocument & { log: { _harExportId?: unknown } };
    expect(doc.log._harExportId).toBe(FAKE_FILE_ID);
    await expect(HarValidator.har(doc)).resolves.toBe(doc);
  });

  it("cancel at every await point rejects with AbortError and reads no chunk after the abort", async () => {
    const complete = await runFake({ rows: MIXED });
    for (let at = 1; at <= complete.points; at += 1) {
      const signal = { aborted: false };
      let afterAbort = -1;
      const result = await runFake({
        rows: MIXED,
        signal,
        onPoint: (n) => {
          if (signal.aborted) afterAbort += 1;
          if (n === at) signal.aborted = true;
        },
      });
      if (result.error === null) {
        expect(result.text, `point ${String(at)}`).toBe(complete.text);
        continue;
      }
      expect((result.error as Error).name, `point ${String(at)}`).toBe("AbortError");
      expect(afterAbort, `point ${String(at)}`).toBeLessThanOrEqual(1);
      expect(() => JSON.parse(result.text), `point ${String(at)}`).toThrow();
    }
  });

  it("gives each tab its own pages when two tabs navigate in turn", async () => {
    const rows: FakeRow[] = [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      url: `https://tab${String(id % 2)}.example/${String(id)}`,
      navigation: id <= 2 || id === 5,
      tab: id % 2,
      recording: {},
    }));
    const doc = JSON.parse((await runFake({ rows })).text) as HarDocument;
    const titleOf = (e: HarEntry) => doc.log.pages!.find((p) => p.id === e.pageref)!.title;
    expect(doc.log.entries.map(titleOf)).toEqual([
      "https://tab1.example/1",
      "https://tab0.example/2",
      "https://tab1.example/1",
      "https://tab0.example/2",
      "https://tab1.example/5",
      "https://tab0.example/2",
    ]);
  });

  it("a key listed twice by one source is written once, from its settled row", async () => {
    const live: FakeRow = {
      id: 1,
      url: "https://d.example/a",
      recording: { body: { kind: "bytes", data: utf8("done") } },
      devtools: {},
      listedTwice: "recording",
    };
    const result = await runFake({
      rows: [live, { ...live, id: 2, url: "https://d.example/b", listedTwice: "devtools" }],
    });
    const entries = (JSON.parse(result.text) as HarDocument).log.entries;
    expect(
      entries.map((e) => [e.request.url, e._harExport?.source, e._harExport?.inProgress]),
    ).toEqual([
      ["https://d.example/a", "both", undefined],
      ["https://d.example/b", "both", undefined],
    ]);
    expect(result.report!.duplicates).toEqual({ recording: 1, devtools: 1 });
  });

  it("holds about one window of memory however long the body, measured in a child process", () => {
    const measure = (bytes: number, wholeBody: boolean): HeapRun => {
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--expose-gc",
          "--max-old-space-size=2048",
          NodePath.join(import.meta.dirname, "heap-runner.ts"),
          String(bytes),
          String(wholeBody),
        ],
        { encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim()) as HeapRun;
    };
    const bound = 8 * BODY_WINDOW_BYTES;
    for (const bytes of [64 * 1_048_576, 192 * 1_048_576]) {
      const run = measure(bytes, false);
      expect(run.error).toBeNull();
      expect(run.fileBytes).toBeGreaterThan((bytes * 4) / 3);
      expect(run.retainedGrowthBytes, `${String(bytes)} byte body`).toBeLessThan(bound);
    }
    const whole = measure(64 * 1_048_576, true);
    expect(whole.retainedGrowthBytes, "a run that holds the whole body").toBeGreaterThan(bound);
  });

  it("with data: rows written as entries, har-to-k6 writes no file", async () => {
    const altered = await importAltered<typeof import("../src/run.ts")>("run.ts", {
      id: "skip-classify-url",
      from: '    if (kind.kind === "network") {',
      to: "    if (true) {",
    });
    const rows = MIXED.filter((row) => row.id <= 23);
    const result = await runFake({ rows, runExport: altered.runExport });
    expect(harToK6("data-row-written", result.text)).toBeNull();
    expect(harToK6("data-row-left-out", (await runFake({ rows })).text)).not.toBeNull();
  });
});
