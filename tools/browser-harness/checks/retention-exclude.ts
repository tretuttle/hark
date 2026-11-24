import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Site } from "@hark/recording/ids";
import { LAYOUT, siteDirName } from "@hark/recording/layout";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { BINARY_BYTE_LENGTH } from "../src/fixtures.ts";
import { until } from "../src/kill-at-point.ts";
import {
  checkArchiveOnDisk,
  checkExcludeDuringTee,
  measureArchiveDisk,
} from "../src/recording-verify.ts";
import { callHook, recordingWorkspace, SMALL_CAP_SETTINGS } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const SITE = "127.0.0.1";
const PAUSE_AFTER_BYTES = 1_048_576;
const ABORT_READ_BYTES = 8_000_000;
const BLOB_BYTES = 850_000;
const SMALL_CAP_BYTES = SMALL_CAP_SETTINGS.user.retention.maxBodyBytes;

const readUsage = async (
  session: BrowserSession,
): Promise<{ readonly bodyBytes: number; readonly detailBytes: number }> => {
  const status = (await callHook(session, { kind: "status" })) as {
    readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
  };
  return status.usage;
};

const fetchSmallSite = async (
  session: BrowserSession,
  tab: string,
  port: number,
  site: string,
): Promise<void> => {
  await session.navigateTab(tab, `http://${site}:${String(port)}/retention/page`);
  await session.evaluate(
    tab,
    `(async () => {
      for (let i = 0; i < 6; i += 1) {
        const res = await fetch("/retention/blob?bytes=${String(BLOB_BYTES)}&tag=${site}-" + i);
        await res.arrayBuffer();
      }
      return "done";
    })()`,
  );
};

/**
 * Checks that the tracked usage matches the archive on disk across:
 * 1) excluding a site while a 50 MB file tee streams,
 * 2) aborting a streaming file tee under cap pressure so the unkept part drops from bodyBytes,
 * 3) excluding recent sites under cap pressure so both bodyBytes and detailBytes match disk without evicting older sites.
 */
const check: HarnessCheck = {
  name: "retention-exclude",
  description:
    "exclude during 50 MB tee, aborted file tee, and cap-pressure exclude keep bodyBytes and detailBytes equal to disk",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null) {
      return { name: "retention-exclude", ok: false, durationMs: 0, detail: "needs --extension" };
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
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("retention-exclude");
    const problems: string[] = [];

    let partCountDuringTee = 0;
    let siteDirExistsDuringTee = false;
    let siteDirExistsAfterStop = false;
    let partsAfterStop: string[] = [];
    let sitesIndexDuringTee: readonly string[] = [];
    let sitesIndexAfterStop: readonly string[] = [];
    let received = 0;

    {
      await using session = await workspace.launch(base);
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const tab = await session.openTab(`${server.origin}/id/download.html`);
      await session.evaluate(
        tab,
        `fetch("/fixtures/range", { headers: { Range: "bytes=1000-1999" } }).then((r) => r.arrayBuffer()).then(() => "done")`,
      );
      await callHook(session, { kind: "flush" });

      const root = workspace.root();
      const siteDir = NodePath.join(root, "sites", SITE);
      const incomingDir = NodePath.join(root, "incoming");
      const initialSites = (await callHook(session, { kind: "sites" })) as readonly string[];
      if (!NodeFS.existsSync(siteDir)) problems.push(`sites/${SITE} missing before tee`);
      if (!initialSites.includes(SITE)) problems.push(`${SITE} missing from index before exclude`);

      await session.evaluate(
        tab,
        `window.__binaryDone = fetch("/fixtures/binary?pauseAfterBytes=${String(PAUSE_AFTER_BYTES)}").then((r) => r.arrayBuffer()).then((b) => b.byteLength); "started"`,
      );
      await until(
        () =>
          NodeFS.readdirSync(incomingDir).some(
            (name) => NodeFS.statSync(NodePath.join(incomingDir, name)).size >= PAUSE_AFTER_BYTES,
          ),
        "50 MB file tee streaming part >= 1 MiB",
      );

      partCountDuringTee = NodeFS.readdirSync(incomingDir).length;
      await callHook(session, { kind: "exclude", site: SITE });
      siteDirExistsDuringTee = NodeFS.existsSync(siteDir);
      sitesIndexDuringTee = (await callHook(session, { kind: "sites" })) as readonly string[];

      server.releasePaused();
      received = Number(await session.evaluate(tab, "window.__binaryDone.then(String)"));
      if (received !== BINARY_BYTE_LENGTH) {
        problems.push(
          `page received ${String(received)} bytes, expected ${String(BINARY_BYTE_LENGTH)}`,
        );
      }
      await callHook(session, { kind: "flush" });
      await callHook(session, { kind: "seal" });
      await until(() => measureArchiveDisk(root).partCount === 0, "exclude part cleanup");

      siteDirExistsAfterStop = NodeFS.existsSync(siteDir);
      partsAfterStop = NodeFS.readdirSync(incomingDir);
      sitesIndexAfterStop = (await callHook(session, { kind: "sites" })) as readonly string[];
      const status = (await callHook(session, { kind: "status" })) as {
        readonly problems: readonly { readonly kind: string; readonly detail: string }[];
        readonly usage: { readonly bodyBytes: number; readonly detailBytes: number };
      };

      problems.push(
        ...checkExcludeDuringTee({
          excludedSite: SITE,
          siteDirExistsDuringTee,
          sitesIndexDuringTee,
          partCountDuringTee,
          siteDirExistsAfterStop,
          partsAfterStop,
          sitesIndexAfterStop,
          problems: status.problems.map((p) => `${p.kind}:${p.detail}`),
        }),
        ...checkArchiveOnDisk({
          root,
          step: "after-exclude-mid-tee",
          usage: status.usage,
          expectZeroParts: true,
        }).problems,
      );
    }

    await using abortWorkspace = recordingWorkspace("retention-abort");
    abortWorkspace.seed("d".repeat(32), SMALL_CAP_SETTINGS);
    {
      await using session = await abortWorkspace.launch(base);
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const tab = await session.openTab(
        `http://s01.localhost:${String(server.port)}/retention/page`,
      );
      for (let i = 1; i <= 12; i += 1) {
        await fetchSmallSite(session, tab, server.port, `s${String(i).padStart(2, "0")}.localhost`);
      }
      await callHook(session, { kind: "flush" });
      const abortRoot = abortWorkspace.root();
      problems.push(
        ...checkArchiveOnDisk({
          root: abortRoot,
          step: "before-abort-tee",
          usage: await readUsage(session),
          expectZeroParts: true,
          maxBodyBytes: SMALL_CAP_BYTES,
        }).problems,
      );

      await session.navigateTab(tab, `${server.origin}/id/download.html`);
      await session.evaluate(
        tab,
        `(async () => {
          const ac = new AbortController();
          const reader = (await fetch("/id/endless?rate=fast", { signal: ac.signal })).body.getReader();
          let read = 0;
          while (read < ${String(ABORT_READ_BYTES)}) {
            const chunk = await reader.read();
            if (chunk.done) break;
            read += chunk.value.byteLength;
          }
          ac.abort();
          return String(read);
        })()`,
      );
      await session.evaluate(
        tab,
        `fetch("/id/big?delayMs=0").then((r) => r.arrayBuffer()).then((b) => String(b.byteLength))`,
      );
      await callHook(session, { kind: "flush" });
      await until(() => measureArchiveDisk(abortRoot).partCount === 0, "aborted tee part removal");
      await callHook(session, { kind: "seal" });
      problems.push(
        ...checkArchiveOnDisk({
          root: abortRoot,
          step: "after-aborted-tee",
          usage: await readUsage(session),
          expectZeroParts: true,
          maxBodyBytes: SMALL_CAP_BYTES,
          requireAllSummarized: true,
        }).problems,
      );
    }

    await using capWorkspace = recordingWorkspace("retention-exclude-cap");
    capWorkspace.seed("c".repeat(32), SMALL_CAP_SETTINGS);
    {
      await using session = await capWorkspace.launch(base);
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const tab = await session.openTab(
        `http://s01.localhost:${String(server.port)}/retention/page`,
      );
      for (let i = 1; i <= 12; i += 1) {
        await fetchSmallSite(session, tab, server.port, `s${String(i).padStart(2, "0")}.localhost`);
      }
      await callHook(session, { kind: "flush" });
      await callHook(session, { kind: "seal" });
      const root = capWorkspace.root();
      problems.push(
        ...checkArchiveOnDisk({
          root,
          step: "before-cap-exclude",
          usage: await readUsage(session),
          expectZeroParts: true,
          maxBodyBytes: SMALL_CAP_BYTES,
          requireAllSummarized: true,
        }).problems,
      );

      for (let i = 7; i <= 12; i += 1) {
        await callHook(session, {
          kind: "exclude",
          site: `s${String(i).padStart(2, "0")}.localhost`,
        });
      }
      problems.push(
        ...checkArchiveOnDisk({
          root,
          step: "after-cap-exclude",
          usage: await readUsage(session),
          expectZeroParts: true,
          requireAllSummarized: true,
        }).problems,
      );

      for (let i = 13; i <= 18; i += 1) {
        await fetchSmallSite(session, tab, server.port, `s${String(i).padStart(2, "0")}.localhost`);
      }
      await callHook(session, { kind: "flush" });
      await callHook(session, { kind: "seal" });
      problems.push(
        ...checkArchiveOnDisk({
          root,
          step: "after-followup-sites",
          usage: await readUsage(session),
          expectZeroParts: true,
          maxBodyBytes: SMALL_CAP_BYTES,
          requireAllSummarized: true,
        }).problems,
      );
      for (let i = 1; i <= 6; i += 1) {
        const packDir = NodePath.join(
          root,
          LAYOUT.sitesDir,
          siteDirName(`s${String(i).padStart(2, "0")}.localhost` as Site),
          LAYOUT.packDir,
        );
        if (!NodeFS.existsSync(packDir) || NodeFS.readdirSync(packDir).length === 0) {
          problems.push(
            `older site s0${String(i)} was wrongly evicted after newer sites were excluded`,
          );
        }
      }
    }

    return {
      name: "retention-exclude",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `excluded ${SITE} mid-tee (${String(partCountDuringTee)} part), aborted tee, and cap-pressure exclude of s07..s12 kept bodyBytes and detailBytes equal to disk and preserved s01..s06`
          : problems.join("; "),
      data: {
        partCountDuringTee,
        siteDirExistsDuringTee,
        siteDirExistsAfterStop,
        partsAfterStop,
        sitesIndexDuringTee,
        sitesIndexAfterStop,
        received,
      },
    };
  },
};

/** @discovered-check */
export default check;
