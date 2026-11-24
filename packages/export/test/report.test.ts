import type { HarEntry } from "@hark/har/model";
import { describe, expect, it } from "vite-plus/test";
import { CUT_SHORT_REASONS, MISSING_REASONS, type MissingReason } from "../src/missing.ts";
import type { ExportReport } from "../src/report.ts";
import { runFake, utf8, type BodyField, type FakeRow, type SideRow } from "./fake-ports.ts";
import { importAltered } from "./alter.ts";

// Every count in the report against a brute-force count from the written entries and the input rows.

const REASONS = Object.keys(MISSING_REASONS) as MissingReason[];

function rng(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return Math.floor((s / 0x1_0000_0000) * n);
  };
}

function randomBody(r: (n: number) => number, devtools: boolean): BodyField {
  switch (r(7)) {
    case 0:
      return "empty";
    case 1:
      return { none: REASONS[r(REASONS.length)]! };
    case 2:
      return { kind: "open-fails", reason: REASONS[r(REASONS.length)]! };
    case 3:
      return devtools
        ? { kind: "text", slices: ["a", "b", "c"], failAt: r(4) }
        : { kind: "bytes", data: utf8("z".repeat(200)), chunk: 30, failAt: r(9) };
    case 4:
      return devtools
        ? { kind: "text", slices: ["ok"] }
        : {
            kind: "bytes",
            data: utf8("w".repeat(50)),
            check: (["length-matched", "sink-only", "first-part"] as const)[r(3)]!,
          };
    default:
      return devtools
        ? { kind: "text", slices: ["dt body"] }
        : { kind: "bytes", data: utf8("body") };
  }
}

interface Trial {
  readonly rows: FakeRow[];
  readonly listCounts: Record<string, number>;
  readonly bodies: "include" | "omit";
}

function randomTrial(r: (n: number) => number): Trial {
  const rows: FakeRow[] = [];
  const n = 1 + r(30);
  for (let i = 0; i < n; i += 1) {
    const scheme = r(10) === 0 ? (["data:", "blob:", "about:"] as const)[r(3)] : "https:";
    const where = r(3);
    const side = (devtools: boolean): SideRow => ({
      inProgress: r(10) === 0,
      loadThrows: r(25) === 0,
      body: randomBody(r, devtools),
      upload: r(3) === 0 ? randomBody(r, devtools) : "empty",
    });
    rows.push({
      id: i + 1,
      url: scheme === "https:" ? `https://t.example/${String(i)}` : `${scheme}x${String(i)}`,
      key: r(12) === 0 ? null : String(i + 1),
      ...(where !== 1 ? { recording: side(false) } : {}),
      ...(where !== 0 ? { devtools: side(true) } : {}),
      ...(r(15) === 0 ? { listedTwice: where === 1 ? "devtools" : "recording" } : {}),
    });
  }
  return {
    rows,
    listCounts: r(2) === 0 ? { "data:": 1 + r(3) } : {},
    bodies: r(7) === 0 ? "omit" : "include",
  };
}

function bruteForce(trial: Trial, entries: readonly HarEntry[]) {
  const ext = (e: HarEntry) => e._harExport as Record<string, unknown>;
  const byReason = (key: string, incomplete: string, cut: boolean) => {
    const out: Record<string, number> = {};
    for (const e of entries) {
      const reason = ext(e)[key];
      if (typeof reason === "string" && (ext(e)[incomplete] === true) === cut)
        out[reason] = (out[reason] ?? 0) + 1;
    }
    return out;
  };
  const network = trial.rows.filter((row) => row.url.startsWith("https:"));
  const notNetwork: Record<string, number> = { ...trial.listCounts };
  for (const row of trial.rows) {
    if (row.url.startsWith("https:")) continue;
    const scheme = `${row.url.split(":")[0]!}:`;
    const listed = (row.recording ? 1 : 0) + (row.devtools ? 1 : 0) + (row.listedTwice ? 1 : 0);
    notNetwork[scheme] = (notNetwork[scheme] ?? 0) + listed;
  }
  const loadFailed = (source: "recording" | "devtools") =>
    entries.filter((e) => ((ext(e)["loadFailed"] as string[] | undefined) ?? []).includes(source))
      .length;
  return {
    requests: entries.length,
    sources: {
      both: entries.filter((e) => ext(e)["source"] === "both").length,
      recordingOnly: entries.filter((e) => ext(e)["source"] === "recording-only").length,
      devtoolsOnly: entries.filter((e) => ext(e)["source"] === "devtools-only").length,
    },
    unpaired: network
      .filter((row) => row.key === null)
      .reduce(
        (sum, row) =>
          sum + (row.recording ? 1 : 0) + (row.devtools ? 1 : 0) + (row.listedTwice ? 1 : 0),
        0,
      ),
    duplicates: {
      recording: network.filter((row) => row.listedTwice === "recording" && row.key !== null)
        .length,
      devtools: network.filter((row) => row.listedTwice === "devtools" && row.key !== null).length,
    },
    inProgress: entries.filter((e) => ext(e)["inProgress"] === true).length,
    notNetwork,
    loadFailed: { recording: loadFailed("recording"), devtools: loadFailed("devtools") },
    response: {
      included: entries.filter((e) => ext(e)["bodyState"] === "present").length,
      empty: entries.filter((e) => ext(e)["bodyState"] === "empty").length,
      cutShort: byReason("bodyMissing", "bodyIncomplete", true),
      missing: byReason("bodyMissing", "bodyIncomplete", false),
      unchecked: entries.filter((e) => ext(e)["bodyCheck"] === "sink-only").length,
      // Paired, headers from DevTools, body from the recording's store (only stored bodies carry a check).
      filledIn: entries.filter(
        (e) =>
          ext(e)["source"] === "both" &&
          ext(e)["bodyState"] === "present" &&
          ext(e)["bodyCheck"] !== undefined &&
          !((ext(e)["loadFailed"] as string[] | undefined) ?? []).includes("devtools"),
      ).length,
    },
    request: {
      included: entries.filter(
        (e) => e.request.postData !== undefined && ext(e)["uploadIncomplete"] !== true,
      ).length,
      empty: entries.filter((e) => e.request.bodySize === 0 && e.request.postData === undefined)
        .length,
      cutShort: byReason("uploadMissing", "uploadIncomplete", true),
      missing: byReason("uploadMissing", "uploadIncomplete", false),
    },
  };
}

function reported(report: ExportReport) {
  const { lossyText: _lossy, ...response } = report.bodies.response;
  const { lossyText: _requestLossy, ...request } = report.bodies.request;
  return {
    requests: report.requests,
    sources: report.sources,
    unpaired: report.unpaired,
    duplicates: report.duplicates,
    inProgress: report.inProgress,
    notNetwork: report.notNetwork,
    loadFailed: report.sourceErrors.load,
    response,
    request,
  };
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
        )
      : value;

async function checkTrial(
  trial: Trial,
  run?: typeof import("../src/run.ts").runExport,
): Promise<string | null> {
  const result = await runFake({
    rows: trial.rows,
    bodies: trial.bodies,
    notNetwork: { devtools: trial.listCounts },
    ...(run ? { runExport: run } : {}),
  });
  if (result.error !== null) return String(result.error);
  const doc = JSON.parse(result.text) as {
    log: { entries: HarEntry[]; comment: string; _harExport: { report: unknown } };
  };
  const want = bruteForce(trial, doc.log.entries);
  const got = reported(result.report!);
  if (JSON.stringify(sorted(want)) !== JSON.stringify(sorted(got))) {
    return `brute ${JSON.stringify(sorted(want))}\nreport ${JSON.stringify(sorted(got))}`;
  }
  const inFile = {
    ...result.report!,
    redaction: { choice: "none" },
    fileBytes: (doc.log._harExport.report as { fileBytes: number }).fileBytes,
  };
  if (JSON.stringify(doc.log._harExport.report) !== JSON.stringify(inFile))
    return "file report differs";
  const missing = Object.values(want.response.missing).reduce((a, b) => a + b, 0);
  const cut = Object.values(want.response.cutShort).reduce((a, b) => a + b, 0);
  const comment = doc.log.comment;
  const expectations = [
    comment.startsWith(`Exported ${String(want.requests)} request`),
    missing === 0
      ? !/\d+ bod(y|ies) not available/u.test(comment.replace(/request bod(y|ies)/gu, ""))
      : comment.includes(`${String(missing)} ${missing === 1 ? "body" : "bodies"} not available`),
    cut === 0 || comment.includes(`${String(cut)} ${cut === 1 ? "body" : "bodies"} cut short`),
  ];
  return expectations.every(Boolean) ? null : `comment: ${comment}`;
}

describe("report", () => {
  it("equals a brute-force count from the written file in 300 random trials", async () => {
    const r = rng(99);
    for (let trial = 0; trial < 300; trial += 1) {
      expect(await checkTrial(randomTrial(r)), `trial ${String(trial)}`).toBeNull();
    }
  });

  it("names every loss reason in plain words without em dashes", () => {
    const labels = [...Object.values(MISSING_REASONS), ...Object.values(CUT_SHORT_REASONS)].map(
      (row) => row.reportLabel,
    );
    for (const label of labels) expect(label).not.toMatch(/[–—]|\p{Extended_Pictographic}/u);
  });

  it("a tally that drops duplicates or counts cut-short as missing disagrees with the brute-force count", async () => {
    const changes = [
      {
        id: "duplicates-uncounted",
        file: "merge.ts",
        from: "    dropped += 1;\n",
        to: "",
      },
      {
        id: "cut-short-as-missing",
        file: "report.ts",
        from: "        cutShort: bump(place.cutShort, outcome.reason),",
        to: "        missing: bump(place.missing, outcome.reason as MissingReason),",
      },
    ];
    for (const change of changes) {
      const run = await importAltered<typeof import("../src/run.ts")>(
        change.file,
        change,
        "run.ts",
      );
      const r = rng(99);
      let caught = false;
      for (let trial = 0; trial < 60 && !caught; trial += 1) {
        caught = (await checkTrial(randomTrial(r), run.runExport)) !== null;
      }
      expect(caught, change.id).toBe(true);
    }
  });
});
