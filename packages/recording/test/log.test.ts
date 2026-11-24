import { describe, expect, it } from "vite-plus/test";

import type { SettledExchange } from "../src/exchange.ts";
import type { ByteCount, EpochMs, ExchangeId, LogSegmentId, PackId } from "../src/ids.ts";
import {
  decodeLine,
  decodeSummary,
  encodeLine,
  encodeSummary,
  splitLines,
  summarize,
  type LogLine,
} from "../src/log.ts";
import { request, response, RUN, SITE, stop, T0 } from "./fixtures.ts";

const bytes = (n: number) => n as ByteCount;
const PACK = "example.com/mhz02-0" as PackId;
const SEGMENT = "example.com/mhz02-0" as LogSegmentId;

const answered: SettledExchange = {
  kind: "answered",
  request: {
    ...request,
    url: "https://example.com/café?q=\u{1f600}",
    headers: [["X-Name", "Jürgen"]],
  },
  response,
  stop,
  route: "small",
  body: {
    kind: "stored",
    at: { kind: "pack", pack: PACK, offset: 0, length: bytes(14) },
    encoding: "gzip",
    check: "length-matched",
  },
  upload: {
    kind: "stored",
    at: { kind: "pack", pack: PACK, offset: 14, length: bytes(9) },
    mimeType: "application/json",
  },
};
const unanswered: SettledExchange = {
  kind: "unanswered",
  request: {
    ...request,
    id: "mhz02.15032385540" as ExchangeId,
    startedAt: (T0 + 61_000) as EpochMs,
    policyType: 6,
    tab: null,
  },
  stop: {
    ...stop,
    status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" as never },
    encodedBodySize: bytes(0),
  },
  upload: { kind: "not-kept", reason: "upload-never-stored" },
};
const abandoned: SettledExchange = {
  kind: "abandoned",
  request: {
    ...request,
    id: "mhz02.15032385541" as ExchangeId,
    startedAt: (T0 + 5_000) as EpochMs,
  },
  response: null,
  reason: "recording-stopped",
  body: { kind: "incomplete" },
  upload: { kind: "none" },
};
const LINES: readonly LogLine[] = [answered, unanswered, abandoned].map((exchange) => ({
  v: 2,
  exchange,
}));

// The persisted format, written by hand: a reader of an older archive depends on these exact keys.
const UNANSWERED_ON_DISK =
  '{"v":2,"exchange":{"kind":"unanswered","request":{"id":"mhz02.15032385540","url":"https://example.com/api/items?page=2","method":"GET",' +
  '"httpVersion":"HTTP/1.1","headers":[["Accept","application/json"],["Cookie",null]],"startedAt":1794800061000,"tab":null,"topSite":"example.com",' +
  '"policyType":6},"stop":{"status":{"kind":"failed","error":"NS_ERROR_CONNECTION_REFUSED"},"endedAt":1794800000041,"timings":{"blocked":1,"dns":null,' +
  '"connect":null,"ssl":null,"send":0,"wait":38,"receive":2},"transferSize":312,"encodedBodySize":0},"upload":{"kind":"not-kept","reason":"upload-never-stored"}}}';

describe("log lines", () => {
  it.each(LINES.map((line) => [line.exchange.kind, line] as const))(
    "an %s line round-trips",
    (_kind, line) => {
      const encoded = encodeLine(line);
      expect(encoded.endsWith("\n")).toBe(true);
      expect(encoded.indexOf("\n")).toBe(encoded.length - 1);
      expect(decodeLine(encoded.slice(0, -1))).toEqual(line);
    },
  );

  it("lines are ASCII, so a byte offset is a string offset", () => {
    const encoded = encodeLine(LINES[0]!);
    expect(encoded).toMatch(/^[\x20-\x7e]+\n$/);
    expect(encoded).toContain("caf\\u00e9");
    expect(new TextEncoder().encode(encoded).length).toBe(encoded.length);
  });

  it("decodes the format as it sits on disk", () => {
    expect(decodeLine(UNANSWERED_ON_DISK)).toEqual(LINES[1]);
    expect(encodeLine(LINES[1]!)).toBe(`${UNANSWERED_ON_DISK}\n`);
  });

  it("every torn prefix of a line decodes to null", () => {
    const encoded = encodeLine(LINES[0]!).slice(0, -1);
    const torn = Array.from({ length: encoded.length }, (_, n) => encoded.slice(0, n)).filter(
      (prefix) => decodeLine(prefix) !== null,
    );
    expect(torn).toEqual([]);
  });

  it.each([
    ["a future version", UNANSWERED_ON_DISK.replace('{"v":2', '{"v":3')],
    ["version 1", UNANSWERED_ON_DISK.replace('{"v":2', '{"v":1')],
    [
      "an unknown exchange kind",
      UNANSWERED_ON_DISK.replace('"kind":"unanswered"', '"kind":"cached"'),
    ],
    ["a malformed exchange id", UNANSWERED_ON_DISK.replace("mhz02.15032385540", "15032385540")],
    ["a negative size", UNANSWERED_ON_DISK.replace('"transferSize":312', '"transferSize":-1')],
    [
      "an unknown upload reason",
      UNANSWERED_ON_DISK.replace("upload-never-stored", "upload-skipped"),
    ],
    [
      "a header that is not a pair",
      UNANSWERED_ON_DISK.replace('["Accept","application/json"]', '["Accept"]'),
    ],
    ["foreign JSON", '{"hello":"world"}'],
    ["an empty line", ""],
  ])("%s decodes to null", (_label, line) => {
    expect(decodeLine(line)).toBeNull();
  });
});

describe("reading a segment", () => {
  const encoded = LINES.map(encodeLine);
  const segment = encoded.join("");
  const ends = encoded.map((_, i) => encoded.slice(0, i + 1).join("").length);

  const scan = (text: string, chunkSizes: readonly number[]) => {
    let carry = "";
    const lines: string[] = [];
    let at = 0;
    for (const size of chunkSizes) {
      const next = splitLines(carry, text.slice(at, at + size));
      lines.push(...next.lines);
      carry = next.carry;
      at += size;
    }
    const last = splitLines(carry, text.slice(at));
    return { lines: [...lines, ...last.lines], carry: last.carry };
  };

  it("a torn tail is cut back to the last complete line, at every point of the segment", () => {
    for (let cut = 0; cut <= segment.length; cut++) {
      const whole = ends.filter((end) => end <= cut).length;
      const validBytes = ends.filter((end) => end <= cut).at(-1) ?? 0;
      const read = scan(segment.slice(0, cut), [7, 300, 1]);
      expect(read.lines.map((l) => decodeLine(l))).toEqual(LINES.slice(0, whole));
      expect(cut - read.carry.length).toBe(validBytes);
    }
  });

  it("chunk boundaries do not change what is read", () => {
    const sizes = [
      [1],
      [segment.length],
      [3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377],
      encoded.map((l) => l.length),
    ];
    for (const chunks of sizes)
      expect(scan(segment, chunks)).toEqual({
        lines: encoded.map((l) => l.slice(0, -1)),
        carry: "",
      });
  });
});

interface RawSummary {
  lines: number;
  firstStartedAt: number | null;
  lastStartedAt: number | null;
  buckets: { requests: number; fetchOrXhr: number }[];
}
const edited = (edit: (s: RawSummary) => void) => (text: string) => {
  const raw = JSON.parse(text) as RawSummary;
  edit(raw);
  return JSON.stringify(raw);
};
const second = (s: RawSummary) => s.buckets[1] ?? { requests: 0, fetchOrXhr: 0 };
// The summary of LINES has 3 lines in buckets of 2 and 1 requests. Each edit breaks one count and keeps the rest true.
const COUNT_DAMAGE: readonly (readonly [string, (s: RawSummary) => void])[] = [
  [
    "a bucket with a negative request count",
    (s) => {
      second(s).requests = -1;
      second(s).fetchOrXhr = 0;
      s.lines = 1;
    },
  ],
  [
    "a bucket with no request",
    (s) => {
      second(s).requests = 0;
      s.lines = 2;
    },
  ],
  ["a negative fetch or XHR count", (s) => void (second(s).fetchOrXhr = -1)],
  ["more fetch or XHR requests than requests", (s) => void (second(s).fetchOrXhr = 2)],
  [
    "a negative line count",
    (s) => {
      s.lines = -1;
      s.buckets = [];
      s.firstStartedAt = null;
      s.lastStartedAt = null;
    },
  ],
  ["a line count the buckets disagree with", (s) => void (s.lines = 4)],
  ["lines with no first start", (s) => void (s.firstStartedAt = null)],
  [
    "a last start before the first",
    (s) => {
      [s.firstStartedAt, s.lastStartedAt] = [s.lastStartedAt, s.firstStartedAt];
    },
  ],
];

describe("segment summaries", () => {
  const size = bytes(LINES.map(encodeLine).join("").length);

  it("counts lines, the first and last start, and buckets per minute, tab and site", () => {
    const summary = summarize(SEGMENT, LINES, size);
    const tab = { run: RUN, browserId: 7 };
    expect(summary).toEqual({
      segment: SEGMENT,
      firstStartedAt: T0,
      lastStartedAt: T0 + 61_000,
      lines: 3,
      bytes: size,
      buckets: [
        {
          minute: 1_794_799_980_000,
          tab,
          site: SITE,
          requests: 2,
          fetchOrXhr: 2,
          bodyBytesRecorded: 23,
          topUrl: "https://example.com/café?q=\u{1f600}",
        },
        {
          minute: 1_794_800_040_000,
          tab: null,
          site: SITE,
          requests: 1,
          fetchOrXhr: 0,
          bodyBytesRecorded: 0,
          topUrl: request.url,
        },
      ],
    });
  });

  it("a segment with no whole line summarizes to nothing", () => {
    expect(summarize(SEGMENT, [], bytes(0))).toEqual({
      segment: SEGMENT,
      firstStartedAt: null,
      lastStartedAt: null,
      lines: 0,
      bytes: 0,
      buckets: [],
    });
  });

  it("round-trips when the recorded size equals the segment's", () => {
    const summary = summarize(SEGMENT, LINES, size);
    expect(decodeSummary(encodeSummary(summary), size)).toEqual(summary);
  });

  it.each<readonly [string, (s: string) => string, number]>([
    ["a segment that grew after its summary", (s: string) => s, size + 1],
    ["a torn summary", (s: string) => s.slice(0, -1), size],
    [
      "a bucket minute that is not the start of a minute",
      (s: string) => s.replace("1794799980000", "1794799980001"),
      size,
    ],
    ["a zero-filled file after a power loss", (s: string) => "\0".repeat(s.length), size],
    ...COUNT_DAMAGE.map(([label, edit]) => [label, edited(edit), size] as const),
  ])("%s decodes to null", (_label, damage, segmentBytes) => {
    expect(
      decodeSummary(damage(encodeSummary(summarize(SEGMENT, LINES, size))), bytes(segmentBytes)),
    ).toBeNull();
  });

  it("the empty summary, the legal twin of the count checks, round-trips", () => {
    const empty = summarize(SEGMENT, [], bytes(0));
    expect(decodeSummary(encodeSummary(empty), bytes(0))).toEqual(empty);
  });
});
