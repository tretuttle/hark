import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { RunId, Site } from "@hark/recording/ids";
import { FLUSH_BATCH_BYTES, LAYOUT, packId, packPath, siteDirName } from "@hark/recording/layout";
import { readStoredBytes } from "../src/archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { BINARY_BYTE_LENGTH, buildBody, listFixtures } from "../src/fixtures.ts";
import { checkArchiveOnDisk, checkStoredBodies } from "../src/recording-verify.ts";
import { callHook, recordingWorkspace, SMALL_CAP_SETTINGS } from "../src/recording-session.ts";
import { expectedFromServer } from "../src/recording-truth.ts";
import { deterministicBytes, startFixtureServer, type FixtureServer } from "../src/server.ts";

const MIB = 1_048_576;
const DU_SAMPLE_MS = 200;
const DAY_MS = 86_400_000;
const SITE_COUNT = 20;

type LedgerSeed =
  | "missing"
  | "stale-unclean"
  | "understated-stale"
  | "overstated"
  | "corrupt"
  | "forged-half"
  | "crash-skew"
  | "clean-restart";

interface StartupArm {
  readonly name: string;
  readonly bodyCap: number;
  readonly detailCap: number;
  readonly packCount: number;
  readonly headroomBytes: number;
  readonly unreadable?: boolean;
  readonly fetchLargeBinary?: boolean;
  readonly ledger?: LedgerSeed;
  readonly scanDelayMs?: number;
  readonly testSuspend?: boolean;
  readonly burstBytes?: number;
  readonly expectZeroDirectWhileShut?: boolean;
  readonly expectUntrustedStartup?: boolean;
  readonly expectDowngradedStartup?: boolean;
  readonly waitBeforeWavesMs?: number;
  readonly expectScanTimeout?: boolean;
}

const FIVE_GIB = 5 * 1024 * MIB;
const DETAIL_CAP = 1024 * MIB;

const ARMS: readonly StartupArm[] = [
  {
    name: "5gib-9900-packs",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 9_900,
    headroomBytes: MIB,
    scanDelayMs: 2_000,
  },
  {
    name: "64mib-100-packs",
    bodyCap: SMALL_CAP_SETTINGS.user.retention.maxBodyBytes,
    detailCap: SMALL_CAP_SETTINGS.user.retention.maxDetailBytes,
    packCount: 100,
    headroomBytes: 512 * 1024,
  },
  {
    name: "64mib-suspend",
    bodyCap: SMALL_CAP_SETTINGS.user.retention.maxBodyBytes,
    detailCap: SMALL_CAP_SETTINGS.user.retention.maxDetailBytes,
    packCount: 100,
    headroomBytes: 512 * 1024,
    scanDelayMs: 8_000,
    testSuspend: true,
  },
  {
    name: "64mib-overcap",
    bodyCap: SMALL_CAP_SETTINGS.user.retention.maxBodyBytes,
    detailCap: SMALL_CAP_SETTINGS.user.retention.maxDetailBytes,
    packCount: 120,
    headroomBytes: -12 * MIB,
  },
  {
    name: "64mib-unreadable",
    bodyCap: SMALL_CAP_SETTINGS.user.retention.maxBodyBytes,
    detailCap: SMALL_CAP_SETTINGS.user.retention.maxDetailBytes,
    packCount: 10,
    headroomBytes: 54 * MIB,
    unreadable: true,
    fetchLargeBinary: true,
  },
  {
    name: "64mib-clean-restart",
    bodyCap: SMALL_CAP_SETTINGS.user.retention.maxBodyBytes,
    detailCap: SMALL_CAP_SETTINGS.user.retention.maxDetailBytes,
    packCount: 100,
    headroomBytes: 512 * 1024,
    ledger: "clean-restart",
  },
  {
    name: "150k-stale",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "stale-unclean",
    scanDelayMs: 10_000,
    burstBytes: 3_000_000,
    expectZeroDirectWhileShut: true,
    expectUntrustedStartup: true,
  },
  {
    name: "150k-understated",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "understated-stale",
    scanDelayMs: 2_000,
    burstBytes: 3_000_000,
    expectUntrustedStartup: true,
  },
  {
    name: "150k-overstated",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "overstated",
    scanDelayMs: 2_000,
    burstBytes: 3_000_000,
  },
  {
    name: "150k-missing",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "missing",
    scanDelayMs: 2_000,
    burstBytes: 3_000_000,
    expectUntrustedStartup: true,
  },
  {
    name: "150k-corrupt",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "corrupt",
    scanDelayMs: 2_000,
    burstBytes: 3_000_000,
    expectUntrustedStartup: true,
  },
  {
    name: "150k-crashskew",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "crash-skew",
    scanDelayMs: 10_000,
    burstBytes: 3_000_000,
    expectZeroDirectWhileShut: true,
    expectUntrustedStartup: true,
  },
  {
    name: "150k-forged",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "forged-half",
    scanDelayMs: 14_000,
    waitBeforeWavesMs: 8_000,
    burstBytes: 3_000_000,
    expectZeroDirectWhileShut: true,
    expectDowngradedStartup: true,
  },
  {
    name: "150k-scan-timeout",
    bodyCap: FIVE_GIB,
    detailCap: DETAIL_CAP,
    packCount: 150_000,
    headroomBytes: MIB,
    ledger: "missing",
    scanDelayMs: 32_000,
    testSuspend: true,
    expectScanTimeout: true,
  },
];

const dirBytes = (directory: string): number => {
  if (!NodeFS.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const child = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) total += dirBytes(child);
    else if (entry.isFile()) total += NodeFS.statSync(child).size;
  }
  return total;
};

const rewindArchiveDirMtimes = (root: string, sec: number): void => {
  const sitesDir = NodePath.join(root, LAYOUT.sitesDir);
  if (!NodeFS.existsSync(sitesDir)) return;
  for (const entry of NodeFS.readdirSync(sitesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sitePath = NodePath.join(sitesDir, entry.name);
    for (const sub of [LAYOUT.packDir, LAYOUT.bodyDir, LAYOUT.logDir]) {
      const subPath = NodePath.join(sitePath, sub);
      if (NodeFS.existsSync(subPath)) NodeFS.utimesSync(subPath, sec, sec);
    }
    NodeFS.utimesSync(sitePath, sec, sec);
  }
  NodeFS.utimesSync(sitesDir, sec, sec);
};

const duBytesAsync = (directory: string): Promise<number | null> => {
  if (!NodeFS.existsSync(directory)) return Promise.resolve(0);
  return new Promise((resolve) => {
    NodeChildProcess.execFile("du", ["-sb", directory], { encoding: "utf8" }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const bytes = Number(stdout.trim().split(/\s+/u)[0]);
      resolve(Number.isFinite(bytes) ? bytes : null);
    });
  });
};

const startRootSampler = (root: string, samples: number[]): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  const sampleOnce = (): Promise<void> => {
    const next = duBytesAsync(root)
      .then((value) => {
        if (value !== null) samples.push(value);
      })
      .finally(() => {
        if (inFlight === next) inFlight = null;
      });
    inFlight = next;
    return next;
  };
  const timer = setInterval(() => {
    if (inFlight === null) void sampleOnce();
  }, DU_SAMPLE_MS);
  return async () => {
    clearInterval(timer);
    if (inFlight !== null) await inFlight;
    await sampleOnce();
  };
};

const seedPackSlice = (
  root: string,
  runBase: RunId,
  from: number,
  count: number,
  packBytes: number,
  baseSec: number,
): number => {
  for (let i = from; i < from + count; i += 1) {
    const siteHost = `st${String(i % SITE_COUNT)}.localhost` as Site;
    const file = NodePath.join(root, ...packPath(packId(siteHost, runBase, i)));
    const fd = NodeFS.openSync(file, "w", 0o600);
    const mtime = baseSec + i * 0.01;
    try {
      NodeFS.ftruncateSync(fd, packBytes);
      NodeFS.futimesSync(fd, mtime, mtime);
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  return count * packBytes;
};

const seedPacksNearCap = (
  root: string,
  arm: StartupArm,
): { readonly seededBytes: number; readonly runBase: RunId; readonly packBytes: number } => {
  const packBytes = Math.floor((arm.bodyCap - arm.headroomBytes) / arm.packCount);
  const runBase = Math.floor(Date.now() - 3 * DAY_MS).toString(36) as RunId;
  for (let site = 0; site < SITE_COUNT; site += 1) {
    const siteHost = `st${String(site)}.localhost` as Site;
    const siteDir = NodePath.join(root, LAYOUT.sitesDir, siteDirName(siteHost));
    NodeFS.mkdirSync(NodePath.join(siteDir, LAYOUT.packDir), { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(siteDir, LAYOUT.logDir), { recursive: true, mode: 0o700 });
  }
  const baseSec = (Date.now() - 3 * DAY_MS) / 1_000;
  const ledgerFile = NodePath.join(root, LAYOUT.ledger);
  if (arm.ledger === "understated-stale") {
    const firstHalf = Math.floor(arm.packCount / 2);
    const halfBytes = seedPackSlice(root, runBase, 0, firstHalf, packBytes, baseSec);
    NodeFS.writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        run: "prev-clean-run",
        clean: true,
        bodyBytes: halfBytes,
        detailBytes: 0,
        bodyCount: firstHalf,
        detailCount: 0,
        siteCount: SITE_COUNT,
      }),
      { mode: 0o600 },
    );
    const olderSec = Date.now() / 1_000 - 60;
    NodeFS.utimesSync(ledgerFile, olderSec, olderSec);
    const restBytes = seedPackSlice(
      root,
      runBase,
      firstHalf,
      arm.packCount - firstHalf,
      packBytes,
      baseSec,
    );
    return { seededBytes: halfBytes + restBytes, runBase, packBytes };
  }
  if (arm.ledger === "crash-skew") {
    const firstHalf = Math.floor(arm.packCount / 2);
    const halfBytes = seedPackSlice(root, runBase, 0, firstHalf, packBytes, baseSec);
    NodeFS.writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        run: "crash-skew-run",
        clean: true,
        bodyBytes: halfBytes,
        detailBytes: 0,
        bodyCount: firstHalf,
        detailCount: 0,
        siteCount: SITE_COUNT,
      }),
      { mode: 0o600 },
    );
    rewindArchiveDirMtimes(root, Date.now() / 1_000 - 120);
    return { seededBytes: halfBytes, runBase, packBytes };
  }
  const totalBytes = seedPackSlice(root, runBase, 0, arm.packCount, packBytes, baseSec);
  if (arm.ledger === "stale-unclean") {
    NodeFS.writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        run: "crashed-prev-run",
        clean: false,
        bodyBytes: Math.floor(arm.bodyCap / 2),
        detailBytes: 0,
        bodyCount: Math.floor(arm.packCount / 2),
        detailCount: 0,
        siteCount: SITE_COUNT,
      }),
      { mode: 0o600 },
    );
  } else if (arm.ledger === "forged-half") {
    NodeFS.writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        run: "forged-half-run",
        clean: true,
        bodyBytes: Math.floor(arm.bodyCap / 2),
        detailBytes: 0,
        bodyCount: arm.packCount,
        detailCount: 0,
        siteCount: SITE_COUNT,
      }),
      { mode: 0o600 },
    );
  } else if (arm.ledger === "overstated") {
    NodeFS.writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        run: "overstated-run",
        clean: true,
        bodyBytes: arm.bodyCap * 2,
        detailBytes: 0,
        bodyCount: arm.packCount,
        detailCount: 0,
        siteCount: SITE_COUNT,
      }),
      { mode: 0o600 },
    );
  } else if (arm.ledger === "corrupt") {
    NodeFS.writeFileSync(ledgerFile, "{truncated-corrupt-ledger", { mode: 0o600 });
  }
  return { seededBytes: totalBytes, runBase, packBytes };
};

const verifyStartupBodies = (
  arm: StartupArm,
  root: string,
  server: FixtureServer,
  lines: ReturnType<ReturnType<typeof recordingWorkspace>["lines"]>,
  problems: string[],
): {
  readonly exactCount: number;
  readonly cutCount: number;
  readonly timeoutStored: number;
  readonly timeoutIncomplete: number;
  readonly falseFirstPart: number;
  readonly zeroLengthStored: number;
} => {
  const blobLines = lines.filter(
    (l) =>
      l.exchange.kind === "answered" &&
      new URL(l.exchange.request.url).pathname === "/retention/blob" &&
      (new URL(l.exchange.request.url).searchParams.get("tag") ?? "").startsWith(`${arm.name}-`),
  );
  if (blobLines.length < 32) {
    problems.push(`${arm.name}: expected >= 32 recorded blobs, got ${String(blobLines.length)}`);
  }
  const zeroLengthBlobs = blobLines.filter(
    (l) =>
      l.exchange.kind === "answered" &&
      l.exchange.body.kind === "stored" &&
      l.exchange.body.at.length === 0,
  );
  if (zeroLengthBlobs.length > 0) {
    problems.push(`${arm.name}: ${String(zeroLengthBlobs.length)} 0-byte cut blobs during startup`);
  }
  const falseFirstPart = blobLines.filter(
    (l) =>
      l.exchange.kind === "answered" &&
      l.exchange.body.kind === "stored" &&
      l.exchange.body.check === "first-part",
  );
  if (falseFirstPart.length > 0) {
    problems.push(
      `${arm.name}: ${String(falseFirstPart.length)} blobs below route cap labeled first-part`,
    );
  }

  const fullBlobLines = blobLines.filter(
    (l) =>
      !(
        l.exchange.kind === "answered" &&
        l.exchange.body.kind === "stored" &&
        l.exchange.body.check === "scan-timeout"
      ),
  );
  const verdicts = checkStoredBodies(fullBlobLines, expectedFromServer(server), (at) =>
    readStoredBytes(root, at),
  );
  const badBlobs = verdicts.filter((v) => v.verdict !== "exact");
  if (badBlobs.length > 0) {
    problems.push(
      `${arm.name}: non-exact blob bodies (${String(badBlobs.length)}): ${badBlobs
        .slice(0, 3)
        .map((b) => `${b.verdict}:${b.detail}`)
        .join(", ")}`,
    );
  }

  const timeoutStored = blobLines.filter(
    (l) =>
      l.exchange.kind === "answered" &&
      l.exchange.body.kind === "stored" &&
      l.exchange.body.check === "scan-timeout",
  );
  const timeoutIncomplete = blobLines.filter(
    (l) =>
      l.exchange.kind === "answered" &&
      l.exchange.body.kind === "incomplete" &&
      l.exchange.body.reason === "scan-timeout",
  );
  if (arm.expectScanTimeout === true) {
    if (timeoutStored.length + timeoutIncomplete.length === 0) {
      problems.push(`${arm.name}: expected scan-timeout outcomes during 32s stalled scan, got 0`);
    }
    for (const line of timeoutStored) {
      if (line.exchange.kind !== "answered" || line.exchange.body.kind !== "stored") continue;
      const reqUrl = new URL(line.exchange.request.url);
      const rawBytes = Number(reqUrl.searchParams.get("bytes") ?? "0");
      const tag = reqUrl.searchParams.get("tag") ?? "default";
      const stored = readStoredBytes(root, line.exchange.body.at);
      if (stored === null || stored.length === 0 || stored.length > rawBytes) {
        problems.push(
          `${arm.name}: scan-timeout stored ${String(stored?.length ?? -1)} B out of (0, ${String(rawBytes)}]`,
        );
        continue;
      }
      const expectedPrefix = deterministicBytes(rawBytes, `${String(rawBytes)}:${tag}`).subarray(
        0,
        stored.length,
      );
      const actualSha = NodeCrypto.createHash("sha256").update(stored).digest("hex");
      const expectedSha = NodeCrypto.createHash("sha256").update(expectedPrefix).digest("hex");
      if (actualSha !== expectedSha) {
        let diffAt = -1;
        for (let i = 0; i < stored.length; i += 1) {
          if (stored[i] !== expectedPrefix[i]) {
            diffAt = i;
            break;
          }
        }
        problems.push(
          `${arm.name}: scan-timeout prefix SHA-256 mismatch on ${reqUrl.search} len=${String(stored.length)} atLen=${String(line.exchange.body.at.length)} diffAt=${String(diffAt)}`,
        );
      }
    }
    const exactSmall = fullBlobLines.filter(
      (l) => l.exchange.kind === "answered" && l.exchange.body.kind === "stored",
    );
    if (exactSmall.length === 0) {
      problems.push(
        `${arm.name}: expected post-timeout held bodies under buffer cap to save exact`,
      );
    }
  }

  let cutCount = 0;
  if (arm.fetchLargeBinary === true) {
    const routeCap = Math.floor(arm.bodyCap / 4);
    const binaryLines = lines.filter(
      (l) =>
        l.exchange.kind === "answered" &&
        new URL(l.exchange.request.url).pathname === "/fixtures/binary",
    );
    const binaryLine = binaryLines[0]?.exchange;
    if (
      binaryLine?.kind !== "answered" ||
      binaryLine.body.kind !== "stored" ||
      binaryLine.body.check !== "first-part" ||
      binaryLine.body.at.length < routeCap ||
      binaryLine.body.at.length > routeCap + FLUSH_BATCH_BYTES
    ) {
      problems.push(
        `${arm.name}: /fixtures/binary stored as ${JSON.stringify(binaryLine?.kind === "answered" ? binaryLine.body : null)}, expected first-part in [${String(routeCap)}, ${String(routeCap + FLUSH_BATCH_BYTES)}] B`,
      );
    } else {
      cutCount += 1;
      const fixture = listFixtures().find((f) => f.id === "binary");
      const stored = readStoredBytes(root, binaryLine.body.at);
      if (fixture === undefined || stored === null) {
        problems.push(`${arm.name}: /fixtures/binary bytes missing`);
      } else {
        const expectedPrefix = buildBody(fixture).subarray(0, binaryLine.body.at.length);
        const expectedSha = NodeCrypto.createHash("sha256").update(expectedPrefix).digest("hex");
        const actualSha = NodeCrypto.createHash("sha256").update(stored).digest("hex");
        if (stored.length !== expectedPrefix.length || actualSha !== expectedSha) {
          problems.push(`${arm.name}: /fixtures/binary prefix SHA-256 mismatch`);
        }
      }
    }
  }
  return {
    exactCount: verdicts.filter((v) => v.verdict === "exact").length,
    cutCount,
    timeoutStored: timeoutStored.length,
    timeoutIncomplete: timeoutIncomplete.length,
    falseFirstPart: falseFirstPart.length,
    zeroLengthStored: zeroLengthBlobs.length,
  };
};

type RestartSeed = {
  readonly ws: ReturnType<typeof recordingWorkspace>;
  readonly expectedRestartUsage: {
    readonly run: string;
    readonly bodyBytes: number;
    readonly detailBytes: number;
  };
};

type ArmOutcome = {
  readonly summary: string;
  readonly data: unknown;
  readonly restartSeed: RestartSeed | null;
};

async function runStartupArm(options: {
  readonly arm: StartupArm;
  readonly context: CheckContext;
  readonly extensionPath: string;
  readonly addonId: string;
  readonly popupPath: string;
  readonly server: FixtureServer;
  readonly problems: string[];
  readonly reused?: RestartSeed;
  readonly keepWorkspaceForRestart?: boolean;
}): Promise<ArmOutcome> {
  const { arm, context, extensionPath, addonId, popupPath, server, problems, reused } = options;
  const ws = reused?.ws ?? recordingWorkspace(`retention-startup-${arm.name}`);
  let keepWs = options.keepWorkspaceForRestart === true;
  try {
    if (reused === undefined) {
      ws.seed("d".repeat(32), {
        user: {
          version: 1,
          retention: {
            maxBodyBytes: arm.bodyCap,
            maxDetailBytes: arm.detailCap,
            maxAgeDays: 14,
          },
          excludedSites: [],
          media: "details-only",
          secretStorage: "store",
          exportDefaults: { bodies: "include", secrets: "remove" },
        },
        exportFolder: { kind: "downloads" },
      });
    }
    const root = ws.root();
    let seededBytes = reused?.expectedRestartUsage.bodyBytes ?? 0;
    const launchPrefs =
      arm.scanDelayMs !== undefined && arm.scanDelayMs > 0
        ? [{ name: "extensions.hark.harnessScanDelayMs", value: arm.scanDelayMs }]
        : [];
    if (reused === undefined) {
      const seeded = seedPacksNearCap(root, arm);
      seededBytes = seeded.seededBytes;
      if (arm.ledger === "crash-skew") {
        await using firstSession = await ws.launch({
          binaryPath: context.binaryPath,
          extensionPath,
          display: context.display,
          protocol: "marionette",
          signal: context.signal,
        });
        await waitForActiveExtensionUrl(firstSession, addonId, popupPath);
        await callHook(firstSession, { kind: "flush" });
        await firstSession.kill();
        const ledgerFile = NodePath.join(root, LAYOUT.ledger);
        const ledgerSec = NodeFS.statSync(ledgerFile).mtimeMs / 1_000;
        const firstHalf = Math.floor(arm.packCount / 2);
        const baseSec = (Date.now() - 3 * DAY_MS) / 1_000;
        seededBytes += seedPackSlice(
          root,
          seeded.runBase,
          firstHalf,
          arm.packCount - firstHalf,
          seeded.packBytes,
          baseSec,
        );
        rewindArchiveDirMtimes(root, Math.floor(ledgerSec) - 60);
      }
    } else {
      const persisted = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, LAYOUT.ledger), "utf8"),
      ) as Record<string, unknown>;
      if (
        persisted["clean"] !== true ||
        persisted["run"] !== reused.expectedRestartUsage.run ||
        persisted["bodyBytes"] !== reused.expectedRestartUsage.bodyBytes ||
        persisted["detailBytes"] !== reused.expectedRestartUsage.detailBytes
      ) {
        problems.push(
          `${arm.name}: clean-quit ledger ${JSON.stringify(persisted)} != expected ${JSON.stringify(reused.expectedRestartUsage)}`,
        );
      }
    }

    let deniedDir: string | null = null;
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (arm.unreadable === true) {
      const brokenSite = `st0.localhost` as Site;
      const deadLink = NodePath.join(
        root,
        LAYOUT.sitesDir,
        siteDirName(brokenSite),
        LAYOUT.packDir,
        "dead01-99.pack",
      );
      NodeFS.symlinkSync("/nonexistent/missing.pack", deadLink);
      deniedDir = NodePath.join(root, LAYOUT.sitesDir, "denied.localhost");
      NodeFS.mkdirSync(NodePath.join(deniedDir, LAYOUT.packDir), {
        recursive: true,
        mode: 0o700,
      });
      NodeFS.chmodSync(deniedDir, 0o000);
    }

    const duSamples: number[] = [(await duBytesAsync(root)) ?? seededBytes];
    const stopSampler = startRootSampler(root, duSamples);
    let restartSeed: RestartSeed | null = null;

    try {
      await using session = await ws.launch({
        binaryPath: context.binaryPath,
        extensionPath:
          arm.ledger === "clean-restart" || arm.ledger === "crash-skew" ? null : extensionPath,
        display: context.display,
        protocol: "marionette",
        signal: context.signal,
        extraPrefs: launchPrefs,
      });
      await waitForActiveExtensionUrl(session, addonId, popupPath);

      // Intentionally skip flush here so recording races loadFromDisk right after browser launch.
      const suspendTab =
        arm.testSuspend === true
          ? await session.openTab(`http://suspend.localhost:${String(server.port)}/retention/page`)
          : null;
      if (suspendTab !== null) {
        await session.evaluate(
          suspendTab,
          `window.__suspendDownloads = Promise.all([0, 1, 2, 3, 4].map((n) =>
              fetch("/retention/blob?bytes=4500000&tag=${arm.name}-sus-" + n).then((r) => r.arrayBuffer()).then((b) => b.byteLength),
            )); "started"`,
        );
      }
      const tab = await session.openTab(
        `http://burst0.localhost:${String(server.port)}/retention/page`,
      );
      if (arm.burstBytes !== undefined) {
        await session.evaluate(
          tab,
          `window.__earlyBurst = Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
              fetch("/retention/blob?bytes=${String(arm.burstBytes)}&tag=${arm.name}-early-" + i).then((r) => r.arrayBuffer()).then((b) => b.byteLength),
            )); "started"`,
        );
      }
      if (arm.waitBeforeWavesMs !== undefined && arm.waitBeforeWavesMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, arm.waitBeforeWavesMs);
        });
      }
      for (let wave = 0; wave < 4; wave += 1) {
        if (wave > 0) {
          await session.navigateTab(
            tab,
            `http://burst${String(wave)}.localhost:${String(server.port)}/retention/page`,
          );
        }
        const ok = await session.evaluate(
          tab,
          `Promise.all([
              ...[0, 1, 2, 3, 4, 5].map((i) =>
                fetch("/retention/blob?bytes=1200000&tag=${arm.name}-${String(wave)}-f-" + i).then((r) => r.arrayBuffer()),
              ),
              ...[0, 1].map((i) =>
                fetch("/retention/blob?bytes=850000&tag=${arm.name}-${String(wave)}-m-" + i).then((r) => r.arrayBuffer()),
              ),
              fetch("/retention/blob?bytes=30000&chunked=1&tag=${arm.name}-${String(wave)}-c").then((r) => r.arrayBuffer()),
            ]).then(() => "ok")`,
        );
        if (ok !== "ok") problems.push(`${arm.name} wave ${String(wave)} failed: ${String(ok)}`);
        if (wave === 0 && arm.expectZeroDirectWhileShut === true) {
          const incomingBytes = dirBytes(NodePath.join(root, LAYOUT.incomingDir));
          const midStatus = (await callHook(session, { kind: "status" })) as {
            readonly ready: boolean;
          };
          const maxAllowedMidBytes = arm.expectDowngradedStartup === true ? FLUSH_BATCH_BYTES : 0;
          if (midStatus.ready) {
            problems.push(`${arm.name}: gate opened before zero-direct probe after wave 0`);
          } else if (incomingBytes > maxAllowedMidBytes) {
            problems.push(
              `${arm.name}: wrote ${String(incomingBytes)} B directly to incoming/ while startup gate shut`,
            );
          }
        }
        if (wave === 0 && arm.burstBytes !== undefined) {
          const burstGot = (await session.evaluate(
            tab,
            `window.__earlyBurst.then(JSON.stringify)`,
          )) as string;
          const sizes = JSON.parse(burstGot) as readonly number[];
          if (sizes.length !== 8 || sizes.some((size) => size !== arm.burstBytes)) {
            problems.push(`${arm.name} early burst got ${burstGot}`);
          }
        }
      }

      if (arm.fetchLargeBinary === true) {
        const gotBytes = Number(
          await session.evaluate(
            tab,
            `fetch("/fixtures/binary?n=${arm.name}").then((r) => r.arrayBuffer()).then((b) => String(b.byteLength))`,
          ),
        );
        if (gotBytes !== BINARY_BYTE_LENGTH) {
          problems.push(`${arm.name} /fixtures/binary got ${String(gotBytes)} B`);
        }
      }

      if (suspendTab !== null) {
        const gotSizes = (await session.evaluate(
          suspendTab,
          `window.__suspendDownloads.then(JSON.stringify)`,
        )) as string;
        const parsedSizes = JSON.parse(gotSizes) as readonly number[];
        if (parsedSizes.length !== 5 || parsedSizes.some((size) => size !== 4_500_000)) {
          problems.push(`${arm.name} suspended downloads got ${gotSizes}`);
        }
        await session.closeTab(suspendTab);
      }
      await callHook(session, { kind: "flush" });
      await callHook(session, { kind: "seal" });
      await stopSampler();

      const status = (await callHook(session, { kind: "status" })) as {
        readonly run: string;
        readonly ready: boolean;
        readonly unreadableEntries: number;
        readonly startupSuspends: number;
        readonly startupBufferedPeak: number;
        readonly startupGate: {
          readonly gateStartedShut: boolean;
          readonly scanCompleted: boolean;
          readonly scanTimedOut: boolean;
          readonly initiallyTrusted: boolean;
          readonly downgraded: boolean;
          readonly preScanFileBytes: number;
          readonly preScanOpenParts: number;
          readonly postDowngradeFileBytes: number;
          readonly postDowngradeOpenParts: number;
        };
        readonly problems: readonly { readonly kind: string; readonly detail: string }[];
        readonly observerErrors: readonly string[];
        readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
      };
      if (arm.expectUntrustedStartup === true) {
        if (!status.startupGate.gateStartedShut) {
          problems.push(`${arm.name}: startup gate did not start shut`);
        }
        if (status.startupGate.initiallyTrusted) {
          problems.push(`${arm.name}: untrusted ledger was trusted on startup`);
        }
        if (status.startupGate.preScanOpenParts > 0 || status.startupGate.preScanFileBytes > 0) {
          problems.push(
            `${arm.name}: direct pre-scan file writes exceeded 0 (${String(status.startupGate.preScanFileBytes)} B, ${String(status.startupGate.preScanOpenParts)} parts)`,
          );
        }
      }
      if (arm.expectDowngradedStartup === true) {
        if (!status.startupGate.gateStartedShut || !status.startupGate.downgraded) {
          problems.push(
            `${arm.name}: expected understated ledger downgrade during scan (gateStartedShut=${String(status.startupGate.gateStartedShut)}, downgraded=${String(status.startupGate.downgraded)})`,
          );
        }
        if (status.startupGate.preScanFileBytes > FLUSH_BATCH_BYTES) {
          problems.push(
            `${arm.name}: pre-scan file writes ${String(status.startupGate.preScanFileBytes)} B > one batch ${String(FLUSH_BATCH_BYTES)} B`,
          );
        }
        if (
          status.startupGate.postDowngradeOpenParts > 0 ||
          status.startupGate.postDowngradeFileBytes > 0
        ) {
          problems.push(
            `${arm.name}: post-downgrade pre-scan writes ${String(status.startupGate.postDowngradeFileBytes)} B (${String(status.startupGate.postDowngradeOpenParts)} parts)`,
          );
        }
      }
      if (arm.testSuspend === true) {
        if (status.startupSuspends <= 0) {
          problems.push(
            `${arm.name} startupSuspends=${String(status.startupSuspends)} (expected > 0)`,
          );
        }
        if (status.startupBufferedPeak > 24 * MIB) {
          problems.push(
            `${arm.name} startupBufferedPeak=${String(status.startupBufferedPeak)} > ${String(24 * MIB)}`,
          );
        }
      }
      if (!status.ready) problems.push(`${arm.name} gate remained shut after flush/seal`);
      const expectedUnreadable = arm.unreadable === true ? (isRoot ? 1 : 2) : 0;
      if (arm.unreadable === true) {
        if (status.unreadableEntries !== expectedUnreadable) {
          problems.push(
            `${arm.name} unreadableEntries ${String(status.unreadableEntries)} != ${String(expectedUnreadable)}`,
          );
        }
        if (!status.problems.some((p) => p.kind === "unreadable-entries")) {
          problems.push(
            `${arm.name} missing unreadable-entries problem: ${JSON.stringify(status.problems)}`,
          );
        }
        if (status.problems.some((p) => p.kind === "write-failed")) {
          problems.push(`${arm.name} unexpected write-failed: ${JSON.stringify(status.problems)}`);
        }
      } else if (status.problems.length > 0) {
        problems.push(`${arm.name} store problems: ${JSON.stringify(status.problems)}`);
      }
      if (status.observerErrors.length > 0) {
        problems.push(`${arm.name} observer errors: ${status.observerErrors.join(", ")}`);
      }

      if (arm.unreadable !== true) {
        problems.push(
          ...checkArchiveOnDisk({
            root,
            step: `${arm.name}-after-seal`,
            usage: status.usage,
            expectZeroParts: true,
            maxBodyBytes: arm.bodyCap,
            requireAllSummarized: true,
          }).problems,
        );
      } else if (status.usage.bodyBytes > arm.bodyCap) {
        problems.push(
          `${arm.name} usage.bodyBytes ${String(status.usage.bodyBytes)} > ${String(arm.bodyCap)}`,
        );
      }

      const bodyStats = verifyStartupBodies(arm, root, server, ws.lines(), problems);
      const ceiling = Math.max(arm.bodyCap, seededBytes) + FLUSH_BATCH_BYTES;
      const maxDu = Math.max(...duSamples);
      if (maxDu > ceiling) {
        problems.push(
          `${arm.name} startup du ${String(maxDu)} B > ${String(ceiling)} B (cap ${String(arm.bodyCap)} + batch ${String(FLUSH_BATCH_BYTES)})`,
        );
      }
      const summary = `${arm.name}: maxDu=${String(maxDu)}/${String(ceiling)} exact=${String(bodyStats.exactCount)}`;
      const data = {
        seededBytes,
        bodyCap: arm.bodyCap,
        ceilingBytes: ceiling,
        maxDuBytes: maxDu,
        sampleCount: duSamples.length,
        ready: status.ready,
        startupGate: status.startupGate,
        unreadableEntries: status.unreadableEntries,
        exactBodies: bodyStats.exactCount,
        cutBodies: bodyStats.cutCount,
        timeoutStored: bodyStats.timeoutStored,
        timeoutIncomplete: bodyStats.timeoutIncomplete,
        falseFirstPart: bodyStats.falseFirstPart,
        zeroLengthStored: bodyStats.zeroLengthStored,
        finalUsage: status.usage,
      };
      if (keepWs) {
        await session.quit();
        restartSeed = {
          ws,
          expectedRestartUsage: {
            run: status.run,
            bodyBytes: status.usage.bodyBytes,
            detailBytes: status.usage.detailBytes,
          },
        };
      }
      return { summary, data, restartSeed };
    } finally {
      await stopSampler();
      if (deniedDir !== null && NodeFS.existsSync(deniedDir)) {
        NodeFS.chmodSync(deniedDir, 0o700);
      }
    }
  } catch (error) {
    keepWs = false;
    throw error;
  } finally {
    if (!keepWs) {
      await ws[Symbol.asyncDispose]();
    }
  }
}

/**
 * Launches onto at-cap, over-cap, and unreadable-entry archives and streams immediate parallel file-tee (including
 * lengthless chunked responses) and memory-tee traffic before calling flush, verifying startup disk headroom, gate
 * opening, unreadable entry reporting, and SHA-256 body fidelity across every recorded response.
 */
const check: HarnessCheck = {
  name: "retention-startup",
  description:
    "immediate recording on at-cap, over-cap, and unreadable-entry archives holds disk cap, opens gate, and keeps exact bodies",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const extensionPath = context.extensionPath;
    if (extensionPath === null || !NodeFS.existsSync(extensionPath)) {
      return {
        name: "retention-startup",
        ok: false,
        durationMs: Date.now() - started,
        detail: "needs existing --extension path",
      };
    }
    const addonId = await readExtensionId(extensionPath);
    const popupPath = await readExtensionPopupPath(extensionPath);

    const armProblems = Array.from({ length: ARMS.length }, (): string[] => []);
    const armSummaries = Array.from({ length: ARMS.length }, () => "");
    const armEntries = Array.from({ length: ARMS.length }, (): unknown => undefined);

    const baseIndex = ARMS.findIndex((a) => a.name === "64mib-100-packs");
    const restartIndex = ARMS.findIndex((a) => a.name === "64mib-clean-restart");
    const baseArm = baseIndex >= 0 ? ARMS[baseIndex] : undefined;
    const restartArm = restartIndex >= 0 ? ARMS[restartIndex] : undefined;
    const baseProblems = armProblems[baseIndex];
    const restartProblems = armProblems[restartIndex];
    type Task = { readonly weight: number; readonly run: (server: FixtureServer) => Promise<void> };
    const tasks: Task[] = [];

    if (
      baseArm !== undefined &&
      restartArm !== undefined &&
      baseProblems !== undefined &&
      restartProblems !== undefined
    ) {
      tasks.push({
        weight: 10_000,
        run: async (server) => {
          const baseOutcome = await runStartupArm({
            arm: baseArm,
            context,
            extensionPath,
            addonId,
            popupPath,
            server,
            problems: baseProblems,
            keepWorkspaceForRestart: true,
          });
          armSummaries[baseIndex] = baseOutcome.summary;
          armEntries[baseIndex] = baseOutcome.data;
          const seed = baseOutcome.restartSeed;
          if (seed === null) {
            restartProblems.push("64mib-clean-restart: missing base workspace");
            return;
          }
          await using _reusedWs = seed.ws;
          const restartOutcome = await runStartupArm({
            arm: restartArm,
            context,
            extensionPath,
            addonId,
            popupPath,
            server,
            problems: restartProblems,
            reused: seed,
          });
          armSummaries[restartIndex] = restartOutcome.summary;
          armEntries[restartIndex] = restartOutcome.data;
        },
      });
    }

    for (const [index, arm] of ARMS.entries()) {
      if (index === baseIndex || index === restartIndex) continue;
      const entryProblems = armProblems[index];
      if (entryProblems === undefined) continue;
      tasks.push({
        weight: arm.scanDelayMs ?? 0,
        run: async (server) => {
          const outcome = await runStartupArm({
            arm,
            context,
            extensionPath,
            addonId,
            popupPath,
            server,
            problems: entryProblems,
          });
          armSummaries[index] = outcome.summary;
          armEntries[index] = outcome.data;
        },
      });
    }

    // Run longest-delay 150k arms first so workers stay balanced without starving later startups.
    tasks.sort((a, b) => b.weight - a.weight);
    const concurrency = Math.min(3, Math.max(2, NodeOS.availableParallelism() - 1));
    let nextTask = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        await using server = await startFixtureServer();
        for (;;) {
          context.signal.throwIfAborted();
          const task = tasks[nextTask++];
          if (task === undefined) return;
          await task.run(server);
        }
      }),
    );

    const problems = armProblems.flat();
    const armData: Record<string, unknown> = {};
    for (const [index, arm] of ARMS.entries()) {
      armData[arm.name] = armEntries[index];
    }
    return {
      name: "retention-startup",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? armSummaries.join(", ") : problems.join("; "),
      data: armData,
    };
  },
};

/** @discovered-check */
export default check;
