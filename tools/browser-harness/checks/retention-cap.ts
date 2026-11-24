import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { PackId, Site } from "@hark/recording/ids";
import { FLUSH_BATCH_BYTES, LAYOUT, packPath, siteDirName } from "@hark/recording/layout";
import { readStoredBytes } from "../src/archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { BINARY_BYTE_LENGTH, buildBody, listFixtures } from "../src/fixtures.ts";
import { until } from "../src/kill-at-point.ts";
import {
  checkArchiveOnDisk,
  checkRetentionRun,
  checkStoredBodies,
  sha256File,
} from "../src/recording-verify.ts";
import {
  callHook,
  recordingWorkspace,
  SMALL_CAP_BYTES,
  SMALL_CAP_SETTINGS,
} from "../src/recording-session.ts";
import { expectedFromServer } from "../src/recording-truth.ts";
import { startFixtureServer } from "../src/server.ts";

const CAP_BYTES = SMALL_CAP_SETTINGS.user.retention.maxBodyBytes;
const SMALL_BLOB_BYTES = 850_000;
const LARGE_BLOB_BYTES = 2_000_000;
const SITE_COUNT = 20;
const PIN_SITES = 16;
const PARALLEL_DOWNLOADS = 5;
const DU_SAMPLE_MS = 200;
const PAUSE_AT_BYTES = 30_000_000;
const PARALLEL_PAUSE_AT_BYTES = 20_000_000;

const duBytes = (directory: string): number => {
  if (!NodeFS.existsSync(directory)) return 0;
  const out = NodeChildProcess.execFileSync("du", ["-sb", directory], { encoding: "utf8" });
  const bytes = Number(out.trim().split(/\s+/u)[0]);
  if (!Number.isFinite(bytes)) throw new Error(`unexpected du output: ${out}`);
  return bytes;
};

const partSizes = (incomingDir: string): number[] =>
  NodeFS.existsSync(incomingDir)
    ? NodeFS.readdirSync(incomingDir)
        .filter((n) => n.endsWith(".part"))
        .map((n) => NodeFS.statSync(NodePath.join(incomingDir, n)).size)
        .sort((a, b) => a - b)
    : [];

/** Waits until `count` active parts exist and stop growing for 600 ms before reading status/disk together. */
const waitPartsSettled = async (incomingDir: string, count: number): Promise<void> => {
  let lastKey = "";
  let stableSince = Date.now();
  await until(
    () => {
      const sizes = partSizes(incomingDir);
      const key = JSON.stringify(sizes);
      if (key !== lastKey) {
        lastKey = key;
        stableSince = Date.now();
      }
      return sizes.length >= count && sizes.every((s) => s > 0) && Date.now() - stableSince >= 600;
    },
    `${String(count)} settled parts in incoming/`,
  );
};

const startRootSampler = (root: string, samples: number[]): (() => void) => {
  let sampling = false;
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    try {
      samples.push(duBytes(root));
    } finally {
      sampling = false;
    }
  }, DU_SAMPLE_MS);
  return () => {
    clearInterval(timer);
    samples.push(duBytes(root));
  };
};

interface StatusSnapshot {
  readonly problems: readonly string[];
  readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
  readonly overBudgetReentries?: number;
}

const readStatus = async (session: BrowserSession): Promise<StatusSnapshot> =>
  (await callHook(session, { kind: "status" })) as StatusSnapshot;

const statusProblems = async (
  session: BrowserSession,
  popupTab: string,
): Promise<readonly string[]> => {
  const raw = await session.evaluate(
    popupTab,
    "browser.hark.getRecordingStatus().then(JSON.stringify)",
  );
  const parsed = JSON.parse(raw) as { readonly problems: readonly string[] };
  return parsed.problems;
};

const fetchMixedSite = async (
  session: BrowserSession,
  tab: string,
  port: number,
  site: string,
): Promise<void> => {
  await session.navigateTab(tab, `http://${site}:${String(port)}/retention/page`);
  await session.evaluate(
    tab,
    `Promise.all([
      ...[0, 1, 2, 3].map((i) =>
        fetch("/retention/blob?bytes=${String(SMALL_BLOB_BYTES)}&tag=${site}-m-" + i).then((r) => r.arrayBuffer()),
      ),
      fetch("/retention/blob?bytes=${String(LARGE_BLOB_BYTES)}&tag=${site}-f-0").then((r) => r.arrayBuffer()),
    ]).then(() => "done")`,
  );
};

const fetchSmallBlobs = async (
  session: BrowserSession,
  tab: string,
  port: number,
  site: string,
  count: number,
): Promise<void> => {
  await session.navigateTab(tab, `http://${site}:${String(port)}/retention/page`);
  await session.evaluate(
    tab,
    `(async () => {
      for (let i = 0; i < ${String(count)}; i += 1) {
        const res = await fetch("/retention/blob?bytes=${String(SMALL_BLOB_BYTES)}&tag=${site}-" + i);
        await res.arrayBuffer();
      }
      return "done";
    })()`,
  );
};

/**
 * Under a 64 MiB cap across 20 mixed sites + 2 paused 50 MB downloads, plus a dedicated 5-parallel 50 MB download
 * run, 200 ms du samples stay <= cap + FLUSH_BATCH_BYTES and the tracked usage matches the archive on disk after every
 * step. Holding a pin while file tees stream past cap preserves the pinned pack until unpinned.
 */
const check: HarnessCheck = {
  name: "retention-cap",
  description:
    "20 mixed sites, 2 paused + 5 parallel 50 MB stay bounded on du; pinned file tees keep oldest pack until unpinned",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null) {
      return { name: "retention-cap", ok: false, durationMs: 0, detail: "needs --extension" };
    }
    const addonId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    const base = {
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette" as const,
      signal: context.signal,
    };

    const problems: string[] = [];
    const duSamples: number[] = [];
    let duAfterFlush = 0;
    let totalServedBytes = 0;
    let usageBodyBytesAfterFlush = 0;
    let diskBodyBytesAfterFlush = 0;
    let detailBytesAfterFlush = 0;
    let duWhilePaused = 0;
    let duWhileFiveParallel = 0;

    {
      await using server = await startFixtureServer();
      await using capWorkspace = recordingWorkspace("retention-cap");
      capWorkspace.seed("a".repeat(32), SMALL_CAP_SETTINGS);
      {
        await using session = await capWorkspace.launch(base);
        await waitForActiveExtensionUrl(session, addonId, popupPath);
        const tab = await session.openTab(
          `http://s01.localhost:${String(server.port)}/retention/page`,
        );
        const root = capWorkspace.root();
        const incomingDir = NodePath.join(root, LAYOUT.incomingDir);
        const stopSampler = startRootSampler(root, duSamples);
        try {
          for (let i = 1; i <= SITE_COUNT; i += 1) {
            const site = `s${String(i).padStart(2, "0")}.localhost`;
            await fetchMixedSite(session, tab, server.port, site);
            duSamples.push(duBytes(root));
          }
          await callHook(session, { kind: "flush" });
          problems.push(
            ...checkArchiveOnDisk({
              root,
              step: "after-20-mixed-sites",
              usage: (await readStatus(session)).usage,
              expectZeroParts: true,
              maxBodyBytes: CAP_BYTES,
            }).problems,
          );

          await session.navigateTab(tab, `${server.origin}/id/download.html`);
          await session.evaluate(
            tab,
            `window.__parts = Promise.all([
              fetch("/fixtures/binary?pauseAfterBytes=${String(PAUSE_AT_BYTES)}&n=1").then((r) => r.arrayBuffer()),
              fetch("/fixtures/binary?pauseAfterBytes=${String(PAUSE_AT_BYTES)}&n=2").then((r) => r.arrayBuffer()),
            ]).then((arr) => arr.map((b) => b.byteLength)); "started"`,
          );
          await waitPartsSettled(incomingDir, 2);
          duWhilePaused = duBytes(root);
          duSamples.push(duWhilePaused);
          problems.push(
            ...checkArchiveOnDisk({
              root,
              step: "paused-2-parts",
              usage: (await readStatus(session)).usage,
            }).problems,
          );
          server.releasePaused();
          const received = JSON.parse(
            await session.evaluate(tab, "window.__parts.then(JSON.stringify)"),
          ) as number[];
          if (
            received.length !== 2 ||
            received[0] !== BINARY_BYTE_LENGTH ||
            received[1] !== BINARY_BYTE_LENGTH
          ) {
            problems.push(`page received ${JSON.stringify(received)} while capped`);
          }
          await callHook(session, { kind: "flush" });
          await callHook(session, { kind: "seal" });
        } finally {
          stopSampler();
        }
        const finalArchive = checkArchiveOnDisk({
          root,
          step: "cap-after-seal",
          usage: (await readStatus(session)).usage,
          expectZeroParts: true,
          maxBodyBytes: CAP_BYTES,
          requireAllSummarized: true,
        });
        problems.push(...finalArchive.problems);
        usageBodyBytesAfterFlush = (await readStatus(session)).usage.bodyBytes;
        diskBodyBytesAfterFlush = finalArchive.disk.bodyBytes;
        detailBytesAfterFlush = finalArchive.disk.detailBytes;
        duAfterFlush = duBytes(root);
      }
      totalServedBytes = [...server.getAllSequenceTruth().values()].reduce(
        (sum, t) => sum + t.wireBytesSent,
        0,
      );
      const root = capWorkspace.root();
      const verdicts = checkStoredBodies(capWorkspace.lines(), expectedFromServer(server), (at) =>
        readStoredBytes(root, at),
      );
      const wrong = verdicts.filter((v) => v.verdict === "wrong");
      const exact = verdicts.filter((v) => v.verdict === "exact");
      const overSingleCap = capWorkspace
        .lines()
        .filter(
          (l) =>
            l.exchange.kind === "answered" &&
            l.exchange.body.kind === "stored" &&
            l.exchange.body.at.kind === "file" &&
            l.exchange.body.at.length > SMALL_CAP_BYTES + FLUSH_BATCH_BYTES,
        );
      if (overSingleCap.length > 0) {
        problems.push(
          `${String(overSingleCap.length)} file bodies exceeded ${String(SMALL_CAP_BYTES + FLUSH_BATCH_BYTES)} B`,
        );
      }
      if (wrong.length > 0) {
        problems.push(`surviving bodies had wrong SHA-256: ${wrong.map((w) => w.url).join(", ")}`);
      }
      if (exact.length === 0) problems.push("no surviving exact bodies to check");
    }

    {
      await using server = await startFixtureServer();
      await using parallelWorkspace = recordingWorkspace("retention-5-parallel");
      parallelWorkspace.seed("e".repeat(32), SMALL_CAP_SETTINGS);
      await using session = await parallelWorkspace.launch(base);
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const tab = await session.openTab(
        `http://s01.localhost:${String(server.port)}/retention/page`,
      );
      for (let i = 1; i <= 4; i += 1) {
        await fetchSmallBlobs(session, tab, server.port, `s0${String(i)}.localhost`, 6);
      }
      await callHook(session, { kind: "flush" });
      const root = parallelWorkspace.root();
      const incomingDir = NodePath.join(root, LAYOUT.incomingDir);
      const stopSampler = startRootSampler(root, duSamples);
      try {
        await session.navigateTab(tab, `${server.origin}/id/download.html`);
        const pausedUrls = Array.from(
          { length: PARALLEL_DOWNLOADS },
          (_, i) =>
            `/fixtures/binary?pauseAfterBytes=${String(PARALLEL_PAUSE_AT_BYTES)}&n=p${String(i)}`,
        );
        await session.evaluate(
          tab,
          `window.__p5 = Promise.all(${JSON.stringify(pausedUrls)}.map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => b.byteLength))).then(JSON.stringify); "started"`,
        );
        await waitPartsSettled(incomingDir, PARALLEL_DOWNLOADS);
        duWhileFiveParallel = duBytes(root);
        duSamples.push(duWhileFiveParallel);
        problems.push(
          ...checkArchiveOnDisk({
            root,
            step: "parallel-5-held",
            usage: (await readStatus(session)).usage,
          }).problems,
        );
        server.releasePaused();
        const gotPaused = JSON.parse(await session.evaluate(tab, "window.__p5")) as number[];
        if (
          gotPaused.length !== PARALLEL_DOWNLOADS ||
          gotPaused.some((len) => len !== BINARY_BYTE_LENGTH)
        ) {
          problems.push(`5 parallel downloads received ${JSON.stringify(gotPaused)}`);
        }
        await callHook(session, { kind: "flush" });
        await callHook(session, { kind: "seal" });
      } finally {
        stopSampler();
      }
      problems.push(
        ...checkArchiveOnDisk({
          root,
          step: "parallel-5-sealed",
          usage: (await readStatus(session)).usage,
          expectZeroParts: true,
          maxBodyBytes: CAP_BYTES,
          requireAllSummarized: true,
        }).problems,
      );
    }

    let pinCheck:
      | {
          readonly oldestPackIsActuallyOldest: boolean;
          readonly oldestPackExistsBeforeUnpin: boolean;
          readonly newestPackExistsBeforeUnpin: boolean;
          readonly problemsBeforeUnpin: readonly string[];
          readonly oldestPackExistsAfterUnpin: boolean;
          readonly problemsAfterUnpin: readonly string[];
          readonly duAfterUnpin: number;
          readonly usageBodyBytesAfterUnpin: number;
          readonly diskBodyBytesAfterUnpin: number;
          readonly detailBytesAfterUnpin: number;
        }
      | undefined;

    {
      await using server = await startFixtureServer();
      await using pinWorkspace = recordingWorkspace("retention-pin");
      pinWorkspace.seed("b".repeat(32), SMALL_CAP_SETTINGS);
      await using session = await pinWorkspace.launch(base);
      const popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
      const popupTab = await session.openTab(popupUrl);
      const tab = await session.openTab(
        `http://s01.localhost:${String(server.port)}/retention/page`,
      );
      for (let i = 1; i <= 4; i += 1) {
        await fetchSmallBlobs(session, tab, server.port, `s0${String(i)}.localhost`, 6);
        await callHook(session, { kind: "flush" });
      }
      const pinRoot = pinWorkspace.root();
      problems.push(
        ...checkArchiveOnDisk({
          root: pinRoot,
          step: "pin-before-pin",
          usage: (await readStatus(session)).usage,
          expectZeroParts: true,
        }).problems,
      );

      const pinned = (await callHook(session, { kind: "pin-oldest-pack" })) as {
        readonly pinId: string;
        readonly pack: PackId;
      } | null;
      if (pinned === null) {
        problems.push("pin-oldest-pack returned null");
      } else {
        const expectedOldestPrefix = `${siteDirName("s01.localhost" as Site)}/`;
        const oldestPackIsActuallyOldest = String(pinned.pack).startsWith(expectedOldestPrefix);
        const oldestPackPath = NodePath.join(pinRoot, ...packPath(pinned.pack));
        const oldestPackSha = sha256File(oldestPackPath);
        if (oldestPackSha === null) {
          problems.push(`pinned oldest pack missing at pin start: ${oldestPackPath}`);
        }
        const pinnedSpecs = [
          {
            label: String(pinned.pack),
            path: oldestPackPath,
            ...(oldestPackSha === null ? {} : { expectedSha256: oldestPackSha }),
          },
        ];
        const pinDuSamples: number[] = [];
        const stopPinSampler = startRootSampler(pinRoot, pinDuSamples);
        let statusAfterPinnedSmall: StatusSnapshot;
        try {
          for (let i = 5; i <= PIN_SITES; i += 1) {
            const site = `s${String(i).padStart(2, "0")}.localhost`;
            await fetchSmallBlobs(session, tab, server.port, site, 6);
          }
          await callHook(session, { kind: "flush" });
          statusAfterPinnedSmall = await readStatus(session);

          await session.navigateTab(tab, `${server.origin}/id/download.html`);
          await session.evaluate(
            tab,
            `Promise.all([
              fetch("/retention/blob?bytes=${String(LARGE_BLOB_BYTES)}&tag=pinned-tee-2m").then((r) => r.arrayBuffer()),
              fetch("/fixtures/binary?n=pinned-tee-1").then((r) => r.arrayBuffer()),
              fetch("/fixtures/binary?n=pinned-tee-2").then((r) => r.arrayBuffer()),
              fetch("/fixtures/binary?n=pinned-tee-3").then((r) => r.arrayBuffer()),
              fetch("/fixtures/binary?n=pinned-tee-4").then((r) => r.arrayBuffer()),
            ]).then(() => "done")`,
          );
          await callHook(session, { kind: "flush" });
        } finally {
          stopPinSampler();
        }

        const statusBeforeUnpin = await readStatus(session);
        const maxDuWhilePinned = Math.max(0, ...pinDuSamples);
        const pinnedBodyBound = statusAfterPinnedSmall.usage.bodyBytes + FLUSH_BATCH_BYTES;
        if (statusBeforeUnpin.usage.bodyBytes > pinnedBodyBound) {
          problems.push(
            `pinned tees grew bodyBytes from ${String(statusAfterPinnedSmall.usage.bodyBytes)} B to ${String(statusBeforeUnpin.usage.bodyBytes)} B (limit ${String(pinnedBodyBound)} B)`,
          );
        }
        const pinnedDuBound = pinnedBodyBound + statusBeforeUnpin.usage.detailBytes + 16_384;
        if (maxDuWhilePinned > pinnedDuBound) {
          problems.push(
            `pinned du reached ${String(maxDuWhilePinned)} B > bound ${String(pinnedDuBound)} B`,
          );
        }
        const pinnedArchive = checkArchiveOnDisk({
          root: pinRoot,
          step: "while-pinned-after-file-tees",
          usage: statusBeforeUnpin.usage,
          pinned: pinnedSpecs,
          expectZeroParts: true,
        });
        problems.push(...pinnedArchive.problems);

        const newestSiteDir = siteDirName(
          `s${String(PIN_SITES).padStart(2, "0")}.localhost` as Site,
        );
        const newestPackDir = NodePath.join(pinRoot, "sites", newestSiteDir, "packs");
        const newestPacks = NodeFS.existsSync(newestPackDir)
          ? NodeFS.readdirSync(newestPackDir).filter((n) => n.endsWith(".pack"))
          : [];
        const newestPackExistsBeforeUnpin = newestPacks.length > 0;
        const oldestPackExistsBeforeUnpin = NodeFS.existsSync(oldestPackPath);
        const problemsBeforeUnpin = await statusProblems(session, popupTab);

        await callHook(session, { kind: "unpin", pinId: pinned.pinId });
        await callHook(session, { kind: "flush" });
        const oldestPackExistsAfterUnpin = NodeFS.existsSync(oldestPackPath);
        const problemsAfterUnpin = await statusProblems(session, popupTab);

        // Reset guard re-entry count so post-unpin 50 MB download asserts immediate chunk close at budget.
        await callHook(session, { kind: "reset-work" });
        await session.evaluate(
          tab,
          `fetch("/fixtures/binary?n=after-unpin").then((r) => r.arrayBuffer()).then((b) => String(b.byteLength))`,
        );
        await callHook(session, { kind: "flush" });
        const afterUnpinBinaryStatus = await readStatus(session);
        if ((afterUnpinBinaryStatus.overBudgetReentries ?? 0) > 0) {
          problems.push(
            `after-unpin file-tee re-entered guard at budget ${String(afterUnpinBinaryStatus.overBudgetReentries)} times`,
          );
        }
        await session.evaluate(
          tab,
          `fetch("/retention/blob?bytes=4000000&tag=after-unpin-exact").then((r) => r.arrayBuffer()).then((b) => String(b.byteLength))`,
        );
        await callHook(session, { kind: "seal" });

        const unpinStatus = await readStatus(session);
        const unpinArchive = checkArchiveOnDisk({
          root: pinRoot,
          step: "after-unpin-seal",
          usage: unpinStatus.usage,
          expectZeroParts: true,
          maxBodyBytes: CAP_BYTES,
          requireAllSummarized: true,
        });
        problems.push(...unpinArchive.problems);

        const pinLines = pinWorkspace.lines();
        const postUnpinBinary = pinLines.find(
          (l) =>
            l.exchange.kind === "answered" &&
            l.exchange.request.url.endsWith("/fixtures/binary?n=after-unpin"),
        );
        if (
          postUnpinBinary === undefined ||
          postUnpinBinary.exchange.kind !== "answered" ||
          postUnpinBinary.exchange.body.kind !== "stored" ||
          postUnpinBinary.exchange.body.check !== "first-part" ||
          postUnpinBinary.exchange.body.at.kind !== "file" ||
          postUnpinBinary.exchange.body.at.length < SMALL_CAP_BYTES ||
          postUnpinBinary.exchange.body.at.length > SMALL_CAP_BYTES + FLUSH_BATCH_BYTES
        ) {
          problems.push(
            `post-unpin 50 MB download stored as ${JSON.stringify(postUnpinBinary?.exchange.kind === "answered" ? postUnpinBinary.exchange.body : null)}, expected first-part file in [${String(SMALL_CAP_BYTES)}, ${String(SMALL_CAP_BYTES + FLUSH_BATCH_BYTES)}] B`,
          );
        } else {
          const binaryFixture = listFixtures().find((f) => f.id === "binary");
          const storedPrefix = readStoredBytes(pinRoot, postUnpinBinary.exchange.body.at);
          const expectedLen = postUnpinBinary.exchange.body.at.length;
          if (binaryFixture === undefined || storedPrefix === null) {
            problems.push("post-unpin 50 MB stored prefix unreadable");
          } else {
            const expectedPrefix = buildBody(binaryFixture).subarray(0, expectedLen);
            const expectedSha = NodeCrypto.createHash("sha256")
              .update(expectedPrefix)
              .digest("hex");
            const actualSha = NodeCrypto.createHash("sha256").update(storedPrefix).digest("hex");
            if (storedPrefix.length !== expectedLen || actualSha !== expectedSha) {
              problems.push(
                `post-unpin 50 MB prefix mismatch (${String(storedPrefix.length)} B != ${String(expectedLen)} B, sha ${actualSha} != ${expectedSha})`,
              );
            }
          }
        }

        const postUnpinExact = pinLines.filter(
          (l) =>
            l.exchange.kind === "answered" &&
            l.exchange.request.url.endsWith("/retention/blob?bytes=4000000&tag=after-unpin-exact"),
        );
        const exactVerdicts = checkStoredBodies(postUnpinExact, expectedFromServer(server), (at) =>
          readStoredBytes(pinRoot, at),
        );
        const exactStored = postUnpinExact[0]?.exchange;
        if (
          exactStored?.kind !== "answered" ||
          exactStored.body.kind !== "stored" ||
          exactStored.body.at.length !== 4_000_000 ||
          exactVerdicts.length !== 1 ||
          exactVerdicts[0]?.verdict !== "exact"
        ) {
          problems.push(`post-unpin 4 MB blob verdict: ${JSON.stringify(exactVerdicts)}`);
        }

        const duAfterUnpin = duBytes(pinRoot);
        pinCheck = {
          oldestPackIsActuallyOldest,
          oldestPackExistsBeforeUnpin,
          newestPackExistsBeforeUnpin,
          problemsBeforeUnpin,
          oldestPackExistsAfterUnpin,
          problemsAfterUnpin,
          duAfterUnpin,
          usageBodyBytesAfterUnpin: unpinStatus.usage.bodyBytes,
          diskBodyBytesAfterUnpin: unpinArchive.disk.bodyBytes,
          detailBytesAfterUnpin: unpinArchive.disk.detailBytes,
        };
      }
    }

    problems.push(
      ...checkRetentionRun({
        capBytes: CAP_BYTES,
        flushBatchBytes: FLUSH_BATCH_BYTES,
        totalServedBytes,
        duSamples,
        duAfterFlush,
        usageBodyBytesAfterFlush,
        diskBodyBytesAfterFlush,
        detailBytesAfterFlush,
        ...(pinCheck === undefined ? {} : { pinCheck }),
      }),
    );

    const maxSample = Math.max(0, ...duSamples);
    return {
      name: "retention-cap",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `20 mixed + 2 paused (${String(duWhilePaused)} B) + 5 parallel 50 MB (${String(duWhileFiveParallel)} B) stayed <= cap+batch (max ${String(maxSample)} B); pinned file tees kept oldest pack until unpinned (${String(pinCheck?.duAfterUnpin ?? 0)} B)`
          : problems.join("; "),
      data: {
        totalServedBytes,
        capBytes: CAP_BYTES,
        maxSample,
        duWhilePaused,
        duWhileFiveParallel,
        duAfterFlush,
        usageBodyBytesAfterFlush,
        diskBodyBytesAfterFlush,
        duSamples,
        pinCheck,
      },
    };
  },
};

/** @discovered-check */
export default check;
