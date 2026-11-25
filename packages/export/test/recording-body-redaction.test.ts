import type { HarDocument } from "@hark/har/model";
import { parseHarJson } from "@hark/har/parse";
import {
  exchangeId,
  toMinute,
  type ChannelKey,
  type EpochMs,
  type RunId,
  type Site,
  type TabKey,
} from "@hark/recording/ids";
import type { BodyLocation, SettledExchange } from "@hark/recording/exchange";
import { describe, expect, it } from "vite-plus/test";
import { materialFromRecording } from "../src/from-recording.ts";
import { runExport, type ExportPorts } from "../src/run.ts";
import { resolveSelection } from "../src/selection.ts";
import type { BodyReader, ExchangeSource, SourceItem, SourceRef } from "../src/source.ts";
import { PACK_AT, stopFacts } from "./fixtures.ts";

const RUN = "rec01" as RunId;
const SITE = "auth.example" as Site;
const TAB: TabKey = { run: RUN, browserId: 1 };
const BASE_TS = 1_794_800_040_000;

interface RecordedFixture {
  readonly id: number;
  readonly url: string;
  readonly mimeType: string;
  readonly uploadBytes: Uint8Array;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

async function runRecordingOnlyExport(
  fixtures: readonly RecordedFixture[],
  redaction: "standard" | "none",
) {
  const bodies = new Map<string, Uint8Array>();
  const items: SourceItem[] = [];
  const materials = new Map<string, ReturnType<typeof materialFromRecording>>();

  for (const fx of fixtures) {
    const exId = exchangeId(RUN, String(fx.id) as ChannelKey);
    const loc: BodyLocation = { ...PACK_AT, length: fx.uploadBytes.length as never };
    bodies.set(exId, fx.uploadBytes);

    const startedAt = (BASE_TS + fx.id) as EpochMs;
    const settled: SettledExchange = {
      kind: "answered",
      request: {
        id: exId,
        url: fx.url,
        method: "POST",
        httpVersion: "HTTP/2",
        headers: [
          ["host", "auth.example"],
          ["content-type", fx.mimeType],
        ],
        startedAt,
        tab: TAB,
        topSite: SITE,
        policyType: 11,
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/2",
        headers: [["content-type", "application/json"]],
        mimeType: "application/json",
        contentLength: 2 as never,
        contentEncoding: null,
        source: "network",
        redirectTo: null,
        remoteAddress: "127.0.0.1",
      },
      stop: stopFacts,
      route: "small",
      body: { kind: "empty" },
      upload: {
        kind: "stored",
        at: loc,
        mimeType: fx.mimeType,
      },
    };
    const mat = materialFromRecording({
      kind: "settled",
      settled,
      body: { kind: "empty" },
      upload: { kind: "available", at: loc, encoding: null, check: "length-matched" },
    });
    const ref = { id: exId } as unknown as SourceRef;
    items.push({
      source: "recording",
      key: exId,
      startedAt,
      startedMinute: toMinute(startedAt),
      url: fx.url,
      method: "POST",
      tab: TAB,
      site: SITE,
      navigation: false,
      fetchOrXhr: true,
      inProgress: false,
      ref,
    });
    materials.set(exId, mat);
  }

  const recording: ExchangeSource = {
    name: "recording",
    list: async () => ({ items, notNetwork: {} }),
    load: async (item) => materials.get(item.key!)!,
  };
  const devtools: ExchangeSource = {
    name: "devtools",
    list: async () => ({ items: [], notNetwork: {} }),
    load: async () => {
      throw new Error("no devtools");
    },
  };
  const reader: BodyReader = {
    open: async (source) => {
      if (source.kind !== "stored") return { ok: false, reason: "not-recorded" };
      const idx = items.findIndex((it) => {
        const up = materials.get(it.key!)?.upload;
        return up?.kind === "candidates" && up.list[0] === source;
      });
      const bytes = idx === -1 ? undefined : [...bodies.values()][idx];
      if (!bytes) return { ok: false, reason: "not-recorded" };
      return {
        ok: true,
        body: {
          kind: "bytes",
          wireEncoding: null,
          chunks: (async function* () {
            yield bytes;
          })(),
        },
      };
    },
  };

  const parts: string[] = [];
  const ports: ExportPorts = {
    recording,
    devtools,
    bodies: reader,
    decode: (_encoding, chunks) => chunks,
    creator: { name: "Hark", version: "0.1.0" },
    fileId: "00112233445566778899aabbccddeeff",
    signal: { aborted: false },
    sink: {
      write: async (chunk) => {
        parts.push(chunk);
      },
      bytesWritten: () => parts.reduce((sum, p) => sum + p.length, 0) as never,
    },
    onProgress: async () => {},
    yieldNow: async () => {},
  };

  const rawSelection = {
    scope: "everything",
    range: { kind: "everything" },
    include: "all",
  } as const;
  const selection = resolveSelection(rawSelection, {
    now: toMinute(BASE_TS as EpochMs),
    localMidnight: toMinute(BASE_TS as EpochMs),
    tab: null,
    tabFirstSeen: null,
    devtoolsFirst: null,
  });

  const report = await runExport(
    { selection: rawSelection, bodies: "include", redaction, packaging: "har", fileName: null },
    selection,
    ports,
  );
  const text = parts.join("");
  const parsed = parseHarJson(text);
  if (!parsed.ok) throw new Error(`Invalid HAR: ${JSON.stringify(parsed.problems)}`);
  return { text, doc: parsed.document as HarDocument, report };
}

describe("recording-only export redacts request.postData.text under standard", () => {
  it("removes form, JSON, and multipart secrets while preserving non-secret fields and reporting coverage", async () => {
    const multipartText = [
      "--B99",
      'Content-Disposition: form-data; name="password"',
      "",
      "mp_secret",
      "--B99",
      'Content-Disposition: form-data; name="note"',
      "",
      "hello",
      "--B99--",
      "",
    ].join("\r\n");

    const { text, doc, report } = await runRecordingOnlyExport(
      [
        {
          id: 1,
          url: "https://auth.example/login",
          mimeType: "application/x-www-form-urlencoded",
          uploadBytes: utf8("password=hunter2&user=bob"),
        },
        {
          id: 2,
          url: "https://auth.example/token",
          mimeType: "application/json",
          uploadBytes: utf8('{"client_secret":"s3cr3t","nested":{"access_token":"t0k"},"ok":true}'),
        },
        {
          id: 3,
          url: "https://auth.example/upload",
          mimeType: "multipart/form-data; boundary=B99",
          uploadBytes: utf8(multipartText),
        },
      ],
      "standard",
    );

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("t0k");
    expect(text).not.toContain("mp_secret");

    const [formEntry, jsonEntry, mpEntry] = doc.log.entries;
    expect(formEntry!.request.postData?.text).toBe("password=%5BREDACTED%5D&user=bob");
    expect(formEntry!.request.postData?.params).toEqual([
      { name: "password", value: "[REDACTED]" },
      { name: "user", value: "bob" },
    ]);
    expect(JSON.parse(jsonEntry!.request.postData!.text!)).toEqual({
      client_secret: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
      ok: true,
    });
    expect(mpEntry!.request.postData?.text).toContain("hello");
    expect(mpEntry!.request.postData?.text).toContain("[REDACTED]");

    const redaction = report.redaction.report!;
    expect(redaction.entriesAffected).toBe(3);
    expect(redaction.totalRemoved).toBe(4);
    expect(redaction.rules).toEqual(["body:secrets"]);
    expect(redaction.notInspected).not.toContain("body-form");
    expect(redaction.notInspected).not.toContain("body-json");
    expect(redaction.notInspected).not.toContain("body-multipart");
    expect(doc.log._harExport?.redaction).toEqual(redaction);
  });

  it("propagates unexamined status when a recording-only JSON upload is truncated", async () => {
    const { text, report } = await runRecordingOnlyExport(
      [
        {
          id: 10,
          url: "https://auth.example/partial",
          mimeType: "application/json",
          uploadBytes: utf8('{"password":"truncated_val"'),
        },
      ],
      "standard",
    );

    expect(text).toContain("truncated_val");
    expect(report.redaction.report!.notInspected).toContain("body-json");
    expect(report.redaction.report!.notExamined.map((p) => p.place)).toContain("body-json");
  });
});
