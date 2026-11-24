import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BrowserSession } from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
  type ExtensionPage,
} from "../src/export-session.ts";
import { recordingWorkspace } from "../src/recording-session.ts";
import {
  DEVTOOLS_GROUND_TRUTH,
  DEVTOOLS_STACK_FRAMES,
  startDevtoolsFixtureServer,
  type DevtoolsFixtureServer,
  type DevtoolsServedRequest,
} from "../fixtures/devtools/server.ts";
import {
  DEVTOOLS_FAULTS,
  verifyDevtoolsHar,
  type DevtoolsHarDocument,
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

function assertClean(label: string, problems: readonly string[], harText?: string): void {
  if (problems.length > 0) {
    let summary = "";
    if (harText !== undefined && harText.length > 0) {
      try {
        const doc = JSON.parse(harText) as DevtoolsHarDocument;
        summary = `\nentries:\n${doc.log.entries
          .map(
            (e) =>
              `  [${e._harExport?.source ?? "?"} s=${String(e.response.status)}] ${e.request.method} ${e.request.url}`,
          )
          .join("\n")}`;
      } catch {
        // Ignore parse failure when reporting.
      }
    }
    throw new Error(`${label} failed:\n- ${problems.join("\n- ")}${summary}`);
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

function readDownloadedHar(downloadsDir: string, fileName: string): string {
  const expectedPath = NodePath.join(downloadsDir, `${fileName}.har`);
  if (NodeFS.existsSync(expectedPath)) return NodeFS.readFileSync(expectedPath, "utf8");
  const files = NodeFS.readdirSync(downloadsDir)
    .filter((f) => f.startsWith(fileName) && f.endsWith(".har"))
    .map((f) => {
      const full = NodePath.join(downloadsDir, f);
      return { full, mtimeMs: NodeFS.statSync(full).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = files[0];
  if (newest === undefined) {
    throw new Error(`No .har file written in ${downloadsDir} matching ${fileName}`);
  }
  return NodeFS.readFileSync(newest.full, "utf8");
}

async function exportTabAndReadHar(
  page: ExtensionPage,
  downloadsDir: string,
  tabId: number,
  fileName: string,
): Promise<{ readonly harText: string; readonly popup: PopupPreview; readonly exportMs: number }> {
  let stage = "ping-page";
  try {
    await value<string>(page, "Promise.resolve('ok')");
    stage = "preview";
    const popup = await value<PopupPreview>(
      page,
      `Promise.race([
        browser.hark.preview({ scope: "tab", tabId: ${String(tabId)}, range: { kind: "since-tab-opened" }, include: "all" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("preview call hung >10s")), 10000)),
      ])`,
    );
    stage = "startExport";
    const t0 = Date.now();
    const job = await startExport(page, {
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName,
    });
    stage = `waitForJob(${job.id})`;
    const done = await waitForJob(page, job.id, ended);
    const exportMs = Date.now() - t0;
    if (done.state.kind !== "done") {
      throw new Error(`Export job ${job.id} did not finish cleanly: ${JSON.stringify(done.state)}`);
    }
    return { harText: readDownloadedHar(downloadsDir, fileName), popup, exportMs };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${fileName} at ${stage}: ${msg}`, { cause: error });
  }
}

async function openToolboxAndWaitReady(
  session: BrowserSession,
  page: ExtensionPage,
  urlPath: string,
  origin: string,
  toolId: "netmonitor" | "inspector",
  sortBy?: string,
) {
  const tabHandle = await session.openTab("about:blank");
  const tabId = await newestPageTab(page);
  const chromeOk = await evalChromeAsync<{ readonly hasNetmonitor: boolean }>(
    session,
    `const [tabId, toolId, sortBy] = arguments;
     const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
     const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
     const targetTab = ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
     if (!targetTab) throw new Error("Tab not found for tabId: " + tabId);
     const toolbox = await gDevTools.showToolboxForTab(targetTab, { toolId });
     if (sortBy) {
       const api = await toolbox.getNetMonitorAPI();
       api.store.dispatch({ type: "SORT_BY", sortType: sortBy });
     }
     return { hasNetmonitor: Boolean(toolbox.getPanel("netmonitor")) };`,
    [tabId, toolId, sortBy ?? null],
  );
  // Give DevToolsShim "toolbox-ready" priming a moment on inspector before navigating.
  await new Promise((r) => setTimeout(r, 200));
  await session.navigateTab(tabHandle, `${origin}${urlPath}`);
  await session.evaluate(tabHandle, "window.__devtoolsPageReady");
  // Allow async browser favicon requests and final RDP NETWORK_EVENT updates to settle.
  await new Promise((r) => setTimeout(r, 500));
  return { tabHandle, tabId, chromeOk };
}

// The same page's first load is given 200 polls of 100 ms by the rounds below; its reload gets the same.
const RELOAD_POLLS = 200;
const RELOAD_POLL_MS = 100;

/**
 * A reload race round reloads its tab while the export runs, and that reload is still loading when
 * the export ends. This waits until the server has served the round's keyed requests a second time.
 * Without it they arrive after the next round has emptied the log and count as its first load.
 */
async function waitForReloadServed(
  server: DevtoolsFixtureServer,
  key: string,
  firstLoad: readonly DevtoolsServedRequest[],
): Promise<void> {
  const carriesKey = (request: DevtoolsServedRequest): boolean => {
    const query = new URL(request.url, server.origin).searchParams;
    return query.get("k") === key || query.get("key") === key;
  };
  const wanted = 2 * firstLoad.filter(carriesKey).length;
  let served = 0;
  for (let poll = 0; poll < RELOAD_POLLS; poll += 1) {
    served = server.getRequestLog().filter(carriesKey).length;
    if (served >= wanted) return;
    await new Promise((resolve) => setTimeout(resolve, RELOAD_POLL_MS));
  }
  throw new Error(
    `the server served ${String(served)} of ${String(wanted)} requests for ${key} (first load and reload) in ${String((RELOAD_POLLS * RELOAD_POLL_MS) / 1000)} s`,
  );
}

const check: HarnessCheck = {
  name: "devtools-source",
  description:
    "Verify DevTools capture as an export source across sorting, dead actors, inspector priming, 50MB fill, private windows, stack traces, and data: rows",
  async run(context: CheckContext): Promise<CheckResult> {
    const startedAt = Date.now();
    if (context.extensionPath === null) {
      return { name: this.name, ok: false, durationMs: 0, detail: "needs --extension" };
    }
    await using server = await startDevtoolsFixtureServer();
    await using workspace = recordingWorkspace("devtools-source");
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

    // Session A: default non-private permissions for sorted, inspector, 50MB fill, stacks, data:
    await using session = await workspace.launch(baseLaunch);
    const page = await openExtensionPage(session, context.extensionPath);

    // Panel sorted by contentSize + verifies actions remain enabled
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=4&big=0&key=sorted",
        server.origin,
        "netmonitor",
        "contentSize",
      );
      const taken = server.takeRequests();
      const { harText, popup } = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-sorted",
      );
      const expectSorted: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "sorted",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        requireDevtoolsSources: true,
        workDir,
      };
      const res = await verifyDevtoolsHar(harText, expectSorted);
      assertClean("sorted-by-size", res.problems, harText);
      const srcCounts = extractSources(popup);
      if (srcCounts.both !== taken.length) {
        throw new Error(
          `sorted popup.sources.both=${String(srcCounts.both)} != ${String(taken.length)}`,
        );
      }
      await assertBrokenHarFails("dropEntry", DEVTOOLS_FAULTS.dropEntry(harText), expectSorted);
      await assertBrokenHarFails("emptyFile", DEVTOOLS_FAULTS.emptyFile(), expectSorted);
      await session.closeTab(tabHandle);
    }

    // Toolbox opened on Inspector captures next load without ever opening Netmonitor
    {
      server.takeRequests();
      const { tabHandle, tabId, chromeOk } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=3&big=0&key=insp",
        server.origin,
        "inspector",
      );
      if (chromeOk.hasNetmonitor) {
        throw new Error("Netmonitor panel should not be loaded before inspector-only check");
      }
      const stillHasNetmonitor = await evalChromeAsync<boolean>(
        session,
        `const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
         for (const t of browserWin.gBrowser.tabs) {
           const tb = gDevTools.getToolboxForTab(t);
           if (tb && tb.getPanel("netmonitor")) return true;
         }
         return false;`,
      );
      if (stillHasNetmonitor) {
        throw new Error("Netmonitor panel was unexpectedly opened during inspector check");
      }
      const taken = server.takeRequests();
      const { harText } = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-inspector",
      );
      const expectInspector: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "insp",
        otherKey: "sorted",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        requireDevtoolsSources: true,
        workDir,
      };
      const res = await verifyDevtoolsHar(harText, expectInspector);
      assertClean("inspector-priming", res.problems);
      await assertBrokenHarFails(
        "zeroDevtoolsSources",
        DEVTOOLS_FAULTS.zeroDevtoolsSources(harText),
        expectInspector,
      );
      await session.closeTab(tabHandle);
    }

    // 50 MB body truncated by DevTools bodyLimit is filled byte-exact from recording
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=2&big=1&key=bigfill",
        server.origin,
        "netmonitor",
      );
      const taken = server.takeRequests();
      const { harText } = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-bigfill",
      );
      const expectBigFill: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "bigfill",
        otherKey: "insp",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        filledInMin: 1,
        requireDevtoolsSources: true,
        requireK6: false,
      };
      const res = await verifyDevtoolsHar(harText, expectBigFill);
      assertClean("big-50mb-fill", res.problems);
      await assertBrokenHarFails(
        "zeroPaddedBig",
        DEVTOOLS_FAULTS.zeroPaddedBig(harText),
        expectBigFill,
      );
      await assertBrokenHarFails(
        "unfilledBig",
        DEVTOOLS_FAULTS.unfilledBig(harText),
        expectBigFill,
      );
      await session.closeTab(tabHandle);
    }

    // Two consecutive exports both keep 4 stack frames and keep Netmonitor actions enabled
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=2&big=0&stack=1&key=stack",
        server.origin,
        "netmonitor",
      );
      const taken = server.takeRequests();
      const expectStack: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "stack",
        otherKey: "bigfill",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        stackUrlIncludes: "/text.txt?stack=stack",
        expectedFrames: DEVTOOLS_STACK_FRAMES,
        requireDevtoolsSources: true,
        workDir,
      };
      const first = await exportTabAndReadHar(page, workspace.downloads, tabId, "devtools-stack-1");
      assertClean("stack-export-1", (await verifyDevtoolsHar(first.harText, expectStack)).problems);
      const second = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-stack-2",
      );
      assertClean(
        "stack-export-2",
        (await verifyDevtoolsHar(second.harText, expectStack)).problems,
      );

      const panelState = await evalChromeAsync<{
        readonly actionsEnabled: boolean | null;
        readonly frameCount: number;
      }>(
        session,
        `const [url] = arguments;
         const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
         const targetTab = browserWin.gBrowser.tabs.find((t) =>
           t.linkedBrowser?.currentURI?.spec?.startsWith(url)
         );
         const api = await gDevTools.getToolboxForTab(targetTab)?.getNetMonitorAPI();
         const state = api?.store?.getState();
         const reqs = Array.from(state?.requests?.requests?.values?.() ?? []);
         const stackReq = reqs.find((r) => typeof r.url === "string" && r.url.includes("stack=stack"));
         return {
           actionsEnabled: api?.connector?.dataProvider?.actionsEnabled ?? null,
           frameCount: stackReq?.stacktrace?.length ?? 0,
         };`,
        [`${server.origin}/page.html?n=2&big=0&stack=1&key=stack`],
      );
      if (
        panelState.actionsEnabled !== true ||
        panelState.frameCount < DEVTOOLS_STACK_FRAMES.length
      ) {
        throw new Error(
          `Panel stack state corrupted after 2 exports: ${JSON.stringify(panelState)}`,
        );
      }
      await assertBrokenHarFails(
        "dropStackFrame",
        DEVTOOLS_FAULTS.dropStackFrame(second.harText, "/text.txt?stack=stack"),
        expectStack,
      );
      await session.closeTab(tabHandle);
    }

    // Built-in sorted Save All As HAR first (leaves actions disabled), then Hark recovers stacks
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=2&big=0&stack=1&key=builtin",
        server.origin,
        "netmonitor",
        "contentSize",
      );
      const taken = server.takeRequests();
      const builtIn = await evalChromeAsync<{
        readonly harLen: number;
        readonly actionsEnabled: boolean | null;
      }>(
        session,
        `const [url] = arguments;
         const loader = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
         const { gDevTools } = loader.require("resource://devtools/client/framework/devtools.js");
         const { HarExporter } = loader.require("resource://devtools/client/netmonitor/src/har/har-exporter.js");
         const { HarMenuUtils } = loader.require("resource://devtools/client/netmonitor/src/har/har-menu-utils.js");
         const { getDisplayedRequests } = loader.require("resource://devtools/client/netmonitor/src/selectors/requests.js");
         const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
         const targetTab = browserWin.gBrowser.tabs.find((t) =>
           t.linkedBrowser?.currentURI?.spec?.startsWith(url)
         );
         const api = await gDevTools.getToolboxForTab(targetTab).getNetMonitorAPI();
         const items = getDisplayedRequests(api.store.getState());
         const raw = await HarExporter.fetchHarData(HarMenuUtils.getDefaultHarOptions(items, api.connector)).catch(() => null);
         return {
           harLen: typeof raw === "string" ? raw.length : 0,
           actionsEnabled: api?.connector?.dataProvider?.actionsEnabled ?? null,
         };`,
        [`${server.origin}/page.html?n=2&big=0&stack=1&key=builtin`],
      );
      if (builtIn.actionsEnabled !== false) {
        throw new Error(
          `Expected built-in sorted HAR export to leave actionsEnabled=false, got ${JSON.stringify(builtIn)}`,
        );
      }
      const expectBuiltin: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "builtin",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        stackUrlIncludes: "/text.txt?stack=builtin",
        expectedFrames: DEVTOOLS_STACK_FRAMES,
        requireDevtoolsSources: true,
        workDir,
      };
      const first = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-builtin-1",
      );
      assertClean(
        "builtin-first",
        (await verifyDevtoolsHar(first.harText, expectBuiltin)).problems,
      );
      const second = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-builtin-2",
      );
      assertClean(
        "builtin-second",
        (await verifyDevtoolsHar(second.harText, expectBuiltin)).problems,
      );
      const restored = await evalChromeAsync<{
        readonly actionsEnabled: boolean | null;
        readonly frameCount: number;
      }>(
        session,
        `const [url] = arguments;
         const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
         const targetTab = browserWin.gBrowser.tabs.find((t) =>
           t.linkedBrowser?.currentURI?.spec?.startsWith(url)
         );
         const api = await gDevTools.getToolboxForTab(targetTab)?.getNetMonitorAPI();
         const reqs = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []);
         const stackReq = reqs.find((r) => typeof r.url === "string" && r.url.includes("stack=builtin"));
         return {
           actionsEnabled: api?.connector?.dataProvider?.actionsEnabled ?? null,
           frameCount: stackReq?.stacktrace?.length ?? 0,
         };`,
        [`${server.origin}/page.html?n=2&big=0&stack=1&key=builtin`],
      );
      if (restored.actionsEnabled !== true || restored.frameCount < DEVTOOLS_STACK_FRAMES.length) {
        throw new Error(
          `Hark did not restore panel actions/frames after built-in failure: ${JSON.stringify(restored)}`,
        );
      }
      await session.closeTab(tabHandle);
    }

    // Large panel (2,000 requests) exports under 30s with every body and stack intact
    let export2kMs = 0;
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=2000&big=0&stack=1&key=panel2k",
        server.origin,
        "netmonitor",
      );
      await evalChromeAsync<void>(
        session,
        `const [url] = arguments;
         const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
         const targetTab = browserWin.gBrowser.tabs.find((t) =>
           t.linkedBrowser?.currentURI?.spec?.startsWith(url)
         );
         const api = await gDevTools.getToolboxForTab(targetTab).getNetMonitorAPI();
         for (let i = 0; i < 200; i += 1) {
           const reqs = Array.from(api.store.getState().requests.requests.values());
           if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/1999") && r.totalTime !== undefined)) break;
           await new Promise((r) => setTimeout(r, 100));
         }`,
        [`${server.origin}/page.html?n=2000&big=0&stack=1&key=panel2k`],
      );
      const taken = server.takeRequests();
      const exported = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-panel-2000",
      );
      export2kMs = exported.exportMs;
      if (export2kMs >= 30_000) {
        throw new Error(`2,000-request panel export took ${String(export2kMs)}ms (>= 30000ms)`);
      }
      const res = await verifyDevtoolsHar(exported.harText, {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "panel2k",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        stackUrlIncludes: "/text.txt?stack=panel2k",
        expectedFrames: DEVTOOLS_STACK_FRAMES,
        requireDevtoolsSources: true,
        requireK6: false,
      });
      assertClean("panel-2000", res.problems);
      await session.closeTab(tabHandle);
    }

    // Persist Logs across one navigation (2,000 requests from gone page) exports under 30s
    let persist2kMs = 0;
    {
      await evalChromeAsync<void>(
        session,
        `Services.prefs.setBoolPref("devtools.netmonitor.persistlog", true);`,
      );
      try {
        server.takeRequests();
        const firstUrl = "/page.html?n=2000&big=0&stack=1&key=persist2k";
        const { tabHandle, tabId } = await openToolboxAndWaitReady(
          session,
          page,
          firstUrl,
          server.origin,
          "netmonitor",
        );
        await evalChromeAsync<void>(
          session,
          `const [url] = arguments;
           const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
           const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
           const targetTab = browserWin.gBrowser.tabs.find((t) =>
             t.linkedBrowser?.currentURI?.spec?.startsWith(url)
           );
           const api = await gDevTools.getToolboxForTab(targetTab).getNetMonitorAPI();
           for (let i = 0; i < 200; i += 1) {
             const reqs = Array.from(api.store.getState().requests.requests.values());
             if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/1999") && r.totalTime !== undefined)) break;
             await new Promise((r) => setTimeout(r, 100));
           }`,
          [`${server.origin}${firstUrl}`],
        );
        await session.navigateTab(tabHandle, `${server.origin}/page.html?n=5&big=0&key=persistnav`);
        await session.evaluate(tabHandle, "window.__devtoolsPageReady");
        await evalChromeAsync<void>(
          session,
          `const [tabId] = arguments;
           const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
           const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
           const targetTab = ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
           const api = await gDevTools.getToolboxForTab(targetTab).getNetMonitorAPI();
           for (let i = 0; i < 150; i += 1) {
             const reqs = Array.from(api.store.getState().requests.requests.values());
             if (
               reqs.some(
                 (r) =>
                   typeof r.url === "string" &&
                   r.url.includes("/s/4?k=persistnav") &&
                   r.totalTime !== undefined,
               ) &&
               reqs.filter((r) => typeof r.url === "string" && r.url.includes("persistnav")).length >=
                 9 &&
               reqs
                 .filter((r) => typeof r.url === "string" && r.url.includes("persistnav"))
                 .every((r) => r.totalTime !== undefined)
             ) {
               break;
             }
             await new Promise((r) => setTimeout(r, 100));
           }
           await new Promise((r) => setTimeout(r, 300));`,
          [tabId],
        );
        const taken = server.takeRequests();
        const exported = await exportTabAndReadHar(
          page,
          workspace.downloads,
          tabId,
          "devtools-persistlog-2000",
        );
        persist2kMs = exported.exportMs;
        if (persist2kMs >= 30_000) {
          throw new Error(
            `2,000-request Persist Logs export took ${String(persist2kMs)}ms (>= 30000ms)`,
          );
        }
        const res = await verifyDevtoolsHar(exported.harText, {
          server,
          expectedLog: taken,
          entries: taken.length,
          key: "persist2k",
          sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
          requireHeadersAndTimings: true,
          requireDevtoolsSources: true,
          requireK6: false,
        });
        assertClean("persistlog-2000", res.problems);
        await session.closeTab(tabHandle);
      } finally {
        await evalChromeAsync<void>(
          session,
          `Services.prefs.clearUserPref("devtools.netmonitor.persistlog");`,
        );
      }
    }

    // Mid-download large body in non-private window: never zero-pads, completed bodies byte-exact
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=8&big=0&slow=4000000&slowms=4000&key=midslow",
        server.origin,
        "netmonitor",
      );
      await server.waitForPath("/slow/4000000");
      const taken = server.takeRequests();
      const { harText } = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-mid-slow",
      );
      await session.evaluate(tabHandle, "window.__slowPromise");
      const res = await verifyDevtoolsHar(harText, {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "midslow",
        allowMissingUrlIncludes: "/slow/",
        allowMissingReasons: ["in-progress", "devtools-truncated"],
        requireDevtoolsSources: true,
        requireK6: false,
      });
      assertClean("mid-download-nonprivate", res.problems, harText);
      await session.closeTab(tabHandle);
    }

    // data: image excluded from entries, counted in notNetwork["data:"], k6 converts cleanly
    {
      server.takeRequests();
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        "/page.html?n=2&big=0&data=1&key=data",
        server.origin,
        "netmonitor",
      );
      const taken = server.takeRequests();
      const expectData: DevtoolsVerifyExpectation = {
        server,
        expectedLog: taken,
        entries: taken.length,
        key: "data",
        otherKey: "stack",
        sources: { both: taken.length, recordingOnly: 0, devtoolsOnly: 0 },
        notNetworkDataMin: 1,
        requireDevtoolsSources: true,
        workDir,
      };
      const { harText } = await exportTabAndReadHar(
        page,
        workspace.downloads,
        tabId,
        "devtools-data",
      );
      const res = await verifyDevtoolsHar(harText, expectData);
      assertClean("data-uri-counting", res.problems);
      await assertBrokenHarFails("addDataEntry", DEVTOOLS_FAULTS.addDataEntry(harText), expectData);
      await assertBrokenHarFails(
        "dropNotNetworkCount",
        DEVTOOLS_FAULTS.dropNotNetworkCount(harText),
        expectData,
      );
      await session.closeTab(tabHandle);
    }

    // Normal-window reload race at 0ms, 100ms, 400ms: headers & timings filled from recording (0 empty)
    const normalRaceSummary: string[] = [];
    for (const delay of [0, 100, 400]) {
      server.takeRequests();
      const raceKey = `nrace${String(delay)}`;
      const { tabHandle, tabId } = await openToolboxAndWaitReady(
        session,
        page,
        `/page.html?n=300&big=0&key=${raceKey}`,
        server.origin,
        "netmonitor",
      );
      await evalChromeAsync<void>(
        session,
        `const [tabId] = arguments;
         const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
         const api = await gDevTools.getToolboxForTab(ExtensionParent.apiManager.global.tabTracker.getTab(tabId)).getNetMonitorAPI();
         for (let i = 0; i < 200; i += 1) {
           const reqs = Array.from(api.store.getState().requests.requests.values());
           if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/299") && r.totalTime !== undefined)) break;
           await new Promise((r) => setTimeout(r, 100));
         }
         await new Promise((r) => setTimeout(r, 300));`,
        [tabId],
      );
      const takenRace = server.takeRequests();
      const fileName = `devtools-nrace-${String(delay)}ms`;
      const job = await startExport(page, {
        selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName,
      });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await evalChromeAsync<void>(
        session,
        `const [tabId] = arguments;
         const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
         const targetTab = ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
         if (!targetTab) throw new Error("normal race tab missing");
         targetTab.linkedBrowser.reload();`,
        [tabId],
      );
      const doneRace = await waitForJob(page, job.id, ended);
      if (doneRace.state.kind !== "done") {
        throw new Error(`Normal race ${String(delay)}ms failed: ${JSON.stringify(doneRace.state)}`);
      }
      const raceHar = readDownloadedHar(workspace.downloads, fileName);
      const expectNormalRace: DevtoolsVerifyExpectation = {
        server,
        expectedLog: takenRace,
        entriesMin: takenRace.length,
        key: raceKey,
        sources: { both: takenRace.length, devtoolsOnly: 0 },
        requireHeadersAndTimings: true,
        allowReloadExtraEntries: true,
        requireDevtoolsSources: true,
        requireK6: false,
      };
      const raceRes = await verifyDevtoolsHar(raceHar, expectNormalRace);
      assertClean(`normal-reload-race-${String(delay)}ms`, raceRes.problems, raceHar);
      await assertBrokenHarFails(
        `stripHeadersAndTimings-${String(delay)}ms`,
        DEVTOOLS_FAULTS.stripHeadersAndTimings(raceHar),
        expectNormalRace,
      );
      normalRaceSummary.push(
        `${String(delay)}ms=${String(raceRes.entries)}/${String(takenRace.length)} (unflagged=${String(raceRes.unflaggedEmptyHeaders)}/${String(raceRes.unflaggedEmptyTimings)})`,
      );
      await waitForReloadServed(server, raceKey, takenRace);
      await session.closeTab(tabHandle);
    }

    await evalChromeAsync<{ readonly id: string; readonly permissions: readonly string[] }>(
      session,
      `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const addons = await AddonManager.getAllAddons();
       const ours = addons.find((a) => a.type === "extension" && a.isActive && a.id.includes("hark"));
       if (!ours) throw new Error("Extension addon not found");
       const ext = ExtensionParent.GlobalManager.getExtension(ours.id);
       await ExtensionPermissions.add(ours.id, { permissions: ["internal:privateBrowsingAllowed"], origins: [] }, ext);
       await ExtensionParent.StartupCache?._saveNow?.();
       const perms = await ExtensionPermissions.get(ours.id);
       await new Promise((r) => setTimeout(r, 500));
       return { id: ours.id, permissions: perms.permissions };`,
    );
    await session.quit();

    // Session B: Private window (DevTools-only + bodyLimit=0 LongStringActor slice streaming + dead actors)
    await using privSession = await workspace.launch({ ...baseLaunch, extensionPath: null });
    const privState = await evalChromeAsync<{
      readonly permissions: readonly string[];
      readonly allowed: boolean | null;
    }>(
      privSession,
      `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const addons = await AddonManager.getAllAddons();
       const ours = addons.find((a) => a.type === "extension" && a.isActive && a.id.includes("hark"));
       if (!ours) throw new Error("Extension addon not found in Session B");
       const perms = await ExtensionPermissions.get(ours.id);
       const ext = ExtensionParent.GlobalManager.getExtension(ours.id);
       return { permissions: perms.permissions, allowed: ext?.privateBrowsingAllowed ?? null };`,
    );
    if (privState.allowed !== true) {
      throw new Error(`Session B missing privateBrowsingAllowed: ${JSON.stringify(privState)}`);
    }
    const privPage = await openExtensionPage(privSession, context.extensionPath);

    // Private window with default bodyLimit: DevTools-only + big.bin omitted as devtools-truncated
    server.takeRequests();
    const privWinRes = await evalChromeAsync<{ readonly tabId: number }>(
      privSession,
      `const [blankUrl, pageUrl] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       let phase = "open";
       let lastReqs = [];
       let timerId;
       const timeoutPromise = new Promise((_, reject) => {
         timerId = setTimeout(() => {
           reject(new Error("privWinRes stuck at phase=" + phase + " reqs=" + JSON.stringify(lastReqs)));
         }, 20000);
       });
       const run = (async () => {
         const win = OpenBrowserWindow({ private: true });
         phase = "wait-load";
         if (!win.gBrowser) {
           await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
         }
         phase = "delayed-startup";
         await win.delayedStartupPromise;
         phase = "add-tab";
         const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         win.gBrowser.selectedTab = tab;
         await new Promise((r) => setTimeout(r, 200));
         phase = "show-toolbox";
         await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
         phase = "get-api";
         await gDevTools.getToolboxForTab(tab).getNetMonitorAPI();
         phase = "load-page";
         win.gBrowser.fixupAndLoadURIString(pageUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         phase = "poll-reqs";
         for (let i = 0; i < 150; i += 1) {
           const api = await gDevTools.getToolboxForTab(tab)?.getNetMonitorAPI();
           const reqs = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []);
           lastReqs = reqs.map((r) => [r.url, r.totalTime ?? null]);
           const bigDone = reqs.some((r) => typeof r.url === "string" && r.url.includes("/big.bin") && r.totalTime !== undefined);
           const s1Done = reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/1") && r.totalTime !== undefined);
           if (bigDone && s1Done) break;
           await new Promise((r) => setTimeout(r, 100));
         }
         await new Promise((r) => setTimeout(r, 500));
         return { tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab) };
       })();
       try {
         return await Promise.race([run, timeoutPromise]);
       } finally {
         clearTimeout(timerId);
       }`,
      ["about:blank", `${server.origin}/page.html?n=2&big=1&key=privtrunc`],
    );
    const takenPrivTrunc = server.takeRequests();
    const { harText: privTruncHar, popup: privTruncPopup } = await exportTabAndReadHar(
      privPage,
      workspace.downloads,
      privWinRes.tabId,
      "devtools-priv-trunc",
    );
    const expectPrivTrunc: DevtoolsVerifyExpectation = {
      server,
      expectedLog: takenPrivTrunc,
      entries: takenPrivTrunc.length,
      key: "privtrunc",
      sources: { both: 0, recordingOnly: 0, devtoolsOnly: takenPrivTrunc.length },
      expectTruncatedBig: true,
      requireDevtoolsSources: true,
      workDir,
    };
    assertClean(
      "private-truncated",
      (await verifyDevtoolsHar(privTruncHar, expectPrivTrunc)).problems,
      privTruncHar,
    );
    const privTruncSources = extractSources(privTruncPopup);
    if (privTruncSources.devtoolsOnly !== takenPrivTrunc.length) {
      throw new Error(
        `Private popup devtoolsOnly=${String(privTruncSources.devtoolsOnly)} != ${String(takenPrivTrunc.length)}`,
      );
    }
    const leakedPrivLines = workspace
      .lines()
      .filter((line) => JSON.stringify(line).includes("privtrunc"));
    if (leakedPrivLines.length > 0) {
      throw new Error(
        `Private browsing request leaked into archive: ${String(leakedPrivLines.length)} lines`,
      );
    }

    // Private window with devtools.netmonitor.bodyLimit = 0 streams 50 MB via LongStringActor slices
    server.takeRequests();
    const privStreamRes = await evalChromeAsync<{ readonly tabId: number }>(
      privSession,
      `const [blankUrl, pageUrl] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
       Services.prefs.setIntPref("devtools.netmonitor.bodyLimit", 0);
       const win = Array.from(Services.wm.getEnumerator("navigator:browser")).find((w) =>
         PrivateBrowsingUtils.isWindowPrivate(w)
       );
       const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       win.gBrowser.selectedTab = tab;
       await new Promise((r) => win.setTimeout(r, 200));
       await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
       await gDevTools.getToolboxForTab(tab).getNetMonitorAPI();
       win.gBrowser.fixupAndLoadURIString(pageUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       for (let i = 0; i < 200; i += 1) {
         const api = await gDevTools.getToolboxForTab(tab)?.getNetMonitorAPI();
         const reqs = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []);
         const bigReq = reqs.find((r) => typeof r.url === "string" && r.url.includes("/big.bin") && r.totalTime !== undefined && r.responseContentAvailable);
         const s1Done = reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/1") && r.totalTime !== undefined && r.responseContentAvailable);
         if (bigReq && s1Done) break;
         await new Promise((r) => win.setTimeout(r, 100));
       }
       await new Promise((r) => win.setTimeout(r, 500));
       return { tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab) };`,
      ["about:blank", `${server.origin}/page.html?n=2&big=1&key=privstream`],
    );
    const takenPrivStream = server.takeRequests();
    const { harText: privStreamHar } = await exportTabAndReadHar(
      privPage,
      workspace.downloads,
      privStreamRes.tabId,
      "devtools-priv-stream",
    );
    const expectPrivStream: DevtoolsVerifyExpectation = {
      server,
      expectedLog: takenPrivStream,
      entries: takenPrivStream.length,
      key: "privstream",
      sources: { both: 0, recordingOnly: 0, devtoolsOnly: takenPrivStream.length },
      expectTruncatedBig: false,
      requireDevtoolsSources: true,
      requireK6: false,
    };
    assertClean(
      "private-stream-50mb",
      (await verifyDevtoolsHar(privStreamHar, expectPrivStream)).problems,
      privStreamHar,
    );
    const bigEntry = (JSON.parse(privStreamHar) as DevtoolsHarDocument).log.entries.find((e) =>
      e.request.url.includes("/big.bin"),
    );
    if (
      bigEntry === undefined ||
      bigEntry.response.content.size !== DEVTOOLS_GROUND_TRUTH["big.bin"].size
    ) {
      throw new Error("Private stream 50MB big.bin entry missing or wrong size");
    }

    // Mid-download large body in private window: never zero-pads or marks present with bad SHA
    server.takeRequests();
    const privSlowRes = await evalChromeAsync<{ readonly tabId: number }>(
      privSession,
      `const [blankUrl, pageUrl] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
       Services.prefs.clearUserPref("devtools.netmonitor.bodyLimit");
       const win = Array.from(Services.wm.getEnumerator("navigator:browser")).find((w) =>
         PrivateBrowsingUtils.isWindowPrivate(w)
       );
       const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       win.gBrowser.selectedTab = tab;
       await new Promise((r) => win.setTimeout(r, 200));
       await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
       await gDevTools.getToolboxForTab(tab).getNetMonitorAPI();
       win.gBrowser.fixupAndLoadURIString(pageUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       for (let i = 0; i < 150; i += 1) {
         const api = await gDevTools.getToolboxForTab(tab)?.getNetMonitorAPI();
         const reqs = Array.from(api?.store?.getState()?.requests?.requests?.values?.() ?? []);
         if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/slow/4000000"))) break;
         await new Promise((r) => win.setTimeout(r, 50));
       }
       return { tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab) };`,
      ["about:blank", `${server.origin}/page.html?n=4&big=0&slow=4000000&slowms=3000&key=privslow`],
    );
    await server.waitForPath("/slow/4000000");
    const takenPrivSlow = server.takeRequests();
    const { harText: privSlowHar } = await exportTabAndReadHar(
      privPage,
      workspace.downloads,
      privSlowRes.tabId,
      "devtools-priv-mid-slow",
    );
    assertClean(
      "private-mid-download-slow",
      (
        await verifyDevtoolsHar(privSlowHar, {
          server,
          expectedLog: takenPrivSlow,
          entries: takenPrivSlow.length,
          key: "privslow",
          sources: { both: 0, recordingOnly: 0, devtoolsOnly: takenPrivSlow.length },
          allowMissingUrlIncludes: "/slow/",
          allowMissingReasons: ["in-progress", "devtools-truncated"],
          requireDevtoolsSources: true,
          requireK6: false,
        })
      ).problems,
      privSlowHar,
    );

    // Real reload race at 0ms, 100ms, 400ms plus dead-actor stubs
    const raceSummary: string[] = [];
    for (const delay of [0, 100, 400]) {
      server.takeRequests();
      const raceKey = `race${String(delay)}`;
      const raceTab = await evalChromeAsync<{ readonly tabId: number }>(
        privSession,
        `const [blankUrl, pageUrl] = arguments;
         const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
         const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
         const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
         const win = Array.from(Services.wm.getEnumerator("navigator:browser")).find((w) =>
           PrivateBrowsingUtils.isWindowPrivate(w)
         );
         const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         win.gBrowser.selectedTab = tab;
         await new Promise((r) => win.setTimeout(r, 200));
         await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
         const api = await gDevTools.getToolboxForTab(tab).getNetMonitorAPI();
         win.gBrowser.fixupAndLoadURIString(pageUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         for (let i = 0; i < 200; i += 1) {
           const reqs = Array.from(api.store.getState().requests.requests.values());
           if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/299") && r.totalTime !== undefined)) break;
           await new Promise((r) => win.setTimeout(r, 100));
         }
         await new Promise((r) => win.setTimeout(r, 300));
         return { tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab) };`,
        ["about:blank", `${server.origin}/page.html?n=300&big=0&key=${raceKey}`],
      );
      const takenRace = server.takeRequests();
      const fileName = `devtools-race-${String(delay)}ms`;
      const job = await startExport(privPage, {
        selection: {
          scope: "tab",
          tabId: raceTab.tabId,
          range: { kind: "since-tab-opened" },
          include: "all",
        },
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName,
      });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await evalChromeAsync<void>(
        privSession,
        `const [tabId] = arguments;
         const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
         const targetTab = ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
         if (!targetTab) throw new Error("race tab missing");
         targetTab.linkedBrowser.reload();`,
        [raceTab.tabId],
      );
      const doneRace = await waitForJob(privPage, job.id, ended);
      if (doneRace.state.kind !== "done") {
        throw new Error(`Race export ${String(delay)}ms failed: ${JSON.stringify(doneRace.state)}`);
      }
      const raceHar = readDownloadedHar(workspace.downloads, fileName);
      const expectPrivRace: DevtoolsVerifyExpectation = {
        entriesMin: takenRace.length,
        key: raceKey,
        stubs: { minCount: 1 },
        checkMetadataFlags: true,
        requireDevtoolsSources: true,
        requireK6: false,
      };
      const raceRes = await verifyDevtoolsHar(raceHar, expectPrivRace);
      assertClean(`reload-race-${String(delay)}ms`, raceRes.problems, raceHar);
      await assertBrokenHarFails(
        `stripMetadataFlags-${String(delay)}ms`,
        DEVTOOLS_FAULTS.stripMetadataFlags(raceHar),
        expectPrivRace,
      );
      raceSummary.push(
        `${String(delay)}ms=${String(raceRes.entries)}/${String(takenRace.length)} (unflagged=${String(raceRes.unflaggedEmptyHeaders)}/${String(raceRes.unflaggedEmptyTimings)})`,
      );
      await waitForReloadServed(server, raceKey, takenRace);
    }

    // Destroyed/discarded actors produce devtools-discarded stubs, not a 0-byte HAR
    server.takeRequests();
    const deadActorRes = await evalChromeAsync<{
      readonly tabId: number;
      readonly released: number;
    }>(
      privSession,
      `const [blankUrl, url1] = arguments;
       const { gDevTools } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs").require("resource://devtools/client/framework/devtools.js");
       const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
       const win = Array.from(Services.wm.getEnumerator("navigator:browser")).find((w) =>
         PrivateBrowsingUtils.isWindowPrivate(w)
       );
       const tab = win.gBrowser.addTab(blankUrl, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       win.gBrowser.selectedTab = tab;
       await new Promise((r) => setTimeout(r, 200));
       await gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" });
       const toolbox = gDevTools.getToolboxForTab(tab);
       const api = await toolbox.getNetMonitorAPI();
       win.gBrowser.fixupAndLoadURIString(url1, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       for (let i = 0; i < 150; i += 1) {
         const reqs = Array.from(api.store.getState().requests.requests.values());
         if (reqs.some((r) => typeof r.url === "string" && r.url.includes("/s/0") && r.url.includes("dead1") && r.totalTime !== undefined)) break;
         await new Promise((r) => setTimeout(r, 100));
       }
       await new Promise((r) => setTimeout(r, 300));
       const client = toolbox.commands?.client ?? api.connector?.commands?.client;
       const reqs = Array.from(api.store.getState().requests.requests.values());
       let released = 0;
       for (const req of reqs) {
         if (typeof req.url === "string" && (req.url.includes("/text.txt") || req.url.includes("/mid.bin"))) {
           const actorId = req.actor ?? req.id;
           if (client && typeof actorId === "string") {
             await client.request({ to: actorId, type: "release" }).catch(() => null);
           }
           const front = client?.getFrontByID?.(actorId);
           await front?.destroy?.().catch(() => null);
           released += 1;
         }
       }
       if (released === 0) throw new Error("No actors found to release for dead-actors check");
       return { tabId: ExtensionParent.apiManager.global.tabTracker.getId(tab), released };`,
      ["about:blank", `${server.origin}/page.html?n=1&big=0&key=dead1`],
    );
    const { harText: deadHar } = await exportTabAndReadHar(
      privPage,
      workspace.downloads,
      deadActorRes.tabId,
      "devtools-dead-actors",
    );
    const expectDead: DevtoolsVerifyExpectation = {
      server,
      key: "dead",
      stubs: { minCount: 1 },
      checkMetadataFlags: true,
      requireDevtoolsSources: true,
      workDir,
    };
    assertClean(
      "dead-actors-stubs",
      (await verifyDevtoolsHar(deadHar, expectDead)).problems,
      deadHar,
    );

    await privSession.quit();

    return {
      name: this.name,
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: `Passed sorted-by-size, inspector priming, 50MB recording fill, built-in export recovery, 2k panel in ${String(export2kMs)}ms, persistlog-2k in ${String(persist2kMs)}ms, mid-download slow body (normal+private), normal reload race (${normalRaceSummary.join(", ")}), private reload race (${raceSummary.join(", ")}), private DevTools-only + slicing, dead-actor stubs, 2x stack frames, and data: counting.`,
    };
  },
};

/** @discovered-check */
export default check;
