import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseExchangeId } from "@hark/recording/ids";
import type { BrowserSession } from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
} from "../src/export-session.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startDevtoolsFixtureServer } from "../fixtures/devtools/server.ts";
import {
  DEVTOOLS_FAULTS,
  verifyDevtoolsHar,
  type DevtoolsVerifyExpectation,
} from "../fixtures/devtools/verify.ts";

interface PopupPreview {
  readonly view?: {
    readonly preview?: {
      readonly sources?: {
        readonly both?: number;
        readonly recordingOnly?: number;
        readonly devtoolsOnly?: number;
      };
    };
  };
  readonly sources?: {
    readonly both?: number;
    readonly recordingOnly?: number;
    readonly devtoolsOnly?: number;
  };
}

function extractSources(popup: PopupPreview): {
  readonly both?: number;
  readonly recordingOnly?: number;
  readonly devtoolsOnly?: number;
} {
  return popup.view?.preview?.sources ?? popup.sources ?? {};
}

function assertClean(label: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(`${label} failed:\n- ${problems.join("\n- ")}`);
  }
}

async function assertBrokenHarFails(
  label: string,
  brokenHar: string,
  expectation: DevtoolsVerifyExpectation,
): Promise<void> {
  const result = await verifyDevtoolsHar(brokenHar, expectation);
  if (result.problems.length === 0) {
    throw new Error(`Deliberately broken HAR "${label}" passed verification`);
  }
}

async function evalChromeAsync<T>(
  session: BrowserSession,
  asyncBody: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const wrapped = `
    const done = arguments[arguments.length - 1];
    Promise.resolve().then(async () => {
      ${asyncBody}
    }).then(
      (res) => done({ ok: true, res }),
      (err) => done({ ok: false, error: err?.message ?? String(err) }),
    );
  `;
  const envelope = (await session.evaluateChrome(wrapped, args)) as {
    readonly ok: boolean;
    readonly res?: T;
    readonly error?: string;
  };
  if (!envelope.ok) {
    throw new Error(`evaluateChrome failed: ${envelope.error ?? "unknown error"}`);
  }
  return envelope.res as T;
}

function readHarByName(downloadsDir: string, fileName: string): string {
  const exact = NodePath.join(downloadsDir, `${fileName}.har`);
  if (NodeFS.existsSync(exact)) return NodeFS.readFileSync(exact, "utf8");
  const files = NodeFS.readdirSync(downloadsDir)
    .filter((f) => f.startsWith(fileName) && f.endsWith(".har"))
    .map((f) => {
      const full = NodePath.join(downloadsDir, f);
      return { full, mtimeMs: NodeFS.statSync(full).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = files[0];
  if (newest === undefined) throw new Error(`No .har file in ${downloadsDir} matching ${fileName}`);
  return NodeFS.readFileSync(newest.full, "utf8");
}

const check: HarnessCheck = {
  name: "devtools-pairing",
  description:
    "Verify cross-source pairing counts (both, recordingOnly, devtoolsOnly) match server logs and RunId scoping prevents cross-restart channelId collisions",
  async run(context: CheckContext): Promise<CheckResult> {
    const startedAt = Date.now();
    if (context.extensionPath === null) {
      return { name: this.name, ok: false, durationMs: 0, detail: "needs --extension" };
    }
    await using server = await startDevtoolsFixtureServer();
    await using workspace = recordingWorkspace("devtools-pairing");
    const workDir = NodePath.join(NodePath.dirname(workspace.profileDir), "k6-check");
    NodeFS.mkdirSync(workDir, { recursive: true });
    const baseLaunch = {
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette" as const,
      signal: context.signal,
      launchMode: "recommended" as const,
    };

    // Run 1: open extension page cleanly (matching Run 2 startup so content process channelIds overlap),
    // record requests across restarts, and shut down cleanly.
    server.takeRequests();
    await using session1 = await workspace.launch(baseLaunch);
    await openExtensionPage(session1, context.extensionPath);
    const tab1 = await session1.openTab(`${server.origin}/page.html?n=15&big=0&key=run1`);
    await session1.evaluate(tab1, "window.__devtoolsPageReady");
    const tab1b = await session1.openTab(`${server.origin}/page.html?n=10&big=0&key=run1b`);
    await session1.evaluate(tab1b, "window.__devtoolsPageReady");
    await new Promise((r) => setTimeout(r, 400));
    await callHook(session1, { kind: "flush" });
    await evalChromeAsync<{ readonly id: string }>(
      session1,
      `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const addons = await AddonManager.getAllAddons();
       const ours = addons.find((a) => a.type === "extension" && a.isActive && a.id.includes("hark"));
       if (!ours) throw new Error("Extension addon not found");
       const ext = ExtensionParent.GlobalManager.getExtension(ours.id);
       await ExtensionPermissions.add(ours.id, { permissions: ["internal:privateBrowsingAllowed"], origins: [] }, ext);
       await ExtensionParent.StartupCache?._saveNow?.();
       await new Promise((r) => setTimeout(r, 500));
       return { id: ours.id };`,
    );
    await session1.quit();
    const run1Log = server.takeRequests();

    const run1Ids = new Set<string>();
    const run1Runs = new Set<string>();
    for (const line of workspace.lines()) {
      const parsed = parseExchangeId(line.exchange.request.id);
      if (parsed !== null) {
        run1Ids.add(String(parsed.channel));
        run1Runs.add(String(parsed.run));
      }
    }
    if (run1Ids.size === 0 || run1Runs.size === 0) {
      throw new Error("Run 1 produced no recorded channelIds or runIds");
    }

    // Run 2: same workspace/profile/dataHome across restart
    await using session2 = await workspace.launch({ ...baseLaunch, extensionPath: null });
    const page2 = await openExtensionPage(session2, context.extensionPath);

    // Tab A in Run 2: 1 pre-DevTools request (recordingOnly), then open DevTools, then load page (both)
    server.takeRequests();
    const preUrl = `${server.origin}/blank.html?pre=run2`;
    const tabAHandle = await session2.openTab(preUrl);
    const tabAId = await newestPageTab(page2);
    const preLog = server.takeRequests();
    await evalChromeAsync<boolean>(
      session2,
      `const [url] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const win = Services.wm.getMostRecentWindow("navigator:browser");
       const t = win.gBrowser.tabs.find((x) => x.linkedBrowser?.currentURI?.spec === url);
       if (!t) throw new Error("Tab A not found: " + url);
       await gDevTools.showToolboxForTab(t, { toolId: "netmonitor" });
       return true;`,
      [preUrl],
    );
    await session2.navigateTab(tabAHandle, `${server.origin}/page.html?n=15&big=0&key=run2both`);
    await session2.evaluate(tabAHandle, "window.__devtoolsPageReady");
    await new Promise((r) => setTimeout(r, 500));
    const bothLog = server.takeRequests();
    const tabAResourceIds = await evalChromeAsync<readonly (number | null)[]>(
      session2,
      `const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const win = Services.wm.getMostRecentWindow("navigator:browser");
       const t = win.gBrowser.tabs.find((x) => String(x.linkedBrowser?.currentURI?.spec ?? "").includes("key=run2both"));
       if (!t) return [];
       const api = await gDevTools.getToolboxForTab(t).getNetMonitorAPI();
       return Array.from(api.store.getState().requests.requests.values()).map((r) => r.resourceId ?? null);`,
    );
    await callHook(session2, { kind: "flush" });

    const popupA = await value<PopupPreview>(
      page2,
      `browser.hark.preview({ scope: "tab", tabId: ${String(tabAId)}, range: { kind: "since-tab-opened" }, include: "all" })`,
    );
    const jobA = await startExport(page2, {
      selection: {
        scope: "tab",
        tabId: tabAId,
        range: { kind: "since-tab-opened" },
        include: "all",
      },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "devtools-pair-a",
    });
    const doneA = await waitForJob(page2, jobA.id, ended);
    if (doneA.state.kind !== "done") {
      throw new Error(`Tab A export failed: ${JSON.stringify(doneA.state)}`);
    }
    const harA = readHarByName(workspace.downloads, "devtools-pair-a");
    const expectA: DevtoolsVerifyExpectation = {
      server,
      expectedLog: [...preLog, ...bothLog],
      entries: preLog.length + bothLog.length,
      sources: {
        both: bothLog.length,
        recordingOnly: preLog.length,
        devtoolsOnly: 0,
      },
      expectedSourceTagForUrl: [
        { urlIncludes: "pre=run2", source: "recording-only" },
        { urlIncludes: "/text.txt?k=run2both", source: "both" },
      ],
      workDir,
    };
    assertClean("run2-tab-a-pairing", (await verifyDevtoolsHar(harA, expectA)).problems);
    const srcA = extractSources(popupA);
    if (
      srcA.both !== bothLog.length ||
      srcA.recordingOnly !== preLog.length ||
      srcA.devtoolsOnly !== 0
    ) {
      throw new Error(
        `Tab A popup sources ${JSON.stringify(srcA)} != expected both=${String(bothLog.length)} recordingOnly=${String(preLog.length)}`,
      );
    }
    await assertBrokenHarFails(
      "wrongSourceCounts",
      DEVTOOLS_FAULTS.wrongSourceCounts(harA),
      expectA,
    );

    // Tab B: Private window with DevTools open -> devtoolsOnly, and verify RunId isolation across restart
    server.takeRequests();
    const privInfo = await evalChromeAsync<{
      readonly tabId: number;
      readonly resourceIds: readonly (number | null)[];
    }>(
      session2,
      `const [blankUrl, pageUrl] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const win = OpenBrowserWindow({ private: true });
       if (!win.gBrowser) {
         await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
       }
       await win.delayedStartupPromise;
       const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       win.gBrowser.selectedTab = tab;
       await new Promise((r) => win.setTimeout(r, 200));
       await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
       await gDevTools.getToolboxForTab(tab).getNetMonitorAPI();
       win.gBrowser.fixupAndLoadURIString(pageUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       for (let i = 0; i < 150; i += 1) {
         const api = await gDevTools.getToolboxForTab(tab)?.getNetMonitorAPI();
         const reqs = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []);
         if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/1") && r.totalTime !== undefined)) break;
         await new Promise((r) => win.setTimeout(r, 100));
       }
       await new Promise((r) => win.setTimeout(r, 500));
       const api = await gDevTools.getToolboxForTab(tab)?.getNetMonitorAPI();
       const resourceIds = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []).map((r) => r.resourceId ?? r.channelId ?? null);
       return {
         tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab),
         resourceIds,
       };`,
      ["about:blank", `${server.origin}/page.html?n=2&big=0&key=run2priv`],
    );
    const privLog = server.takeRequests();

    const jobB = await startExport(page2, {
      selection: {
        scope: "tab",
        tabId: privInfo.tabId,
        range: { kind: "since-tab-opened" },
        include: "all",
      },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "devtools-pair-priv",
    });
    const doneB = await waitForJob(page2, jobB.id, ended);
    if (doneB.state.kind !== "done") {
      throw new Error(`Private Tab B export failed: ${JSON.stringify(doneB.state)}`);
    }
    const harB = readHarByName(workspace.downloads, "devtools-pair-priv");
    const expectB: DevtoolsVerifyExpectation = {
      server,
      expectedLog: privLog,
      entries: privLog.length,
      sources: {
        both: 0,
        recordingOnly: 0,
        devtoolsOnly: privLog.length,
      },
      requireDevtoolsSources: true,
      workDir,
    };
    assertClean("run2-private-devtools-only", (await verifyDevtoolsHar(harB, expectB)).problems);

    const overlap = [...tabAResourceIds, ...privInfo.resourceIds].filter(
      (id) => id !== null && run1Ids.has(String(id)),
    );
    if (overlap.length === 0) {
      throw new Error(
        `Expected real cross-restart numeric channelId collision (>0) between Run 1 (${String(run1Ids.size)} ids) and Run 2, got 0`,
      );
    }

    // Export everything across Run 1 + Run 2 and prove Run 1 items stay recordingOnly (never pair across runs)
    const jobAll = await startExport(page2, {
      selection: { scope: "everything", range: { kind: "everything" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "devtools-pair-all",
    });
    const doneAll = await waitForJob(page2, jobAll.id, ended);
    if (doneAll.state.kind !== "done") {
      throw new Error(`Everything export failed: ${JSON.stringify(doneAll.state)}`);
    }
    const harAll = readHarByName(workspace.downloads, "devtools-pair-all");
    const expectAll: DevtoolsVerifyExpectation = {
      server,
      expectedLog: [...run1Log, ...preLog, ...bothLog, ...privLog],
      entries: run1Log.length + preLog.length + bothLog.length + privLog.length,
      sources: {
        both: bothLog.length,
        recordingOnly: run1Log.length + preLog.length,
        devtoolsOnly: privLog.length,
      },
      expectedSourceTagForUrl: [
        { urlIncludes: "k=run1", source: "recording-only" },
        { urlIncludes: "k=run2both", source: "both" },
      ],
      disallowBothFromPrefix: "k=run1",
      requireK6: false,
    };
    assertClean(
      "cross-restart-all-recorded",
      (await verifyDevtoolsHar(harAll, expectAll)).problems,
    );
    await assertBrokenHarFails(
      "pairAcrossRuns",
      DEVTOOLS_FAULTS.pairAcrossRuns(harAll, "k=run1"),
      expectAll,
    );

    await session2.quit();

    return {
      name: this.name,
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: `Verified both=${String(bothLog.length)}, recordingOnly=${String(run1Log.length + preLog.length)}, devtoolsOnly=${String(privLog.length)} across restart (raw numeric channelId overlap=${String(overlap.length)}).`,
    };
  },
};

/** @discovered-check */
export default check;
