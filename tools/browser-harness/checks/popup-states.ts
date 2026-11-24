import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  readExtensionId,
  readExtensionPopupPath,
  type BrowserSession,
  type Pref,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { checkExport, validateHar } from "../src/export-verify.ts";
import { openExtensionPage, value } from "../src/export-session.ts";
import { chrome, until } from "../src/pages-driver.ts";
import { inPopup, PopupDriver, SET_THEME, type Shot } from "../src/popup-driver.ts";
import { callHook, recordingWorkspace, type RecordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "popup-states";
/** Marionette turns this off as a recommended pref; a user's browser has it on, so the popup is shown as users see it. */
const USER_DEFAULTS: readonly Pref[] = [
  { name: "security.fileuri.strict_origin_policy", value: true },
];

/** Button names as the popup shows them. Written here, not read from the product, so a renamed button fails. */
const NAMES = {
  custom: "Choose range, scope and file name",
  back: "Back",
  secrets: "Remove secrets",
} as const;

/** Every choice of Custom's time range, by its value; each one changes what the form draws. */
const CUSTOM_RANGES = [
  "since-tab-opened",
  "last-5",
  "last-15",
  "last-60",
  "today",
  "everything",
  "between",
] as const;

/**
 * Lets the add-on run in private windows, restarts it so the grant applies, and opens a private window on `url` with
 * a page of the add-on beside it. A page reaches only popups of its own principal, so the private popup is read from
 * there; its Marionette handle comes back.
 */
const PRIVATE_WINDOW = `const done = arguments[arguments.length - 1];
  const [addonId, url, pagePath] = arguments;
  (async () => {
    const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await ExtensionPermissions.add(addonId, { permissions: ["internal:privateBrowsingAllowed"], origins: [] });
    await (await AddonManager.getAddonByID(addonId)).reload();
    const win = OpenBrowserWindow({ private: true });
    await new Promise((resolve) => {
      const seen = (subject) => {
        if (subject !== win) return;
        Services.obs.removeObserver(seen, "browser-delayed-startup-finished");
        resolve();
      };
      Services.obs.addObserver(seen, "browser-delayed-startup-finished");
    });
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    const loaded = (tab, spec) =>
      new Promise((resolve) => {
        const poll = () => (tab.linkedBrowser.currentURI.spec === spec && !tab.hasAttribute("busy") ? resolve() : win.setTimeout(poll, 50));
        poll();
      });
    const policy = WebExtensionPolicy.getByID(addonId);
    while (!policy.active) await new Promise((resolve) => win.setTimeout(resolve, 50));
    const pageUrl = WebExtensionPolicy.getByID(addonId).getURL(pagePath);
    const page = win.gBrowser.addTab(pageUrl, { triggeringPrincipal: system });
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: system });
    win.gBrowser.selectedTab = tab;
    await Promise.all([loaded(page, pageUrl), loaded(tab, url)]);
    const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
    done({ ok: true, page: NavigableManager.getIdForBrowser(page.linkedBrowser) });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

/** One known failure per audit, put into the real popup DOM; the audit must name it. */
const AUDIT_FAULTS = [
  {
    name: "text #8A93A3 on white (3.1:1)",
    expect: "text contrast",
    html: `<p data-fault="" style="color:#8A93A3;background:#FFFFFF">low contrast sample</p>`,
  },
  {
    name: "an icon button with no name",
    expect: "no accessible name",
    html: `<button data-fault="" type="button" class="iconbtn"><svg class="ic" width="16" height="16"></svg></button>`,
  },
  {
    name: "an em dash in copy",
    expect: "dash U+2014",
    html: `<p data-fault="">Saved ${String.fromCodePoint(0x2014)} done</p>`,
  },
  {
    name: "an emoji in copy",
    expect: "emoji",
    html: `<p data-fault="">Saved ${String.fromCodePoint(0x1f4be)}</p>`,
  },
  { name: "a transition", expect: "motion", css: `.preset { transition: background-color 150ms }` },
  { name: "a 420 px wide popup", expect: "px wide", css: `.popup { width: 420px !important }` },
  { name: "a 700 px tall popup", expect: "px tall", css: `.pad { min-height: 700px }` },
  {
    name: "a date and time cut off in a 170 px field",
    expect: "clipped",
    html: `<input data-fault="" type="datetime-local" class="ctl" aria-label="sample" style="width:170px" value="2026-11-16T13:47">`,
  },
] as const;

async function checkAudits(
  driver: PopupDriver,
): Promise<{ caught: string[]; missed: string[]; clean: string[] }> {
  const caught: string[] = [];
  const missed: string[] = [];
  for (const fault of AUDIT_FAULTS) {
    await value(
      driver.page,
      inPopup(`const html = ${JSON.stringify("html" in fault ? fault.html : "")};
        const css = ${JSON.stringify("css" in fault ? fault.css : "")};
        if (html) w.document.querySelector(".pad").insertAdjacentHTML("beforeend", html);
        if (css) { const s = w.document.createElement("style"); s.dataset.fault = ""; s.textContent = css; w.document.head.append(s); }
        return true;`),
    );
    const { problems } = await driver.audit(false, null);
    (problems.some((p) => p.includes(fault.expect)) ? caught : missed).push(fault.name);
    await value(
      driver.page,
      inPopup(
        `for (const el of w.document.querySelectorAll("[data-fault]")) el.remove(); return true;`,
      ),
    );
  }
  const { problems: clean } = await driver.audit(false, null);
  return { caught, missed, clean };
}

const number = (text: string | null): number => Number((text ?? "").replace(/[^0-9]/gu, ""));

async function launchDriver(
  workspace: RecordingWorkspace,
  context: CheckContext,
  extensionPath: string,
  shotDir: string,
  extra: { readonly prefs?: readonly Pref[]; readonly dataHome?: string } = {},
): Promise<BrowserSession & { driver: PopupDriver }> {
  const session = await workspace.launch({
    binaryPath: context.binaryPath,
    extensionPath,
    display: context.display,
    protocol: "marionette",
    signal: context.signal,
    extraPrefs: [...USER_DEFAULTS, ...(extra.prefs ?? [])],
    ...(extra.dataHome === undefined ? {} : { dataHome: extra.dataHome }),
  });
  const page = await openExtensionPage(session, extensionPath);
  return Object.assign(session, {
    driver: new PopupDriver(
      session,
      page,
      await readExtensionId(extensionPath),
      shotDir,
      context.log,
      NAME,
    ),
  });
}

/**
 * Every popup state in the real popup panel of Zen with the packed add-on, reached through the real API: screenshots
 * in light and dark, and audits of the popup's DOM (contrast, names, 400 by 600, motion, copy), each audit shown to
 * catch a known failure. One click on a row writes a file the fixture server's SHA-256 confirms, and the result
 * names it.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "every popup state renders in light and dark, passes its audits, and one click on a row saves the file",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const result = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return result(["needs --extension"], "");
    const extensionPath = context.extensionPath;
    await using a = await startFixtureServer();
    await using b = await startFixtureServer();
    await using workspace = recordingWorkspace(NAME);
    const shotDir =
      context.outDir === null
        ? NodePath.join(workspace.downloads, "..", "shots")
        : NodePath.join(context.outDir, NAME);
    NodeFS.mkdirSync(shotDir, { recursive: true });
    const problems: string[] = [];
    const shots: Shot[] = [];

    const full = `http://127.0.0.1:${String(a.port)}/fixtures/`;
    const plain = `http://localhost:${String(b.port)}/`;
    let oneClick: unknown = null;
    /** Zen draws a private window and its popups dark whatever the system theme; observed, so no light shot exists. */
    let privateDarkUnderLight: boolean | null = null;
    let audits: Awaited<ReturnType<typeof checkAudits>> | null = null;
    {
      await using session = await launchDriver(workspace, context, extensionPath, shotDir);
      const driver = session.driver;
      const fullTab = await session.openTab(full);
      await session.evaluate(fullTab, `window.__harnessReady`);
      await session.evaluate(
        fullTab,
        `fetch("/fixtures/video").then((r) => r.arrayBuffer()).then(() => "done")`,
      );
      const plainTab = await session.openTab(plain);

      await driver.open({ url: full, private: false }, "ready");
      await driver.capture("ready");
      audits = await checkAudits(driver);

      await driver.click(NAMES.custom);
      await driver.view("custom");
      for (const secrets of ["removed", "kept"] as const) {
        if (secrets === "kept") await driver.toggle(NAMES.secrets);
        for (const range of CUSTOM_RANGES) {
          await driver.chooseRange(range);
          await driver.capture(`custom-${range}-secrets-${secrets}`);
        }
      }
      await driver.toggle(NAMES.secrets);
      await driver.click(NAMES.back);
      await driver.view("ready");

      await callHook(session, { kind: "export-pause", point: "before-link", action: "arm" });
      await driver.clickRow(0);
      await driver.view("exporting");
      await until(
        () => callHook(session, { kind: "export-pause", point: "before-link", action: "reached" }),
        (reached) => reached === true,
        "the export to reach its pause",
      );
      await driver.capture("exporting");
      await callHook(session, { kind: "export-pause", point: "before-link", action: "release" });
      await driver.view("done");
      await driver.capture("done-missing");
      const gapsShown = await driver.text(".gaps");
      if (gapsShown === null || !/\baudio and video\b/iu.test(gapsShown))
        problems.push(`done-missing lists no audio and video group: ${String(gapsShown)}`);

      await driver.open({ url: plain, private: false }, "ready");
      const shownCount = number(await driver.text(".presets .preset .p-n b"));
      await driver.clickRow(0);
      await driver.view("done");
      await driver.capture("done");
      const named = (await driver.text(".file"))?.trim() ?? "";
      const written = NodePath.join(workspace.downloads, named);
      if (named === "" || !NodeFS.existsSync(written)) {
        problems.push(
          `the result names "${named}", which is not in the export folder: ${NodeFS.readdirSync(workspace.downloads).join(", ")}`,
        );
      } else {
        const text = NodeFS.readFileSync(written, "utf8");
        const verdict = checkExport(text, {
          servers: [{ host: `localhost:${String(b.port)}`, server: b }],
          hosts: [`localhost:${String(b.port)}`],
          previewCount: shownCount,
          secret: "HARK-NO-SECRET-MARKER",
        });
        problems.push(...verdict.problems.map((p) => `one click: ${p}`));
        const invalid = await validateHar(text);
        if (invalid !== null) problems.push(`one click: har-validator: ${invalid}`);
        oneClick = {
          file: named,
          rowCount: shownCount,
          entries: verdict.entries,
          exact: verdict.exact,
          bytes: text.length,
        };
      }

      await callHook(session, { kind: "export-fault", op: "link", errno: "ENOSPC" });
      await driver.open({ url: plain, private: false }, "ready");
      await driver.clickRow(0);
      await driver.view("error-write");
      await driver.capture("error-write");

      const blank = "about:blank";
      await session.openTab(blank);
      await driver.open({ url: blank, private: false }, "empty-tab");
      await driver.capture("empty-tab");

      await driver.open({ url: null, private: false }, "no-tab");
      await driver.capture("no-tab");

      const privateUrl = `http://127.0.0.1:${String(a.port)}/fixtures/no-store`;
      // The restart closes the add-on's pages, so Marionette moves to a web tab first.
      await session.evaluate(plainTab, `"moved"`);
      const privatePage = await chrome<{ page: string }>(session, PRIVATE_WINDOW, [
        driver.addonId,
        privateUrl,
        await readExtensionPopupPath(extensionPath),
      ]);
      driver.page = { session, tab: privatePage.page };
      await until(
        () => session.evaluate(privatePage.page, `typeof browser`),
        (type) => type === "object",
        "the private window's add-on page to answer",
      );
      await driver.open({ url: privateUrl, private: true }, "empty-private");
      await driver.capture("empty-private", true);
      await chrome(session, SET_THEME, [0]);
      privateDarkUnderLight = await until(
        () =>
          value<boolean | null>(
            driver.page,
            inPopup(`return w.matchMedia("(prefers-color-scheme: dark)").matches;`),
          ),
        (dark) => dark !== null,
        "the private popup's colour scheme",
      );
      shots.push(...driver.shots);
    }
    {
      await using refused = recordingWorkspace(`${NAME}-refused`);
      await using session = await launchDriver(refused, context, extensionPath, shotDir, {
        dataHome: NodePath.join(refused.profileDir, "archive-inside-profile"),
      });
      await session.openTab(plain);
      await session.driver.open({ url: plain, private: false }, "error-store");
      await session.driver.capture("error-store");
      shots.push(...session.driver.shots);
    }
    {
      await using off = recordingWorkspace(`${NAME}-api-off`);
      await using session = await launchDriver(off, context, extensionPath, shotDir, {
        prefs: [{ name: "extensions.experiments.enabled", value: false }],
      });
      await session.openTab(plain);
      await session.driver.open({ url: plain, private: false }, "api-missing");
      await session.driver.capture("api-missing");
      shots.push(...session.driver.shots);
    }

    for (const shot of shots)
      problems.push(...shot.problems.map((p) => `${shot.state} ${shot.theme}: ${p}`));
    if (audits !== null) {
      problems.push(...audits.missed.map((m) => `the audits missed ${m}`));
      problems.push(...audits.clean.map((p) => `after the faults were removed: ${p}`));
    }
    const states = [...new Set(shots.map((s) => s.state))];
    if (privateDarkUnderLight === false)
      problems.push(
        "a private window now follows a light system theme: capture empty-private in light too",
      );
    return result(
      problems,
      `${String(shots.length)} screenshots of ${states.join(", ")} in ${shotDir} (empty-private in dark only: Zen draws private windows dark under a light system theme); audit faults caught: ${audits?.caught.join(", ") ?? "none"}; one click: ${JSON.stringify(oneClick)}`,
      {
        shots: shots.map(({ file, ...rest }) => ({
          ...rest,
          file: file === null ? null : NodePath.basename(file),
        })),
        audits,
        oneClick,
        privateDarkUnderLight,
      },
    );
  },
};

/** @discovered-check */
export default check;
