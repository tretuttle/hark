import type { HarEntry } from "@hark/har/model";
import { describe, expect, it } from "vite-plus/test";
import {
  BODY_PLACES,
  CUT_SHORT_REASONS,
  MISSING_REASONS,
  SOURCE_FAILURES,
  type BodyPlace,
  type CutShortReason,
  type MissingReason,
} from "../src/missing.ts";
import type { PlaceTally } from "../src/report.ts";
import { BODY_WINDOW_BYTES } from "../src/run.ts";
import { runFake, utf8, writtenBytes, type BodyField, type FakeRow } from "./fake-ports.ts";

type Expected =
  | { readonly kind: "included"; readonly bytes: Uint8Array }
  | { readonly kind: "empty" }
  | { readonly kind: "missing"; readonly reason: MissingReason }
  | { readonly kind: "cut-short"; readonly reason: CutShortReason; readonly bytes: Uint8Array };

interface Case {
  readonly place: BodyPlace;
  readonly name: string;
  readonly field: BodyField;
  readonly expected: Expected;
}

const BODY = utf8("0123456789abcdefghij");
const LONG = new Uint8Array(BODY_WINDOW_BYTES + 5).map((_, i) => (i * 7) & 255);

function casesFor(place: BodyPlace): Case[] {
  const all: Case[] = [
    {
      place,
      name: "included",
      field: { kind: "bytes", data: BODY },
      expected: { kind: "included", bytes: BODY },
    },
    { place, name: "empty", field: "empty", expected: { kind: "empty" } },
    {
      place,
      name: "open fails with a reason",
      field: { kind: "open-fails", reason: "removed-by-retention" },
      expected: { kind: "missing", reason: "removed-by-retention" },
    },
    {
      place,
      name: "open throws",
      field: { kind: "open-throws" },
      expected: { kind: "missing", reason: "source-error" },
    },
    {
      place,
      name: "reader throws before any byte",
      field: { kind: "bytes", data: BODY, chunk: 4, failAt: 0 },
      expected: { kind: "missing", reason: "source-error" },
    },
    {
      place,
      name: "reader throws after 8 bytes",
      field: { kind: "bytes", data: BODY, chunk: 4, failAt: 2 },
      expected: { kind: "cut-short", reason: "source-error", bytes: BODY.subarray(0, 8) },
    },
    {
      place,
      name: "stored first part",
      field: { kind: "bytes", data: BODY, check: "first-part" },
      expected: { kind: "cut-short", reason: "over-body-cap", bytes: BODY },
    },
    {
      place,
      name: "stored scan-timeout prefix",
      field: { kind: "bytes", data: BODY, check: "scan-timeout" },
      expected: { kind: "cut-short", reason: "scan-timeout", bytes: BODY },
    },
    {
      place,
      name: "first candidate fails, the next opens",
      field: [
        { kind: "open-fails", reason: "removed-by-retention" },
        { kind: "bytes", data: BODY },
      ],
      expected: { kind: "included", bytes: BODY },
    },
    {
      place,
      name: "every candidate fails: the last reason",
      field: [{ kind: "open-throws" }, { kind: "open-fails", reason: "devtools-discarded" }],
      expected: { kind: "missing", reason: "devtools-discarded" },
    },
    ...(Object.keys(MISSING_REASONS) as MissingReason[]).map((reason): Case => ({
      place,
      name: `listed missing: ${reason}`,
      field: { none: reason },
      expected: { kind: "missing", reason },
    })),
  ];
  if (place === "request") {
    all.push({
      place,
      name: "longer than one window",
      field: { kind: "bytes", data: LONG, chunk: 1_048_576 },
      expected: {
        kind: "cut-short",
        reason: "over-export-window",
        bytes: LONG.subarray(0, BODY_WINDOW_BYTES),
      },
    });
  } else {
    all.push({
      place,
      name: "streamed, reader throws past the window",
      field: { kind: "bytes", data: LONG, chunk: 1_048_576, failAt: 4 },
      expected: {
        kind: "cut-short",
        reason: "source-error",
        bytes: LONG.subarray(0, 4 * 1_048_576),
      },
    });
  }
  return all;
}

const CASES: readonly Case[] = BODY_PLACES.flatMap(casesFor);

function rowFor(c: Case, id: number): FakeRow {
  return {
    id,
    url: `https://losses.example/${String(id)}`,
    method: "POST",
    recording: {
      entry: { request: { postData: { mimeType: "application/octet-stream", text: "" } } },
      ...(c.place === "response" ? { body: c.field } : { upload: c.field }),
    },
  };
}

function expectedComment(c: Case): string | undefined {
  if (c.expected.kind === "missing") return MISSING_REASONS[c.expected.reason].comment[c.place];
  if (c.expected.kind === "cut-short") {
    const n = c.expected.bytes.length;
    return CUT_SHORT_REASONS[c.expected.reason].comment[c.place].replace(
      "{bytes}",
      `${String(n)} bytes`,
    );
  }
  return undefined;
}

function written(entry: HarEntry, place: BodyPlace) {
  if (place === "response") {
    const content = entry.response.content;
    return { field: content, size: content.size, comment: content.comment };
  }
  const postData = entry.request.postData;
  return { field: postData ?? {}, size: entry.request.bodySize, comment: entry.request.comment };
}

function countExpected(place: BodyPlace): PlaceTally {
  const tallyOf: {
    included: number;
    empty: number;
    cutShort: Record<string, number>;
    missing: Record<string, number>;
    lossyText: number;
  } = { included: 0, empty: 0, cutShort: {}, missing: {}, lossyText: 0 };
  for (const c of CASES) {
    const e = c.place === place ? c.expected : ({ kind: "empty" } as const);
    if (e.kind === "included") tallyOf.included += 1;
    else if (e.kind === "empty") tallyOf.empty += 1;
    else if (e.kind === "missing") tallyOf.missing[e.reason] = (tallyOf.missing[e.reason] ?? 0) + 1;
    else tallyOf.cutShort[e.reason] = (tallyOf.cutShort[e.reason] ?? 0) + 1;
  }
  return tallyOf;
}

describe("every loss is a row", () => {
  it("each (place, state) pair writes its body, size, comment and _harExport, and the tally counts it", async () => {
    const result = await runFake({ rows: CASES.map((c, i) => rowFor(c, i + 1)) });
    expect(result.error).toBeNull();
    const entries = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries;
    expect(entries).toHaveLength(CASES.length);

    CASES.forEach((c, i) => {
      const entry = entries[i]!;
      const label = `${c.place}: ${c.name}`;
      const got = written(entry, c.place);
      const ext = entry._harExport as Record<string, unknown>;
      const missingKey = c.place === "response" ? "bodyMissing" : "uploadMissing";
      const incompleteKey = c.place === "response" ? "bodyIncomplete" : "uploadIncomplete";
      expect(got.comment, label).toBe(expectedComment(c));
      switch (c.expected.kind) {
        case "included":
        case "cut-short":
          expect(Buffer.compare(writtenBytes(got.field), c.expected.bytes), label).toBe(0);
          expect(got.size, label).toBe(c.expected.bytes.length);
          break;
        case "empty":
          expect(writtenBytes(got.field).length, label).toBe(0);
          expect(got.size, label).toBe(0);
          break;
        case "missing":
          expect("text" in got.field && got.field.text !== undefined, label).toBe(false);
          expect(got.size, label).toBe(-1);
          break;
      }
      expect(ext[missingKey], label).toBe(
        c.expected.kind === "missing" || c.expected.kind === "cut-short"
          ? c.expected.reason
          : undefined,
      );
      expect(ext[incompleteKey], label).toBe(c.expected.kind === "cut-short" ? true : undefined);
      if (c.place === "response") {
        expect(ext["bodyState"], label).toBe(
          c.expected.kind === "included"
            ? "present"
            : c.expected.kind === "empty"
              ? "empty"
              : c.expected.kind === "cut-short"
                ? "unavailable"
                : MISSING_REASONS[c.expected.reason].harState,
        );
      }
    });

    const report = result.report!;
    for (const place of BODY_PLACES) {
      const {
        filledIn: _f,
        unchecked: _u,
        ...tallied
      } = { filledIn: 0, unchecked: 0, ...report.bodies[place] };
      expect(tallied, place).toEqual(countExpected(place));
    }
  });

  it("a source whose load or listing throws is an entry or a sentence, never a failed export", async () => {
    const rows: FakeRow[] = [
      { id: 1, url: "https://s.example/a", recording: { loadThrows: true } },
      {
        id: 2,
        url: "https://s.example/b",
        recording: { loadThrows: true },
        devtools: { body: { kind: "text", slices: ["ok"] } },
      },
      {
        id: 3,
        url: "https://s.example/c",
        recording: { body: { kind: "bytes", data: BODY } },
        devtools: { loadThrows: true },
      },
    ];
    const result = await runFake({ rows });
    expect(result.error).toBeNull();
    const entries = (JSON.parse(result.text) as { log: { entries: HarEntry[]; comment: string } })
      .log.entries;
    expect(entries.map((e) => e.request.url)).toEqual(rows.map((r) => r.url));
    expect(entries.map((e) => e.comment)).toEqual([
      SOURCE_FAILURES.recording.load,
      SOURCE_FAILURES.recording.load,
      SOURCE_FAILURES.devtools.load,
    ]);
    expect(entries[0]!.response.content.comment).toBe(
      MISSING_REASONS["source-error"].comment.response,
    );
    expect(writtenBytes(entries[1]!.response.content)).toEqual(utf8("ok"));
    expect(Buffer.compare(writtenBytes(entries[2]!.response.content), BODY)).toBe(0);
    expect(result.report!.sourceErrors.load).toEqual({ recording: 2, devtools: 1 });

    for (const source of ["recording", "devtools"] as const) {
      const listed = await runFake({ rows, listThrows: source });
      expect(listed.error).toBeNull();
      const doc = JSON.parse(listed.text) as { log: { entries: HarEntry[]; comment: string } };
      expect(listed.report!.sourceErrors.list).toEqual([source]);
      expect(doc.log.comment).toContain(SOURCE_FAILURES[source].list);
      const other = source === "recording" ? "devtools" : "recording";
      expect(doc.log.entries).toHaveLength(rows.filter((r) => r[other] !== undefined).length);
    }
  });

  it("with bodies left out, no body is written even from a source that offers one", async () => {
    const rows: FakeRow[] = [
      {
        id: 1,
        url: "https://o.example/a",
        method: "POST",
        recording: { body: { kind: "bytes", data: BODY }, upload: { kind: "bytes", data: BODY } },
      },
      { id: 2, url: "https://o.example/b", devtools: { body: { kind: "text", slices: ["x"] } } },
    ];
    const result = await runFake({ rows, bodies: "omit", ignoreBodyOption: true });
    const entries = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries;
    expect(entries.map((e) => [e.response.content.text, e.response.content.comment])).toEqual([
      [undefined, MISSING_REASONS["omitted-by-choice"].comment.response],
      [undefined, MISSING_REASONS["omitted-by-choice"].comment.response],
    ]);
    expect(entries[0]!.request.postData).toBeUndefined();
    expect(entries[0]!.request.comment).toBe(MISSING_REASONS["omitted-by-choice"].comment.request);
  });

  it("only the sink's failure and an abort fail the export; progress and yield ports that throw do not", async () => {
    const rows: FakeRow[] = [
      { id: 1, url: "https://p.example/a", recording: { body: { kind: "bytes", data: BODY } } },
    ];
    const quiet = await runFake({ rows, portsThrow: { onProgress: true, yieldNow: true } });
    expect(quiet.error).toBeNull();
    const refused = await runFake({ rows, sinkFailsAt: { write: 2, kind: "refused" } });
    expect((refused.error as Error).name).toBe("WriteRefused");
    const exploded = await runFake({ rows, sinkFailsAt: { write: 2, kind: "error" } });
    expect((exploded.error as Error).message).toBe("disk exploded");
    const all = await runFake({ rows: CASES.map((c, i) => rowFor(c, i + 1)) });
    for (let write = 1; write <= all.writes; write += 1) {
      const failed = await runFake({
        rows: CASES.map((c, i) => rowFor(c, i + 1)),
        sinkFailsAt: { write, kind: "refused" },
      });
      expect((failed.error as Error | null)?.name, `write ${String(write)}`).toBe("WriteRefused");
    }
  });
});
