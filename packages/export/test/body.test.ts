import type { HarEntry } from "@hark/har/model";
import { describe, expect, it } from "vite-plus/test";
import {
  base64Stream,
  bytesFromBase64Slices,
  bytesFromTextSlices,
  chooseEncoding,
} from "../src/body.ts";
import { BODY_WINDOW_BYTES } from "../src/run.ts";
import { runFake, sha256, writtenBytes, type FakeRow } from "./fake-ports.ts";
import { importAltered } from "./alter.ts";

// References: Node's Buffer for base64, WHATWG TextDecoder with fatal for UTF-8, String#toWellFormed for lone
// surrogates. Seeded xorshift, so a failure reproduces.

function rng(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return Math.floor((s / 0x1_0000_0000) * n);
  };
}

function randomBytes(r: (n: number) => number): Uint8Array {
  const out: number[] = [];
  const n = r(100) === 0 ? 20_000 + r(40_000) : r(80);
  while (out.length < n) {
    const roll = r(20);
    if (roll < 6) out.push(r(0x80));
    else if (roll < 9) {
      const cp = 0x80 + r(0x780);
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    } else if (roll < 12) {
      const cp = 0x800 + r(0xd000);
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else if (roll < 15) {
      const cp = 0x10000 + r(0x100000);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    } else if (roll < 16) out.push(0xed, 0xa0 + r(32), 0x80 + r(64));
    else if (roll < 17) out.push(0xe2, 0x80, 0xa8);
    else out.push(r(256));
  }
  return Uint8Array.from(out.slice(0, n));
}

function splits(r: (n: number) => number, length: number): number[] {
  const out: number[] = [];
  for (let at = 0; at < length;) {
    const step = r(5) === 0 ? r(5000) : r(8);
    out.push(step);
    at += step;
  }
  return out;
}

const CHARSETS = [
  null,
  "utf-8",
  "utf8",
  "us-ascii",
  "windows-1252",
  "iso-8859-1",
  "shift_jis",
] as const;
const strict = new TextDecoder("utf-8", { fatal: true });
function isUtf8(bytes: Uint8Array): boolean {
  try {
    strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of chunks) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

async function* slices(r: (n: number) => number, whole: string): AsyncIterable<string> {
  let at = 0;
  for (const step of splits(r, whole.length)) {
    yield whole.slice(at, at + step);
    at += step;
  }
}

describe("one encoding decision for every body", () => {
  it("for 20,000 random byte strings and declared charsets, what is written decodes to the same bytes", () => {
    const r = rng(4_242);
    for (let c = 0; c < 20_000; c += 1) {
      const bytes = randomBytes(r);
      const charset = CHARSETS[r(CHARSETS.length)]!;
      const written = chooseEncoding(bytes, charset);
      const decoded =
        written.encoding === "base64"
          ? Buffer.from(written.text, "base64")
          : Buffer.from(written.text, "utf8");
      expect(sha256(decoded), `case ${String(c)}`).toBe(sha256(bytes));
      const declaredUtf8 = charset === null || ["utf-8", "utf8", "us-ascii"].includes(charset);
      const ascii = bytes.every((b) => b < 0x80);
      expect(written.encoding === null, `case ${String(c)}`).toBe(
        isUtf8(bytes) && (declaredUtf8 || ascii),
      );
    }
  });

  it("streams base64, DevTools base64 slices and DevTools text slices across any split", async () => {
    const r = rng(77);
    for (let c = 0; c < 3_000; c += 1) {
      const bytes = randomBytes(r);
      const stream = base64Stream();
      let text = "";
      let at = 0;
      for (const step of splits(r, bytes.length)) {
        text += stream.push(bytes.subarray(at, at + step));
        at += step;
      }
      expect(text + stream.end()).toBe(Buffer.from(bytes).toString("base64"));
      expect(
        sha256(
          await collect(bytesFromBase64Slices(slices(r, Buffer.from(bytes).toString("base64")))),
        ),
      ).toBe(sha256(bytes));
      const units = Array.from({ length: r(60) }, () =>
        r(4) === 0 ? 0xd800 + r(0x800) : r(3) === 0 ? 0x80 + r(0xff00) : 0x20 + r(0x5f),
      );
      const devtoolsText = String.fromCharCode(...units);
      const converted = bytesFromTextSlices(slices(r, devtoolsText));
      expect(sha256(await collect(converted.bytes))).toBe(
        sha256(Buffer.from(devtoolsText.toWellFormed(), "utf8")),
      );
      const lone = [...devtoolsText].filter(
        (ch) => ch.length === 1 && /[\ud800-\udfff]/u.test(ch),
      ).length;
      expect(converted.lossy()).toBe(lone);
    }
  });

  it("through runExport, every body place and source writes bytes that decode to the source's bytes and size", async () => {
    const r = rng(9);
    const rows: FakeRow[] = [];
    const expected: { readonly response: Uint8Array; readonly request: Uint8Array }[] = [];
    for (let id = 1; id <= 300; id += 1) {
      const response = randomBytes(r);
      const request = randomBytes(r);
      const charset = CHARSETS[r(CHARSETS.length)];
      const mime = charset === null ? "text/plain" : `text/html; charset=${String(charset)}`;
      const fromDevtools = r(2) === 0;
      rows.push({
        id,
        url: `https://b.example/${String(id)}`,
        method: "POST",
        [fromDevtools ? "devtools" : "recording"]: {
          entry: {
            request: { postData: { mimeType: mime, text: "" } },
            response: { content: { size: -1, mimeType: mime } },
          },
          body: fromDevtools
            ? { kind: "base64", slices: [Buffer.from(response).toString("base64")] }
            : {
                kind: "bytes",
                data: response,
                coding: (["gzip", "br", null] as const)[r(3)],
                chunk: 1 + r(500),
              },
          upload: { kind: "bytes", data: request, chunk: 1 + r(64) },
        },
      });
      expected.push({ response, request: request.length === 0 ? new Uint8Array(0) : request });
    }
    const result = await runFake({ rows });
    const entries = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries;
    entries.forEach((entry, i) => {
      const want = expected[i]!;
      expect(sha256(writtenBytes(entry.response.content)), `response ${String(i)}`).toBe(
        sha256(want.response),
      );
      expect(entry.response.content.size, `response size ${String(i)}`).toBe(want.response.length);
      expect(sha256(writtenBytes(entry.request.postData ?? {})), `request ${String(i)}`).toBe(
        sha256(want.request),
      );
      expect(entry.request.bodySize, `request size ${String(i)}`).toBe(want.request.length);
    });
  });

  it("DevTools text keeps its characters, its UTF-8 size, and a pair split between slices", async () => {
    const result = await runFake({
      rows: [
        {
          id: 1,
          url: "https://d.example/latin1",
          devtools: {
            entry: {
              response: { content: { size: -1, mimeType: "text/html; charset=windows-1252" } },
            },
            body: { kind: "text", slices: ["café \ud83d", "\ude00 naïve"] },
          },
        },
      ],
    });
    const content = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries[0]!
      .response.content;
    expect(content.text).toBe("café 😀 naïve");
    expect(content.encoding).toBeUndefined();
    expect(content.size).toBe(Buffer.byteLength("café 😀 naïve", "utf8"));
  });

  it("with DevTools text read in the page's declared charset, its body is written as base64", async () => {
    const run = await importAltered<typeof import("../src/run.ts")>("run.ts", {
      id: "devtools-text-latin1",
      from: '    charset: "utf-8",',
      to: "    charset: charsetOf(mimeType),",
    });
    const result = await runFake({
      rows: [
        {
          id: 1,
          url: "https://d.example/latin1",
          devtools: {
            entry: {
              response: { content: { size: -1, mimeType: "text/html; charset=windows-1252" } },
            },
            body: { kind: "text", slices: ["café"] },
          },
        },
      ],
      runExport: run.runExport,
    });
    const content = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries[0]!
      .response.content;
    expect(content.encoding).toBe("base64");
    expect(Buffer.from(content.text ?? "", "base64").toString("utf8")).toBe("café");
  });

  it("a body longer than one window streams as base64 and decodes to the source's bytes", async () => {
    const result = await runFake({
      rows: [
        {
          id: 1,
          url: "https://l.example/",
          recording: {
            body: { kind: "generated", total: BODY_WINDOW_BYTES * 2 + 3, chunk: 999_999, seed: 5 },
          },
        },
      ],
    });
    const content = (JSON.parse(result.text) as { log: { entries: HarEntry[] } }).log.entries[0]!
      .response.content;
    const { generatedChunk } = await import("./fake-ports.ts");
    const want: Uint8Array[] = [];
    for (let at = 0, n = 0; at < BODY_WINDOW_BYTES * 2 + 3; at += 999_999, n += 1) {
      want.push(generatedChunk(5, n, Math.min(999_999, BODY_WINDOW_BYTES * 2 + 3 - at)));
    }
    expect(content.encoding).toBe("base64");
    expect(sha256(writtenBytes(content))).toBe(sha256(Buffer.concat(want)));
    expect(content.size).toBe(BODY_WINDOW_BYTES * 2 + 3);
  });
});
