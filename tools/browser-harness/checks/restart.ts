import * as NodeFS from "node:fs";
import {
  launchBrowser,
  prepareProfile,
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { hostProcessIo, removeDirectoryBounded } from "../src/owned-process.ts";
import { callGetEnvironment, readPopupView, verifyBrowserIdentity } from "./environment.ts";

export async function runRestartVerification(
  context: CheckContext,
  options: {
    readonly dropExtensionOnRestart?: boolean;
    readonly launch?: typeof launchBrowser;
  } = {},
): Promise<CheckResult> {
  const started = Date.now();
  if (context.extensionPath === null || !NodeFS.existsSync(context.extensionPath)) {
    return {
      name: "restart",
      ok: false,
      durationMs: Date.now() - started,
      detail:
        context.extensionPath === null
          ? "missing --extension path for restart check"
          : `extension path does not exist for restart check: ${context.extensionPath}`,
    };
  }
  const addonId = await readExtensionId(context.extensionPath);
  const popupPath = await readExtensionPopupPath(context.extensionPath);

  await using stack = new AsyncDisposableStack();
  const profileDir = await prepareProfile(context.extensionPath);
  stack.defer(() => removeDirectoryBounded(hostProcessIo(), profileDir));
  const launch = options.launch ?? launchBrowser;

  const verifyLaunch = async (phase: string): Promise<string> => {
    await using session = await launch({
      binaryPath: context.binaryPath,
      extensionPath: null,
      profileDir,
      display: context.display,
      protocol: "marionette",
      allowSystemAccess: true,
      signal: context.signal,
    });
    let popupUrl: string;
    try {
      popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
    } catch (error) {
      throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const tab = await session.openTab(popupUrl);
    try {
      const env = await callGetEnvironment(session, tab, null);
      if ("error" in env) throw new Error(`${phase}: getEnvironment failed: ${env.error}`);
      const problem = verifyBrowserIdentity(env.browser, session.identity);
      if (problem !== null) throw new Error(`${phase}: ${problem}`);
      if (env.toolbox.open || env.toolbox.reason !== "devtools-not-started") {
        throw new Error(`${phase}: unexpected toolbox ${JSON.stringify(env.toolbox)}`);
      }
      const view = await readPopupView(session, tab);
      if (view !== "empty-tab") throw new Error(`${phase}: the popup drew ${view}, not empty-tab`);
      return `${session.identity.name} ${session.identity.version} (${session.identity.buildId})`;
    } finally {
      await session.closeTab(tab).catch(() => undefined);
      await session.quit().catch(() => undefined);
    }
  };

  const first = await verifyLaunch("initial launch");
  if (options.dropExtensionOnRestart === true) {
    // Negative case: remove the installed XPI from the profile before restart.
    const entries = NodeFS.readdirSync(`${profileDir}/extensions`);
    for (const entry of entries)
      NodeFS.rmSync(`${profileDir}/extensions/${entry}`, { force: true });
  }
  const second = await verifyLaunch("after restart");

  return {
    name: "restart",
    ok: true,
    durationMs: Date.now() - started,
    detail: `extension still active after restart on the same profile (${first} -> ${second})`,
  };
}

const check: HarnessCheck = {
  name: "restart",
  description:
    "verifies the extension remains installed and active across a browser restart on the same profile",
  run: (context) => runRestartVerification(context),
};

/** @discovered-check */
export default check;
