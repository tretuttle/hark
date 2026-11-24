// Opens the real toolbar popup and reaches its DOM, for checks that drive the popup as a user does. Observed in
// headless Zen 1.24.2b; docs/internals/browser-harness.md says why each step is needed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BrowserSession } from "./browser.ts";
import { value, type ExtensionPage } from "./export-session.ts";
import { chrome, until } from "./pages-driver.ts";
import { popupAuditExpression, sizeProblems, type DomAudit, type PopupBox } from "./popup-audit.ts";

const PRIVATE_UTILS = `const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const windowOf = (priv) => [...Services.wm.getEnumerator("navigator:browser")].find((w) => PrivateBrowsingUtils.isWindowPrivate(w) === priv);`;

export const CLOSE_POPUPS = `const done = arguments[arguments.length - 1];
  for (const w of Services.wm.getEnumerator("navigator:browser"))
    for (const b of w.document.querySelectorAll(".webextension-popup-browser")) b.closest("panel")?.hidePopup();
  done(true);`;

/**
 * Selects the target tab, waits until the selection has held for 200 ms (Marionette's switch to the helper page can
 * land after it), then opens the popup the way the toolbar button does. The popup reads its tab as it loads.
 */
export const OPEN_POPUP = `const done = arguments[arguments.length - 1];
  const [addonId, target] = arguments;
  ${PRIVATE_UTILS}
  (async () => {
    const win = windowOf(target.private);
    if (win === undefined) throw new Error("no window");
    const wanted = () =>
      target.url === null
        ? win.gBrowser.selectedTab.hasAttribute("zen-empty-tab")
        : !win.gBrowser.selectedTab.hasAttribute("zen-empty-tab") &&
          win.gBrowser.selectedBrowser.currentURI.spec === target.url;
    const select = () => {
      if (target.url === null) return win.gZenWorkspaces.selectEmptyTab();
      const tab = [...win.gBrowser.tabs].find(
        (t) => !t.hasAttribute("zen-empty-tab") && t.linkedBrowser.currentURI.spec === target.url,
      );
      if (tab === undefined) throw new Error("no tab at " + target.url);
      win.gBrowser.selectedTab = tab;
    };
    let held = 0;
    for (let i = 0; i < 100 && held < 4; i += 1) {
      if (Services.focus.activeWindow !== win) win.focus();
      if (wanted() && Services.focus.activeWindow === win) held += 1;
      else {
        held = 0;
        select();
      }
      await new Promise((resolve) => win.setTimeout(resolve, 50));
    }
    if (!wanted() || Services.focus.activeWindow !== win)
      throw new Error("the target tab did not stay selected in the focused window");
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
    const extension = WebExtensionPolicy.getByID(addonId).extension;
    const widgetId = ExtensionCommon.makeWidgetId(addonId) + "-browser-action";
    if (win.document.getElementById(widgetId) === null) win.CustomizableUI.addWidgetToArea(widgetId, win.CustomizableUI.AREA_NAVBAR);
    await ExtensionParent.apiManager.global.browserActionFor(extension).openPopup(win, false);
    const browser = () => win.document.querySelector(".webextension-popup-browser");
    let last = "";
    let stable = 0;
    for (let i = 0; i < 200 && stable < 4; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 50));
      const size = String(browser()?.clientWidth) + "x" + String(browser()?.clientHeight);
      stable = size === last && (browser()?.clientHeight ?? 0) > 100 ? stable + 1 : 0;
      last = size;
    }
    done({ ok: true, selected: wanted() && stable >= 4, detail: { selected: wanted(), size: last, spec: win.gBrowser.selectedBrowser.currentURI.spec, privateAllowed: WebExtensionPolicy.getByID(addonId).privateBrowsingAllowed, browsers: [...Services.wm.getEnumerator("navigator:browser")].map((w) => w.document.querySelectorAll(".webextension-popup-browser").length), widget: win.document.getElementById(widgetId) !== null } });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

/** An expression for a page of the add-on: runs `body` with the open popup's window as `w`, or answers null. */
export const inPopup = (body: string) => `(() => {
  const w = browser.extension.getViews({ type: "popup" })[0];
  if (w === undefined) return null;
  ${body}
})()`;

const THEMES = [
  { name: "light", dark: 0 },
  { name: "dark", dark: 1 },
] as const;
type Theme = (typeof THEMES)[number]["name"];

/** Where the popup opens: a tab by URL in a normal or private window, or Zen's empty tab (url null). */
export type Target = { readonly url: string | null; readonly private: boolean };

/**
 * The popup's own `<browser>`, drawn from its compositor output once its size holds for two reads. `scale` is device
 * pixels per CSS pixel.
 */
const SNAPSHOT = `const done = arguments[arguments.length - 1];
  const [priv, draw, scale] = arguments;
  ${PRIVATE_UTILS}
  (async () => {
    const win = windowOf(priv);
    const b = win.document.querySelector(".webextension-popup-browser");
    if (b === null) throw new Error("no popup browser");
    let last = "";
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 50));
      const size = b.clientWidth + "x" + b.clientHeight;
      if (size === last) break;
      last = size;
    }
    let png = null;
    if (draw) {
      const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(null, scale, "white");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      png = canvas.toDataURL("image/png");
    }
    done({ ok: true, png, width: b.clientWidth, height: b.clientHeight });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

export const SET_THEME = `const done = arguments[arguments.length - 1];
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);
  done(true);`;

const VIEW_KIND = inPopup(`return w.document.querySelector(".popup")?.dataset.view ?? null;`);

export type Shot = {
  readonly state: string;
  readonly theme: Theme;
  readonly view: string;
  readonly file: string | null;
  readonly box: PopupBox;
  readonly checked: DomAudit["checked"];
  readonly problems: readonly string[];
};

/** One browser with the add-on, a page of the add-on to reach the popup from, and the screenshots it writes. */
export class PopupDriver {
  readonly shots: Shot[] = [];
  readonly session: BrowserSession;
  /** Replaced after the add-on restarts, which closes its pages. */
  page: ExtensionPage;
  readonly addonId: string;
  readonly shotDir: string;
  readonly log: (line: string) => void;
  /** Starts each log line. */
  readonly name: string;

  constructor(
    session: BrowserSession,
    page: ExtensionPage,
    addonId: string,
    shotDir: string,
    log: (line: string) => void,
    name: string,
  ) {
    this.log = log;
    this.session = session;
    this.page = page;
    this.addonId = addonId;
    this.shotDir = shotDir;
    this.name = name;
  }

  /** Opens the real popup on `target` and waits until it draws `view`. */
  async open(target: Target, view: string): Promise<void> {
    this.log(`${this.name}: open the popup on ${String(target.url)} for ${view}`);
    await chrome(this.session, CLOSE_POPUPS);
    await until(
      () => value<number>(this.page, `browser.extension.getViews({ type: "popup" }).length`),
      (n) => n === 0,
      "the previous popup to close",
    );
    const opened = await chrome<{ selected: boolean; detail: unknown }>(this.session, OPEN_POPUP, [
      this.addonId,
      target,
    ]);
    if (!opened.selected)
      throw new Error(
        `the popup did not settle on ${String(target.url)}: ${JSON.stringify(opened.detail)}`,
      );
    await this.view(view);
  }

  async view(kind: string): Promise<void> {
    try {
      await until(
        () => value<string | null>(this.page, VIEW_KIND),
        (v) => v === kind,
        `the popup to show ${kind}`,
      );
    } catch (error) {
      const shown = await value<string | null>(
        this.page,
        inPopup(`return w.document.body.innerText;`),
      );
      throw new Error(`${String(error)}; the popup reads: ${JSON.stringify(shown)}`, {
        cause: error,
      });
    }
  }

  /** Clicks the button whose accessible name is `name`, as a user's click would. */
  click(name: string): Promise<unknown> {
    return value(
      this.page,
      inPopup(`const button = [...w.document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent).trim() === ${JSON.stringify(name)});
        if (button === undefined) throw new Error("no button named " + ${JSON.stringify(name)});
        button.click();
        return true;`),
    );
  }

  /** Clicks the checkbox whose label reads `name`. */
  toggle(name: string): Promise<unknown> {
    return value(
      this.page,
      inPopup(`const label = [...w.document.querySelectorAll("label.check")].find((l) => l.querySelector(".check-l")?.textContent.trim() === ${JSON.stringify(name)});
        if (label === undefined) throw new Error("no checkbox named " + ${JSON.stringify(name)});
        label.querySelector("input").click();
        return true;`),
    );
  }

  /** Picks a time range in Custom as the select's change does, and waits until the form shows it. */
  async chooseRange(range: string): Promise<void> {
    await value(
      this.page,
      inPopup(`const select = w.document.querySelector("[data-view=custom] select");
        Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(range)});
        select.dispatchEvent(new w.Event("change", { bubbles: true }));
        return true;`),
    );
    await until(
      () =>
        value<boolean | null>(
          this.page,
          inPopup(`return w.document.querySelector("[data-view=custom] select")?.value === ${JSON.stringify(range)} &&
            (${JSON.stringify(range)} !== "between") === (w.document.querySelector("input[type=datetime-local]") === null);`),
        ),
      (shown) => shown === true,
      `Custom to show the ${range} range`,
    );
  }

  clickRow(index: number): Promise<unknown> {
    return value(
      this.page,
      inPopup(
        `w.document.querySelectorAll(".presets .preset")[${String(index)}].click(); return true;`,
      ),
    );
  }

  text(selector: string): Promise<string | null> {
    return value(
      this.page,
      inPopup(`return w.document.querySelector(${JSON.stringify(selector)})?.textContent ?? null;`),
    );
  }

  /** Audits the open popup, and draws it to the file `draw` names at `scale` device pixels per CSS pixel. */
  async audit(
    priv: boolean,
    draw: string | null,
    scale = 1,
  ): Promise<{ box: PopupBox; audit: DomAudit; problems: string[] }> {
    const snap = await chrome<{ png: string | null; width: number; height: number }>(
      this.session,
      SNAPSHOT,
      [priv, draw !== null, scale],
    );
    const audit = await value<DomAudit>(this.page, popupAuditExpression());
    const box: PopupBox = {
      width: snap.width,
      height: snap.height,
      scrollWidth: audit.scrollWidth,
      scrollHeight: audit.scrollHeight,
    };
    if (draw !== null && snap.png !== null)
      NodeFS.writeFileSync(draw, Buffer.from(snap.png.slice(snap.png.indexOf(",") + 1), "base64"));
    return { box, audit, problems: [...audit.problems, ...sizeProblems(box)] };
  }

  /**
   * Screenshots and audits the open popup in both themes, then leaves it light. `scale` is device pixels per CSS
   * pixel in the screenshots.
   */
  async capture(state: string, priv = false, scale = 1): Promise<void> {
    this.log(`${this.name}: capture ${state}`);
    const view = (await value<string | null>(this.page, VIEW_KIND)) ?? "none";
    for (const theme of priv ? THEMES.filter((t) => t.dark === 1) : THEMES) {
      await chrome(this.session, SET_THEME, [theme.dark]);
      await until(
        () =>
          value<boolean | null>(
            this.page,
            inPopup(`return w.matchMedia("(prefers-color-scheme: dark)").matches;`),
          ),
        (dark) => dark === (theme.dark === 1),
        `the ${theme.name} theme`,
      );
      const file = NodePath.join(this.shotDir, `${state}-${theme.name}.png`);
      const { box, audit, problems } = await this.audit(priv, file, scale);
      this.shots.push({
        state,
        theme: theme.name,
        view,
        file,
        box,
        checked: audit.checked,
        problems,
      });
    }
    await chrome(this.session, SET_THEME, [0]);
  }
}
