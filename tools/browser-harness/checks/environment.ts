import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import {
  launchBrowser,
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserIdentity,
  type BrowserSession,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";

export type ReportedEnvironment = {
  readonly browser: {
    readonly name: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly toolbox:
    | { readonly open: true; readonly host: string }
    | { readonly open: false; readonly reason: string };
};

const SCHEMA_REFUSAL = "Incorrect argument types for hark.getEnvironment.";

const REFUSED_CALLS: ReadonlyArray<{
  readonly call: string;
  readonly argumentList: string;
  readonly message: string;
}> = [
  { call: "no argument", argumentList: "", message: SCHEMA_REFUSAL },
  {
    call: "a negative integer",
    argumentList: "-1",
    message: "Integer -1 is too small (must be at least 0)",
  },
  { call: "a float", argumentList: "1.5", message: SCHEMA_REFUSAL },
  { call: "a numeric string", argumentList: '"1"', message: SCHEMA_REFUSAL },
  { call: "a path string", argumentList: '"/etc/passwd"', message: SCHEMA_REFUSAL },
  { call: "null", argumentList: "null", message: SCHEMA_REFUSAL },
  {
    call: "an object whose toString returns 1",
    argumentList: '{ toString() { return "1" } }',
    message: SCHEMA_REFUSAL,
  },
  { call: "an extra argument", argumentList: "0, 'extra'", message: SCHEMA_REFUSAL },
];

/** The popup's source line with a toolbox open on its tab, written here so a change to it fails the check. */
const DEVTOOLS_SOURCE_LINE =
  "Includes what the open DevTools panel captured. Bodies DevTools dropped are filled in from the background recording.";

/**
 * The popup page, opened in its own tab, reads that tab: nothing is recorded there, so it draws `empty-tab` until a
 * toolbox opens on it, and then the rows with the DevTools source line.
 */
const STEPS: ReadonlyArray<{
  readonly step: string;
  readonly act?: string;
  readonly toolbox: (host: string) => ReportedEnvironment["toolbox"];
  readonly text: (host: string) => string;
}> = [
  {
    step: "before DevTools starts",
    toolbox: () => ({ open: false, reason: "devtools-not-started" }),
    text: () => "empty-tab",
  },
  {
    step: "toolbox open on the tab",
    act: `const done = arguments[arguments.length - 1];
          const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
          const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
          gDevTools.showToolboxForTab(window.gBrowser.selectedTab, { toolId: "netmonitor" })
            .then((tb) => done(tb.hostType), (err) => done({ error: String(err) }));`,
    toolbox: (host) => ({ open: true, host }),
    text: () => `ready: ${DEVTOOLS_SOURCE_LINE}`,
  },
  {
    step: "toolbox closed again",
    act: `const done = arguments[arguments.length - 1];
          const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
          const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
          gDevTools.closeToolboxForTab(window.gBrowser.selectedTab)
            .then(() => done(null), (err) => done({ error: String(err) }));`,
    toolbox: () => ({ open: false, reason: "no-toolbox-for-tab" }),
    text: () => "empty-tab",
  },
];

export function verifyBrowserIdentity(
  actual: ReportedEnvironment["browser"],
  expected: Pick<BrowserIdentity, "name" | "version" | "buildId">,
): string | null {
  const mismatches: string[] = [];
  if (actual.name.toLowerCase() !== expected.name.toLowerCase()) {
    mismatches.push(`name expected ${expected.name} got ${actual.name}`);
  }
  if (actual.version !== expected.version) {
    mismatches.push(`version expected ${expected.version} got ${actual.version}`);
  }
  if (actual.buildId !== expected.buildId) {
    mismatches.push(`buildId expected ${expected.buildId} got ${actual.buildId}`);
  }
  return mismatches.length === 0 ? null : mismatches.join("; ");
}

export async function callGetEnvironment(
  session: Pick<BrowserSession, "evaluate">,
  context: string,
  argumentList: string | null,
): Promise<ReportedEnvironment | { readonly error: string }> {
  const expression = `(async () => {
    try {
      const list = ${argumentList === null ? "[(await browser.tabs.query({ active: true, currentWindow: true }))[0].id]" : `[${argumentList}]`};
      const env = await browser.hark.getEnvironment(...list);
      return JSON.stringify(env);
    } catch (error) {
      return JSON.stringify({ error: String(error) });
    }
  })()`;
  return JSON.parse(await session.evaluate(context, expression)) as
    | ReportedEnvironment
    | { error: string };
}

/** The popup's view, and its source line when it draws one: `empty-tab`, or `ready: <line>`. */
export async function readPopupView(
  session: Pick<BrowserSession, "evaluate">,
  context: string,
): Promise<string> {
  return session.evaluate(
    context,
    `new Promise((resolve, reject) => {
      const read = () => {
        const view = document.querySelector(".popup[data-view]")?.dataset.view;
        if (view === undefined) return null;
        const source = document.querySelector(".src");
        return source === null ? view : view + ": " + source.textContent.trim();
      };
      const immediate = read();
      if (immediate !== null) { resolve(immediate); return; }
      const observer = new MutationObserver(() => {
        const text = read();
        if (text !== null) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(text);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("the popup drew no view"));
      }, 15000);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    })`,
  );
}

export async function runEnvironmentVerification(
  context: CheckContext,
  overrides: {
    readonly expectedIdentity?: Pick<BrowserIdentity, "name" | "version" | "buildId">;
    readonly alterEnvironment?: (env: ReportedEnvironment) => ReportedEnvironment;
    readonly launch?: typeof launchBrowser;
  } = {},
): Promise<CheckResult> {
  const started = Date.now();
  if (context.extensionPath === null || !NodeFS.existsSync(context.extensionPath)) {
    return {
      name: "environment",
      ok: false,
      durationMs: Date.now() - started,
      detail:
        context.extensionPath === null
          ? "missing --extension path for environment check"
          : `extension path does not exist for environment check: ${context.extensionPath}`,
    };
  }
  const addonId = await readExtensionId(context.extensionPath);
  const popupPath = await readExtensionPopupPath(context.extensionPath);
  const launch = overrides.launch ?? launchBrowser;
  await using session = await launch({
    binaryPath: context.binaryPath,
    extensionPath: context.extensionPath,
    display: context.display,
    protocol: "marionette",
    allowSystemAccess: true,
    signal: context.signal,
  });

  const popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
  const tab = await session.openTab(popupUrl);
  const failures: string[] = [];
  const checkEqual = (label: string, actual: unknown, expected: unknown): void => {
    if (!NodeUtil.isDeepStrictEqual(actual, expected)) {
      failures.push(`${label}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
    }
  };

  try {
    const expectedIdentity = overrides.expectedIdentity ?? session.identity;
    const unknownTab = await callGetEnvironment(session, tab, "2147483647");
    checkEqual(
      "unknown tab ID: toolbox",
      "toolbox" in unknownTab ? unknownTab.toolbox : unknownTab,
      { open: false, reason: "no-such-tab" },
    );
    const smallestTab = await callGetEnvironment(session, tab, "0");
    checkEqual("tab ID 0: toolbox", "toolbox" in smallestTab ? smallestTab.toolbox : smallestTab, {
      open: false,
      reason: "no-such-tab",
    });

    for (const { call, argumentList, message } of REFUSED_CALLS) {
      const result = await callGetEnvironment(session, tab, argumentList);
      const actual =
        "error" in result
          ? result.error.includes(message)
            ? `refused: ${message}`
            : result.error
          : result;
      checkEqual(`${call} refused by schema`, actual, `refused: ${message}`);
    }

    let host = "";
    for (const step of STEPS) {
      if (step.act !== undefined) {
        const nextHost = await session.evaluateChrome(step.act);
        if (typeof nextHost === "object" && nextHost !== null && "error" in nextHost) {
          throw new Error(`chrome action failed in ${step.step}: ${JSON.stringify(nextHost)}`);
        }
        if (typeof nextHost === "string") host = nextHost;
      }
      await session.reloadTab(tab);
      const popupView = await readPopupView(session, tab);
      const rawEnv = await callGetEnvironment(session, tab, null);
      if ("error" in rawEnv) {
        failures.push(`${step.step}: getEnvironment failed: ${rawEnv.error}`);
        continue;
      }
      const env = overrides.alterEnvironment ? overrides.alterEnvironment(rawEnv) : rawEnv;
      const identityProblem = verifyBrowserIdentity(env.browser, expectedIdentity);
      if (identityProblem !== null) failures.push(`${step.step}: browser: ${identityProblem}`);
      checkEqual(`${step.step}: toolbox`, env.toolbox, step.toolbox(host));
      checkEqual(`${step.step}: popup view`, popupView, step.text(host));
    }
  } finally {
    await session.closeTab(tab).catch(() => undefined);
    await session.quit().catch(() => undefined);
  }

  return {
    name: "environment",
    ok: failures.length === 0,
    durationMs: Date.now() - started,
    detail:
      failures.length === 0
        ? `verified ${session.identity.name} ${session.identity.version} (${session.identity.buildId})`
        : failures.join("; "),
    data: { identity: session.identity, failures },
  };
}

const check: HarnessCheck = {
  name: "environment",
  description:
    "verifies getEnvironment() against session capabilities, schema refusals, and DevTools state",
  run: (context) => runEnvironmentVerification(context),
};

/** @discovered-check */
export default check;
