import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { AnsweredExchange, BodyLocation, SettledExchange } from "@hark/recording/exchange";
import type { ByteCount } from "@hark/recording/ids";
import { LAYOUT } from "@hark/recording/layout";
import { decodeLine, decodeSummary, summarize, type LogLine } from "@hark/recording/log";
import type { BodyRouteId } from "@hark/recording/routes";
import type { ArchiveEntry, ArchiveLine } from "./archive.ts";

/** What a stored body must hash to, from the fixture server or from what the page itself received. */
export type ExpectedBody = { readonly sha256: string; readonly length: number };

export type BodyVerdict = {
  readonly url: string;
  readonly verdict: "exact" | "wrong" | "missing" | "no-reference";
  readonly detail: string;
};

const sha256 = (bytes: Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const pathOf = (exchange: SettledExchange): string => new URL(exchange.request.url).pathname;

export const responseHeader = (exchange: AnsweredExchange, name: string): string | null =>
  exchange.response.headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

type StoredLine = AnsweredExchange & {
  readonly body: { readonly kind: "stored"; readonly at: BodyLocation };
};

export const storedLines = (lines: readonly ArchiveLine[]): readonly StoredLine[] =>
  lines.flatMap(({ exchange }) =>
    exchange.kind === "answered" && exchange.body.kind === "stored" ? [exchange as StoredLine] : [],
  );

/** Every stored body against its expected digest. A wrong byte anywhere in the body changes the digest. */
export function checkStoredBodies(
  lines: readonly ArchiveLine[],
  expectedFor: (exchange: StoredLine) => ExpectedBody | null,
  read: (at: BodyLocation) => Buffer | null,
): readonly BodyVerdict[] {
  return storedLines(lines).map((exchange) => {
    const url = exchange.request.url;
    const expected = expectedFor(exchange);
    if (expected === null)
      return { url, verdict: "no-reference", detail: "nothing to compare with" };
    const bytes = read(exchange.body.at);
    if (bytes === null) return { url, verdict: "missing", detail: "stored location not on disk" };
    const actual = sha256(bytes);
    return actual === expected.sha256 && bytes.length === expected.length
      ? { url, verdict: "exact", detail: `${String(bytes.length)} bytes` }
      : {
          url,
          verdict: "wrong",
          detail: `${String(bytes.length)} bytes ${actual.slice(0, 12)}, expected ${String(expected.length)} ${expected.sha256.slice(0, 12)}`,
        };
  });
}

/** The same bytes with the first byte at `target` flipped, which a body check reads as one wrong body. */
export const flipFirstByte =
  (read: (at: BodyLocation) => Buffer | null, target: BodyLocation) =>
  (at: BodyLocation): Buffer | null => {
    const bytes = read(at);
    if (bytes === null || at !== target || bytes.length === 0) return bytes;
    const copy = Buffer.from(bytes);
    copy[0] = (copy[0] ?? 0) ^ 0xff;
    return copy;
  };

type Expectation = {
  readonly id: string;
  /** null when the archive reads as expected. */
  readonly problem: (lines: readonly SettledExchange[]) => string | null;
};

const withPath = (lines: readonly SettledExchange[], path: string): readonly SettledExchange[] =>
  lines.filter((exchange) => pathOf(exchange) === path);

const answered = (lines: readonly SettledExchange[]): readonly AnsweredExchange[] =>
  lines.flatMap((exchange) => (exchange.kind === "answered" ? [exchange] : []));

/** Each body route, the fixture path that exercises it, and the body it must settle to. */
export const BODY_ROUTE_FIXTURES: readonly {
  readonly route: BodyRouteId;
  readonly path: string;
  readonly body: "empty" | "not-kept" | "stored";
}[] = [
  { route: "no-body", path: "/route/no-content", body: "empty" },
  { route: "redirect", path: "/id/r1", body: "empty" },
  { route: "streaming", path: "/route/events", body: "not-kept" },
  { route: "media-details", path: "/fixtures/video", body: "not-kept" },
  { route: "small", path: "/fixtures/range", body: "stored" },
  { route: "large-or-unknown", path: "/fixtures/chunked", body: "stored" },
];

export const routeExpectations: readonly Expectation[] = BODY_ROUTE_FIXTURES.map(
  ({ route, path, body }) => ({
    id: `route ${route}`,
    problem: (lines) => {
      const found = answered(withPath(lines, path));
      if (found.length === 0) return `${path}: no answered line`;
      const wrong = found.filter(
        (exchange) => exchange.route !== route || exchange.body.kind !== body,
      );
      return wrong.length === 0
        ? null
        : `${path}: ${wrong.map((e) => `${e.route} ${e.body.kind}`).join(", ")}, expected ${route} ${body}`;
    },
  }),
);

/** How the archive records each identity fixture. Body bytes are compared separately. */
export const identityExpectations: readonly Expectation[] = [
  {
    id: "both /poll bodies stored",
    problem: (lines) => {
      const polls = answered(withPath(lines, "/poll")).filter((e) => e.body.kind === "stored");
      return polls.length === 2 ? null : `${String(polls.length)} stored /poll bodies, expected 2`;
    },
  },
  {
    id: "the cancelled download is network-aborted",
    problem: (lines) => {
      const big = answered(withPath(lines, "/id/big"));
      return big.length === 1 &&
        big[0]?.body.kind === "incomplete" &&
        big[0].body.reason === "network-aborted"
        ? null
        : `/id/big read as ${JSON.stringify(big.map((e) => e.body))}`;
    },
  },
  {
    id: "the 304 is one exchange with status 304 and a stored body",
    problem: (lines) => {
      const reval = answered(withPath(lines, "/id/reval"));
      const statuses = reval.map((e) => `${String(e.response.status)} ${e.body.kind}`).sort();
      return JSON.stringify(statuses) === JSON.stringify(["200 stored", "304 stored"])
        ? null
        : `/id/reval lines: ${statuses.join(", ")}`;
    },
  },
  {
    id: "the cache hit is stored from the cache",
    problem: (lines) => {
      const sources = answered(withPath(lines, "/id/cached")).map(
        (e) => `${e.response.source} ${e.body.kind}`,
      );
      return sources.includes("cache stored") ? null : `/id/cached lines: ${sources.join(", ")}`;
    },
  },
  {
    id: "redirect hops are empty and the target is stored once",
    problem: (lines) => {
      const hops = answered([...withPath(lines, "/id/r1"), ...withPath(lines, "/id/r2")]);
      const finals = answered(withPath(lines, "/id/rfinal"));
      return hops.length === 2 &&
        hops.every((e) => e.route === "redirect" && e.body.kind === "empty") &&
        finals.length === 1 &&
        finals[0]?.body.kind === "stored"
        ? null
        : `hops ${JSON.stringify(hops.map((e) => [e.route, e.body.kind]))}, targets ${String(finals.length)}`;
    },
  },
  {
    id: "both service-worker responses are stored from the worker",
    problem: (lines) => {
      const worker = answered([
        ...withPath(lines, "/sw/synth"),
        ...withPath(lines, "/sw/pass"),
      ]).filter((e) => e.response.source === "service-worker" && e.body.kind === "stored");
      return worker.map(pathOf).sort().join(",") === "/sw/pass,/sw/synth"
        ? null
        : `service-worker lines stored: ${worker.map(pathOf).join(", ")}`;
    },
  },
  {
    id: "the refused port is an unanswered line with NS_ERROR_CONNECTION_REFUSED",
    problem: (lines) => {
      const refused = withPath(lines, "/refused");
      const first = refused[0];
      return refused.length === 1 &&
        first?.kind === "unanswered" &&
        first.stop.status.kind === "failed" &&
        first.stop.status.error === "NS_ERROR_CONNECTION_REFUSED"
        ? null
        : `/refused read as ${JSON.stringify(refused.map((e) => [e.kind, "stop" in e ? e.stop.status : null]))}`;
    },
  },
];

export const checkExpectations = (
  expectations: readonly Expectation[],
  lines: readonly ArchiveLine[],
): readonly string[] => {
  const exchanges = lines.map((line) => line.exchange);
  return expectations.flatMap((e) => {
    const problem = e.problem(exchanges);
    return problem === null ? [] : [`${e.id}: ${problem}`];
  });
};

/** Directories 0700 and files 0600, and at least one file of each kind, so no kind escapes the rule unseen. */
export const checkArchiveModes = (
  entries: readonly ArchiveEntry[],
  kinds: readonly string[],
): readonly string[] => [
  ...entries
    .filter((e) => e.mode !== (e.kind === "directory" ? 0o700 : 0o600))
    .map((e) => `${e.path} is ${e.kind} mode ${e.mode.toString(8)}`),
  ...kinds
    .filter((kind) => !entries.some((e) => e.kind === "file" && e.path.endsWith(`.${kind}`)))
    .map((kind) => `no .${kind} file was written to check`),
];

/** The extension never adds to the Downloads list, so no download may point anywhere under the data home. */
export const checkDownloads = (targets: readonly string[], dataHome: string): string | null => {
  const inside = targets.filter((target) => target.startsWith(`${dataHome}/`));
  return inside.length === 0
    ? null
    : `the Downloads list points into the data home: ${inside.join(", ")}`;
};

export interface SummaryCheckInput {
  readonly name: string;
  readonly raw: string | null;
  readonly segmentBytes: number;
  readonly segmentText: string;
}

/** Every segment summary must decode and match its segment's bytes, line count, timestamps, and buckets on disk. */
export const checkSummaryFiles = (summaries: readonly SummaryCheckInput[]): readonly string[] => {
  if (summaries.length === 0) return ["no summary files found to check"];
  const problems: string[] = [];
  for (const s of summaries) {
    if (s.raw === null) {
      problems.push(`${s.name}: summary missing`);
      continue;
    }
    const decoded = decodeSummary(s.raw, s.segmentBytes as ByteCount);
    if (decoded === null) {
      problems.push(`${s.name}: summary does not decode or size != ${String(s.segmentBytes)}`);
      continue;
    }
    const lastNewline = s.segmentText.lastIndexOf("\n");
    const whole = lastNewline === -1 ? "" : s.segmentText.slice(0, lastNewline);
    const validLines =
      whole.length === 0
        ? []
        : whole
            .split("\n")
            .filter((entry) => entry.length > 0)
            .map(decodeLine)
            .filter((entry): entry is LogLine => entry !== null);
    const expected = summarize(decoded.segment, validLines, s.segmentBytes as ByteCount);
    if (decoded.lines !== expected.lines) {
      problems.push(
        `${s.name}: summary lines ${String(decoded.lines)} != segment lines ${String(expected.lines)}`,
      );
    }
    if (
      decoded.firstStartedAt !== expected.firstStartedAt ||
      decoded.lastStartedAt !== expected.lastStartedAt
    ) {
      problems.push(`${s.name}: summary timestamps do not match segment lines`);
    }
    if (JSON.stringify(decoded.buckets) !== JSON.stringify(expected.buckets)) {
      problems.push(`${s.name}: summary buckets do not match segment lines`);
    }
  }
  return problems;
};

export interface DiskArchiveLedger {
  readonly partBytes: number;
  readonly partCount: number;
  readonly packBytes: number;
  readonly bodyFileBytes: number;
  readonly bodyBytes: number;
  readonly logBytes: number;
  readonly summaryBytes: number;
  readonly detailBytes: number;
  readonly summaries: readonly SummaryCheckInput[];
  readonly missingSummarySegments: readonly string[];
}

export interface ObservedPinFile {
  readonly label: string;
  readonly exists: boolean;
  readonly expectedSha256?: string;
  readonly actualSha256?: string | null;
}

export interface ArchiveLedgerInput {
  readonly step: string;
  readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
  readonly disk: DiskArchiveLedger;
  readonly pinned?: readonly ObservedPinFile[];
  readonly expectZeroParts?: boolean;
  readonly maxBodyBytes?: number;
  readonly requireAllSummarized?: boolean;
}

/** Single step invariant: every ledger total matches disk stat totals, pinned files stay intact, and summaries match logs. */
export const compareArchiveLedger = (input: ArchiveLedgerInput): readonly string[] => {
  const problems: string[] = [];
  if (input.usage.bodyBytes !== input.disk.bodyBytes) {
    problems.push(
      `${input.step}: usage.bodyBytes ${String(input.usage.bodyBytes)} != disk ${String(input.disk.bodyBytes)} (packs=${String(input.disk.packBytes)}, bodies=${String(input.disk.bodyFileBytes)}, parts=${String(input.disk.partBytes)})`,
    );
  }
  if (input.usage.detailBytes !== input.disk.detailBytes) {
    problems.push(
      `${input.step}: usage.detailBytes ${String(input.usage.detailBytes)} != disk ${String(input.disk.detailBytes)} (logs=${String(input.disk.logBytes)}, summaries=${String(input.disk.summaryBytes)})`,
    );
  }
  if (input.expectZeroParts === true && input.disk.partCount > 0) {
    problems.push(
      `${input.step}: expected 0 parts in incoming/, found ${String(input.disk.partCount)}`,
    );
  }
  if (input.maxBodyBytes !== undefined && input.disk.bodyBytes > input.maxBodyBytes) {
    problems.push(
      `${input.step}: disk bodyBytes ${String(input.disk.bodyBytes)} > cap ${String(input.maxBodyBytes)}`,
    );
  }
  for (const pin of input.pinned ?? []) {
    if (!pin.exists) {
      problems.push(`${input.step}: pinned file missing (${pin.label})`);
      continue;
    }
    if (pin.expectedSha256 !== undefined && pin.actualSha256 !== pin.expectedSha256) {
      problems.push(`${input.step}: pinned file SHA-256 changed (${pin.label})`);
    }
  }
  if (input.requireAllSummarized === true) {
    for (const seg of input.disk.missingSummarySegments) {
      problems.push(`${input.step}: missing summary for sealed segment ${seg}`);
    }
  }
  if (input.disk.summaries.length > 0) {
    for (const p of checkSummaryFiles(input.disk.summaries)) {
      problems.push(`${input.step}: ${p}`);
    }
  }
  return problems;
};

const sumDir = (
  dir: string,
  suffix?: string,
): { readonly bytes: number; readonly count: number } => {
  if (!NodeFS.existsSync(dir)) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  for (const name of NodeFS.readdirSync(dir)) {
    if (suffix !== undefined && !name.endsWith(suffix)) continue;
    bytes += NodeFS.statSync(NodePath.join(dir, name)).size;
    count += 1;
  }
  return { bytes, count };
};

export function measureArchiveDisk(root: string): DiskArchiveLedger {
  const incoming = sumDir(NodePath.join(root, LAYOUT.incomingDir), ".part");
  let packBytes = 0;
  let bodyFileBytes = 0;
  let logBytes = 0;
  let summaryBytes = 0;
  const summaries: SummaryCheckInput[] = [];
  const missingSummarySegments: string[] = [];

  const sitesDir = NodePath.join(root, LAYOUT.sitesDir);
  if (NodeFS.existsSync(sitesDir)) {
    for (const siteDir of NodeFS.readdirSync(sitesDir).sort()) {
      const full = NodePath.join(sitesDir, siteDir);
      packBytes += sumDir(NodePath.join(full, LAYOUT.packDir), ".pack").bytes;
      bodyFileBytes += sumDir(NodePath.join(full, LAYOUT.bodyDir)).bytes;
      const logDir = NodePath.join(full, LAYOUT.logDir);
      logBytes += sumDir(logDir, ".jsonl").bytes;
      summaryBytes += sumDir(logDir, ".summary.json").bytes;
      if (NodeFS.existsSync(logDir)) {
        for (const file of NodeFS.readdirSync(logDir)
          .filter((n) => n.endsWith(".jsonl"))
          .sort()) {
          const segPath = NodePath.join(logDir, file);
          const sumName = file.replace(/\.jsonl$/u, ".summary.json");
          const sumPath = NodePath.join(logDir, sumName);
          if (!NodeFS.existsSync(sumPath)) {
            missingSummarySegments.push(`${siteDir}/${file}`);
            continue;
          }
          summaries.push({
            name: `${siteDir}/${sumName}`,
            raw: NodeFS.readFileSync(sumPath, "utf8"),
            segmentBytes: NodeFS.statSync(segPath).size,
            segmentText: NodeFS.readFileSync(segPath, "utf8"),
          });
        }
      }
    }
  }

  return {
    partBytes: incoming.bytes,
    partCount: incoming.count,
    packBytes,
    bodyFileBytes,
    bodyBytes: incoming.bytes + packBytes + bodyFileBytes,
    logBytes,
    summaryBytes,
    detailBytes: logBytes + summaryBytes,
    summaries,
    missingSummarySegments,
  };
}

export function sha256File(path: string): string | null {
  if (!NodeFS.existsSync(path)) return null;
  return sha256(NodeFS.readFileSync(path));
}

export function checkArchiveOnDisk(options: {
  readonly root: string;
  readonly step: string;
  readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
  readonly pinned?: readonly {
    readonly label: string;
    readonly path: string;
    readonly expectedSha256?: string;
  }[];
  readonly expectZeroParts?: boolean;
  readonly maxBodyBytes?: number;
  readonly requireAllSummarized?: boolean;
}): { readonly disk: DiskArchiveLedger; readonly problems: readonly string[] } {
  const disk = measureArchiveDisk(options.root);
  const pinned: ObservedPinFile[] = (options.pinned ?? []).map((p) => {
    const exists = NodeFS.existsSync(p.path);
    return {
      label: p.label,
      exists,
      ...(p.expectedSha256 === undefined
        ? {}
        : { expectedSha256: p.expectedSha256, actualSha256: sha256File(p.path) }),
    };
  });
  const problems = compareArchiveLedger({
    step: options.step,
    usage: options.usage,
    disk,
    pinned,
    ...(options.expectZeroParts === undefined ? {} : { expectZeroParts: options.expectZeroParts }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.requireAllSummarized === undefined
      ? {}
      : { requireAllSummarized: options.requireAllSummarized }),
  });
  return { disk, problems };
}

export interface RetentionRunCheck {
  readonly capBytes: number;
  readonly flushBatchBytes: number;
  readonly totalServedBytes: number;
  readonly duSamples: readonly number[];
  readonly duAfterFlush: number;
  readonly usageBodyBytesAfterFlush?: number;
  readonly diskBodyBytesAfterFlush?: number;
  readonly detailBytesAfterFlush?: number;
  readonly pinCheck?: {
    readonly oldestPackIsActuallyOldest?: boolean;
    readonly oldestPackExistsBeforeUnpin: boolean;
    readonly newestPackExistsBeforeUnpin: boolean;
    readonly problemsBeforeUnpin: readonly string[];
    readonly oldestPackExistsAfterUnpin: boolean;
    readonly problemsAfterUnpin: readonly string[];
    readonly duAfterUnpin: number;
    readonly usageBodyBytesAfterUnpin?: number;
    readonly diskBodyBytesAfterUnpin?: number;
    readonly detailBytesAfterUnpin?: number;
  };
}

export const checkRetentionRun = (run: RetentionRunCheck): readonly string[] => {
  const problems: string[] = [];
  if (run.totalServedBytes <= run.capBytes) {
    problems.push(
      `served ${String(run.totalServedBytes)} B did not exceed cap ${String(run.capBytes)} B`,
    );
  }
  const bound = run.capBytes + run.flushBatchBytes;
  for (const [index, sample] of run.duSamples.entries()) {
    if (sample > bound) {
      problems.push(
        `du sample ${String(index)} was ${String(sample)} B > cap+batch ${String(bound)} B`,
      );
    }
  }
  if (
    run.usageBodyBytesAfterFlush !== undefined &&
    run.diskBodyBytesAfterFlush !== undefined &&
    run.usageBodyBytesAfterFlush !== run.diskBodyBytesAfterFlush
  ) {
    problems.push(
      `usage.bodyBytes after flush was ${String(run.usageBodyBytesAfterFlush)} B != disk ${String(run.diskBodyBytesAfterFlush)} B`,
    );
  }
  if (run.diskBodyBytesAfterFlush !== undefined && run.diskBodyBytesAfterFlush > run.capBytes) {
    problems.push(
      `body bytes on disk after flush were ${String(run.diskBodyBytesAfterFlush)} B > cap ${String(run.capBytes)} B`,
    );
  }
  const flushRootLimit =
    run.detailBytesAfterFlush === undefined
      ? run.capBytes
      : run.capBytes + run.detailBytesAfterFlush + 16_384;
  if (run.duAfterFlush > flushRootLimit) {
    problems.push(
      `du after flush was ${String(run.duAfterFlush)} B > cap limit ${String(flushRootLimit)} B`,
    );
  }
  if (run.pinCheck !== undefined) {
    const p = run.pinCheck;
    if (p.oldestPackIsActuallyOldest === false) {
      problems.push("pin-oldest-pack did not pin the oldest pack on disk");
    }
    if (!p.oldestPackExistsBeforeUnpin) problems.push("retention deleted a pinned pack");
    if (!p.newestPackExistsBeforeUnpin) {
      problems.push("retention skipped past a pin and deleted the newest pack");
    }
    if (!p.problemsBeforeUnpin.includes("over-cap-while-exporting")) {
      problems.push(
        `over-cap-while-exporting not reported while pinned over cap: ${JSON.stringify(p.problemsBeforeUnpin)}`,
      );
    }
    if (p.oldestPackExistsAfterUnpin) {
      problems.push("previously pinned pack was not deleted after unpin");
    }
    if (p.problemsAfterUnpin.includes("over-cap-while-exporting")) {
      problems.push("over-cap-while-exporting remained reported after unpin");
    }
    if (
      p.usageBodyBytesAfterUnpin !== undefined &&
      p.diskBodyBytesAfterUnpin !== undefined &&
      p.usageBodyBytesAfterUnpin !== p.diskBodyBytesAfterUnpin
    ) {
      problems.push(
        `usage.bodyBytes after unpin was ${String(p.usageBodyBytesAfterUnpin)} B != disk ${String(p.diskBodyBytesAfterUnpin)} B`,
      );
    }
    if (p.diskBodyBytesAfterUnpin !== undefined && p.diskBodyBytesAfterUnpin > run.capBytes) {
      problems.push(
        `body bytes on disk after unpin were ${String(p.diskBodyBytesAfterUnpin)} B > cap ${String(run.capBytes)} B`,
      );
    }
    const unpinRootLimit =
      p.detailBytesAfterUnpin === undefined
        ? run.capBytes
        : run.capBytes + p.detailBytesAfterUnpin + 16_384;
    if (p.duAfterUnpin > unpinRootLimit) {
      problems.push(
        `du after unpin was ${String(p.duAfterUnpin)} B > cap limit ${String(unpinRootLimit)} B`,
      );
    }
  }
  return problems;
};

export interface ExcludeDuringTeeCheck {
  readonly excludedSite: string;
  readonly siteDirExistsDuringTee: boolean;
  readonly sitesIndexDuringTee: readonly string[];
  readonly partCountDuringTee: number;
  readonly siteDirExistsAfterStop: boolean;
  readonly partsAfterStop: readonly string[];
  readonly sitesIndexAfterStop: readonly string[];
  readonly problems: readonly string[];
}

export const checkExcludeDuringTee = (run: ExcludeDuringTeeCheck): readonly string[] => {
  const problems: string[] = [];
  if (run.problems.length > 0) {
    problems.push(`store reported problems: ${run.problems.join(", ")}`);
  }
  if (run.siteDirExistsDuringTee)
    problems.push("site directory remained after exclude while tee streamed");
  if (run.sitesIndexDuringTee.includes(run.excludedSite)) {
    problems.push(`${run.excludedSite} stayed in index during tee`);
  }
  if (run.partCountDuringTee < 1) problems.push("no streaming part observed before exclude");
  if (run.siteDirExistsAfterStop) {
    problems.push("site directory reappeared after streaming tee stopped");
  }
  if (run.partsAfterStop.length > 0) {
    problems.push(`part files left after tee stopped: ${run.partsAfterStop.join(", ")}`);
  }
  if (run.sitesIndexAfterStop.includes(run.excludedSite)) {
    problems.push(`${run.excludedSite} reappeared in index after tee stopped`);
  }
  return problems;
};
