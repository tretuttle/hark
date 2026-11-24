import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ByteCount, RunId, Site } from "@hark/recording/ids";
import {
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  packId,
  packPath,
  siteDirName,
} from "@hark/recording/layout";
import { encodeSummary, summarize } from "@hark/recording/log";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  ARCHIVE_BROWSE_RATIO,
  ARCHIVE_BROWSE_SLACK_MS,
  ARCHIVE_DOWNLOAD_RATIO,
  ARCHIVE_DOWNLOAD_SLACK_MS,
  detectSlowArchiveCost,
  readProcInfoFromChrome,
} from "../src/cost.ts";
import { BINARY_BYTE_LENGTH } from "../src/fixtures.ts";
import { summarize as summarizeMetric } from "../src/measure.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const MIB = 1_048_576;
const BODY_CAP = 5 * 1024 * MIB;
const DETAIL_CAP = 1024 * MIB;
const PACK_COUNT = 9_800;
const SEGMENT_COUNT = 100; // 100 .jsonl + 100 .summary.json = 200 detail files -> 10,000 files total
const PACK_BYTES = Math.floor((BODY_CAP - 16_384) / PACK_COUNT);
const SEGMENT_LOG_BYTES = Math.floor((DETAIL_CAP - 131_072) / SEGMENT_COUNT);
const SEED_SITES = 30;
const BROWSE_VISITS = 20;
const BLOBS_PER_VISIT = 3;
const BLOB_BYTES = 200_000;
const DAY_MS = 86_400_000;

interface WorkMetricsSnapshot {
  readonly flushCalls: number;
  readonly flushPasses: number;
  readonly flushDeletes: number;
  readonly flushRotates: number;
  readonly flushTouched: number;
  readonly flushMaxTouched: number;
  readonly flushMaxDeletes: number;
  readonly flushMaxRotates: number;
  readonly chunkCalls: number;
  readonly chunkDeletes: number;
  readonly chunkTouched: number;
  readonly chunkMaxTouched: number;
  readonly chunkMaxDeletes: number;
  readonly inventorySize: number;
}

interface StatusWithWork {
  readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
  readonly work: WorkMetricsSnapshot;
}

const assertWorkBound = (label: string, w: WorkMetricsSnapshot, problems: string[]): void => {
  const logFactor = Math.max(8, Math.ceil(Math.log2(w.inventorySize + 2)));
  const perEviction = 6 * logFactor;
  if (w.flushDeletes > 0 && w.flushTouched < w.flushDeletes) {
    problems.push(
      `${label} flushTouched ${String(w.flushTouched)} < deletes ${String(w.flushDeletes)} (counter bypassed)`,
    );
  }
  if (w.chunkDeletes > 0 && w.chunkTouched < w.chunkDeletes) {
    problems.push(
      `${label} chunkTouched ${String(w.chunkTouched)} < deletes ${String(w.chunkDeletes)} (counter bypassed)`,
    );
  }
  const flushLimit = perEviction * (w.flushDeletes + w.flushRotates) + 4 * w.flushPasses;
  if (w.flushTouched > flushLimit) {
    problems.push(
      `${label} flushTouched ${String(w.flushTouched)} > ${String(flushLimit)} (deletes=${String(w.flushDeletes)}, rotates=${String(w.flushRotates)}, passes=${String(w.flushPasses)})`,
    );
  }
  const flushMaxLimit = perEviction * (w.flushMaxDeletes + w.flushMaxRotates) + 12;
  if (w.flushMaxTouched > flushMaxLimit) {
    problems.push(
      `${label} flushMaxTouched ${String(w.flushMaxTouched)} > ${String(flushMaxLimit)} (maxDeletes=${String(w.flushMaxDeletes)}, maxRotates=${String(w.flushMaxRotates)})`,
    );
  }
  const chunkLimit = perEviction * w.chunkDeletes + 4 * w.chunkCalls;
  if (w.chunkTouched > chunkLimit) {
    problems.push(
      `${label} chunkTouched ${String(w.chunkTouched)} > ${String(chunkLimit)} (deletes=${String(w.chunkDeletes)}, calls=${String(w.chunkCalls)})`,
    );
  }
};

const FIVE_GIB_SETTINGS = {
  user: {
    version: 1,
    retention: {
      maxBodyBytes: BODY_CAP,
      maxDetailBytes: DETAIL_CAP,
      maxAgeDays: 14,
    },
    excludedSites: [],
    media: "details-only",
    secretStorage: "store",
    exportDefaults: { bodies: "include", secrets: "remove" },
  },
  exportFolder: { kind: "downloads" },
} as const;

const seedSparseArchive = (root: string): { readonly summaryBytes: number } => {
  const runBase = Math.floor(Date.now() - 3 * DAY_MS).toString(36) as RunId;
  for (let site = 0; site < SEED_SITES; site += 1) {
    const siteHost = `f${String(site)}.localhost` as Site;
    const siteDir = NodePath.join(root, LAYOUT.sitesDir, siteDirName(siteHost));
    NodeFS.mkdirSync(NodePath.join(siteDir, LAYOUT.packDir), { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(siteDir, LAYOUT.logDir), { recursive: true, mode: 0o700 });
  }
  for (let i = 0; i < PACK_COUNT; i += 1) {
    const siteHost = `f${String(i % SEED_SITES)}.localhost` as Site;
    const file = NodePath.join(root, ...packPath(packId(siteHost, runBase, i)));
    const fd = NodeFS.openSync(file, "w", 0o600);
    NodeFS.ftruncateSync(fd, PACK_BYTES);
    NodeFS.closeSync(fd);
  }
  let summaryBytes = 0;
  for (let i = 0; i < SEGMENT_COUNT; i += 1) {
    const siteHost = `f${String(i % SEED_SITES)}.localhost` as Site;
    const seg = logSegmentId(siteHost, runBase, i);
    const logFile = NodePath.join(root, ...logSegmentPath(seg));
    const fd = NodeFS.openSync(logFile, "w", 0o600);
    NodeFS.ftruncateSync(fd, SEGMENT_LOG_BYTES);
    NodeFS.closeSync(fd);
    const mtimeSec = (Date.now() - 3 * DAY_MS + i * 1_000) / 1_000;
    NodeFS.utimesSync(logFile, mtimeSec, mtimeSec);
    const summaryText = encodeSummary(summarize(seg, [], SEGMENT_LOG_BYTES as ByteCount));
    summaryBytes += Buffer.byteLength(summaryText, "utf8");
    NodeFS.writeFileSync(NodePath.join(root, ...logSummaryPath(seg)), summaryText, { mode: 0o600 });
  }
  return { summaryBytes };
};

/**
 * Measures one 50 MB download and 20 flushed site visits against an empty archive and a 10,000-file (9,800 packs +
 * 100 sealed segments + 100 summaries) archive right at the 5 GiB / 1 GiB caps across rotated rounds.
 */
const check: HarnessCheck = {
  name: "cost-archive",
  description:
    "one 50 MB download and 20 flushed visits against 10,000 at-cap archive files stay within ratio budgets of the empty arm",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null || !NodeFS.existsSync(context.extensionPath)) {
      return {
        name: "cost-archive",
        ok: false,
        durationMs: Date.now() - started,
        detail: "needs existing --extension path",
      };
    }
    const addonId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    const rounds = context.short ? 3 : 5;
    await using server = await startFixtureServer();

    const emptyDownloadSamples: number[] = [];
    const fullDownloadSamples: number[] = [];
    const emptyBrowseSamples: number[] = [];
    const fullBrowseSamples: number[] = [];
    const fullWorkSamples: {
      readonly round: number;
      readonly dlWork: WorkMetricsSnapshot;
      readonly brWork: WorkMetricsSnapshot;
    }[] = [];
    const problems: string[] = [];

    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0 ? ([false, true] as const) : ([true, false] as const);
      for (const full of order) {
        const tag = full ? "10k" : "empty";
        await using ws = recordingWorkspace(`cost-archive-${tag}`);
        ws.seed("f".repeat(32), FIVE_GIB_SETTINGS);
        const seeded = full ? seedSparseArchive(ws.root()) : { summaryBytes: 0 };
        await using session = await ws.launch({
          binaryPath: context.binaryPath,
          extensionPath: context.extensionPath,
          display: context.display,
          protocol: "marionette",
          signal: context.signal,
        });
        await waitForActiveExtensionUrl(session, addonId, popupPath);
        await callHook(session, { kind: "flush" });
        const status = (await callHook(session, { kind: "status" })) as {
          readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
        };
        const expectedBodyBytes = full ? PACK_COUNT * PACK_BYTES : 0;
        const expectedDetailBytes = full
          ? SEGMENT_COUNT * SEGMENT_LOG_BYTES + seeded.summaryBytes
          : 0;
        if (
          status.usage.bodyBytes !== expectedBodyBytes ||
          status.usage.detailBytes !== expectedDetailBytes
        ) {
          problems.push(
            `round ${String(round)} ${tag} tracked (${String(status.usage.bodyBytes)}, ${String(status.usage.detailBytes)}) != (${String(expectedBodyBytes)}, ${String(expectedDetailBytes)})`,
          );
        }

        const tab = await session.openTab(`${server.origin}/id/download.html`);
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (full) await callHook(session, { kind: "reset-work" });
        const beforeDownload = await readProcInfoFromChrome(session);
        const received = Number(
          await session.evaluate(
            tab,
            `fetch("/fixtures/binary?n=ca-${String(round)}-${tag}").then((r) => r.arrayBuffer()).then((b) => String(b.byteLength))`,
          ),
        );
        await callHook(session, { kind: "flush" });
        const afterDownload = await readProcInfoFromChrome(session);
        const dlStatus = full
          ? ((await callHook(session, { kind: "status" })) as StatusWithWork)
          : null;
        if (dlStatus !== null) {
          assertWorkBound(`round ${String(round)} dl`, dlStatus.work, problems);
        }
        if (received !== BINARY_BYTE_LENGTH) {
          problems.push(`round ${String(round)} ${tag} received ${String(received)} B`);
        }

        if (full) await callHook(session, { kind: "reset-work" });
        for (let visit = 0; visit < BROWSE_VISITS; visit += 1) {
          await session.navigateTab(
            tab,
            `http://v${String(visit)}.localhost:${String(server.port)}/retention/page`,
          );
          const got = await session.evaluate(
            tab,
            `(async () => { for (let k = 0; k < ${String(BLOBS_PER_VISIT)}; k += 1) { const res = await fetch("/retention/blob?bytes=${String(BLOB_BYTES)}&tag=ca-${String(round)}-${tag}-${String(visit)}-" + k); await res.arrayBuffer(); } return "ok"; })()`,
          );
          if (got !== "ok") {
            problems.push(
              `round ${String(round)} ${tag} visit ${String(visit)} failed: ${String(got)}`,
            );
          }
          await callHook(session, { kind: "flush" });
        }
        const afterBrowse = await readProcInfoFromChrome(session);
        if (dlStatus !== null) {
          const brStatus = (await callHook(session, { kind: "status" })) as StatusWithWork;
          assertWorkBound(`round ${String(round)} browse`, brStatus.work, problems);
          fullWorkSamples.push({ round, dlWork: dlStatus.work, brWork: brStatus.work });
        }

        const dlMs =
          Math.round((afterDownload.mainThreadMs - beforeDownload.mainThreadMs) * 10) / 10;
        const brMs = Math.round((afterBrowse.mainThreadMs - afterDownload.mainThreadMs) * 10) / 10;
        if (round > 0) {
          if (full) {
            fullDownloadSamples.push(dlMs);
            fullBrowseSamples.push(brMs);
          } else {
            emptyDownloadSamples.push(dlMs);
            emptyBrowseSamples.push(brMs);
          }
        }
      }
    }

    const emptyDl = summarizeMetric(emptyDownloadSamples);
    const fullDl = summarizeMetric(fullDownloadSamples);
    const emptyBr = summarizeMetric(emptyBrowseSamples);
    const fullBr = summarizeMetric(fullBrowseSamples);
    if (emptyDl === null || fullDl === null || emptyBr === null || fullBr === null) {
      return {
        name: "cost-archive",
        ok: false,
        durationMs: Date.now() - started,
        detail: "no scored samples collected",
      };
    }

    const verdict = detectSlowArchiveCost({
      emptyDownloadMedianMs: emptyDl.median,
      fullDownloadMedianMs: fullDl.median,
      emptyBrowseMedianMs: emptyBr.median,
      fullBrowseMedianMs: fullBr.median,
    });
    if (!verdict.ok && verdict.reason !== null) problems.push(verdict.reason);

    return {
      name: "cost-archive",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `10,000-file dl ${fullDl.median.toFixed(1)} ms (empty ${emptyDl.median.toFixed(1)}, budget ${verdict.downloadBudgetMs.toFixed(1)}), browse ${fullBr.median.toFixed(1)} ms (empty ${emptyBr.median.toFixed(1)}, budget ${verdict.browseBudgetMs.toFixed(1)})`
          : problems.join("; "),
      data: {
        fileCount: PACK_COUNT + SEGMENT_COUNT * 2,
        packCount: PACK_COUNT,
        segmentCount: SEGMENT_COUNT,
        browseVisits: BROWSE_VISITS,
        rounds,
        emptyDownloadSamples,
        fullDownloadSamples,
        emptyBrowseSamples,
        fullBrowseSamples,
        fullWorkSamples,
        downloadBudgetMs: verdict.downloadBudgetMs,
        browseBudgetMs: verdict.browseBudgetMs,
        downloadRatio: ARCHIVE_DOWNLOAD_RATIO,
        downloadSlackMs: ARCHIVE_DOWNLOAD_SLACK_MS,
        browseRatio: ARCHIVE_BROWSE_RATIO,
        browseSlackMs: ARCHIVE_BROWSE_SLACK_MS,
      },
    };
  },
};

/** @discovered-check */
export default check;
