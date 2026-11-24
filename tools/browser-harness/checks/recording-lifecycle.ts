import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ReconcileStep } from "@hark/recording/reconcile";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { ID_BIG_PATH, ID_REDIRECT_FINAL_PATH } from "../src/extended-fixtures.ts";
import { pathOf } from "../src/recording-verify.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const SLOW_DOWNLOAD = `${ID_BIG_PATH}?delayMs=600000`;
const LINE_DEADLINE_MS = 15_000;

/** Starts a download the server holds after its first 1.5 MiB, and resolves once the page has that first part. */
const startSlowDownload = async (session: BrowserSession, origin: string): Promise<void> => {
  const tab = await session.openTab(`${origin}${ID_REDIRECT_FINAL_PATH}`);
  await session.evaluate(
    tab,
    `(async () => { const reader = (await fetch("${SLOW_DOWNLOAD}")).body.getReader(); await reader.read(); window.__held = reader; return "reading"; })()`,
  );
};

const waitFor = async (ready: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + LINE_DEADLINE_MS;
  while (!ready() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  return ready();
};

/**
 * A private window writes nothing; a quit and a disable mid-download write browser-closed and recording-stopped, and
 * the next start deletes the parts they left; the first page after a restart is recorded. As a control, the private
 * window's own request, made again in a normal tab, must be recorded.
 */
const check: HarnessCheck = {
  name: "recording-lifecycle",
  description:
    "private window writes nothing; quit and disable mid-download; first page after a restart",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const problems: string[] = [];
    if (context.extensionPath === null) {
      return { name: "recording-lifecycle", ok: false, durationMs: 0, detail: "needs --extension" };
    }
    const addonId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("lifecycle");
    const marker = (name: string) => `${ID_REDIRECT_FINAL_PATH}?${name}`;
    const linesFor = (query: string) =>
      workspace.lines().filter((l) => l.exchange.request.url.endsWith(query));
    const base = {
      binaryPath: context.binaryPath,
      display: context.display,
      protocol: "marionette" as const,
      signal: context.signal,
    };

    {
      const session = await workspace.launch({ ...base, extensionPath: context.extensionPath });
      try {
        await waitForActiveExtensionUrl(session, addonId, popupPath);
        const isPrivate = await session.evaluateChrome(
          `const done = arguments[arguments.length - 1];
           const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
           const win = window.OpenBrowserWindow({ private: true });
           win.addEventListener("load", () => {
             win.gBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
             done(PrivateBrowsingUtils.isWindowPrivate(win));
           }, { once: true });`,
          [`${server.origin}${marker("private-window")}`],
        );
        if (isPrivate !== true)
          problems.push("the window opened for the private test is not private");
        if (
          !(await waitFor(() =>
            server.getRequestLog().some((r) => r.url.endsWith("private-window")),
          ))
        )
          problems.push("the private window never requested its page");
        const normal = await session.openTab(`${server.origin}${marker("normal-tab")}`);
        await session.closeTab(normal);
        await startSlowDownload(session, server.origin);
        await callHook(session, { kind: "flush" });
      } finally {
        await session.quit();
        await session[Symbol.asyncDispose]();
      }
    }
    if (linesFor("private-window").length !== 0)
      problems.push("a private window's request was recorded");
    if (linesFor("normal-tab").length !== 1)
      problems.push("the same request in a normal tab was not recorded");
    const quitLines = workspace.lines().filter((l) => pathOf(l.exchange) === ID_BIG_PATH);
    if (
      !quitLines.some(
        (l) => l.exchange.kind === "abandoned" && l.exchange.reason === "browser-closed",
      )
    )
      problems.push(
        `quit mid-download: ${JSON.stringify(quitLines.map((l) => [l.exchange.kind, "reason" in l.exchange ? l.exchange.reason : null]))}`,
      );
    const partsAfterQuit = NodeFS.readdirSync(NodePath.join(workspace.root(), "incoming"));

    {
      await using session = await workspace.launch({
        ...base,
        extensionPath: null,
        extraPrefs: [
          { name: "browser.startup.page", value: 1 },
          {
            name: "browser.startup.homepage",
            value: `${server.origin}${marker("first-after-restart")}`,
          },
        ],
      });
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const firstRecovery = (await callHook(session, {
        kind: "recovery",
      })) as readonly ReconcileStep[];
      const deleted = firstRecovery.flatMap((s) => (s.kind === "delete-part" ? [s.path] : []));
      if (
        partsAfterQuit.length === 0 ||
        !partsAfterQuit.every((part) => deleted.includes(`incoming/${part}`))
      )
        problems.push(
          `after the quit, parts ${partsAfterQuit.join(", ")} but recovery deleted ${deleted.join(", ")}`,
        );
      await waitFor(() =>
        server.getRequestLog().some((r) => r.url.endsWith("first-after-restart")),
      );
      await callHook(session, { kind: "flush" });
      const first = linesFor("first-after-restart");
      if (
        first.length !== 1 ||
        first[0]?.exchange.kind !== "answered" ||
        first[0].exchange.body.kind !== "stored"
      )
        problems.push(`first page after a restart: ${String(first.length)} lines`);

      await startSlowDownload(session, server.origin);
      await session.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
         AddonManager.getAddonByID(arguments[0]).then((addon) => addon.disable()).then(() => done(true), (e) => done(String(e)));`,
        [addonId],
      );
      const stopped = () =>
        workspace
          .lines()
          .some(
            (l) =>
              pathOf(l.exchange) === ID_BIG_PATH &&
              l.exchange.kind === "abandoned" &&
              l.exchange.reason === "recording-stopped",
          );
      if (!(await waitFor(stopped)))
        problems.push("disable mid-download wrote no recording-stopped line");
      const partsAfterDisable = NodeFS.readdirSync(NodePath.join(workspace.root(), "incoming"));
      await session.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
         AddonManager.getAddonByID(arguments[0]).then((addon) => addon.enable()).then(() => done(true), (e) => done(String(e)));`,
        [addonId],
      );
      await waitForActiveExtensionUrl(session, addonId, popupPath);
      const reenabled = (await callHook(session, { kind: "recovery" })) as readonly ReconcileStep[];
      const deletedAfterDisable = reenabled.flatMap((s) =>
        s.kind === "delete-part" ? [s.path] : [],
      );
      if (
        partsAfterDisable.length === 0 ||
        !partsAfterDisable.every((p) => deletedAfterDisable.includes(`incoming/${p}`))
      )
        problems.push(
          `after the disable, parts ${partsAfterDisable.join(", ")} but recovery deleted ${deletedAfterDisable.join(", ")}`,
        );
    }

    return {
      name: "recording-lifecycle",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? "private window wrote nothing (a normal tab's same request was recorded); quit wrote browser-closed and disable wrote recording-stopped, each part deleted at the next start; the first page after a restart was recorded"
          : problems.join("; "),
    };
  },
};

/** @discovered-check */
export default check;
