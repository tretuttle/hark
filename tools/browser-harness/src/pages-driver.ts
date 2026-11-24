// Drives the add-on's history and options pages in a tab of the real browser, as a user's clicks do: each page runs
// with its own moz-extension principal and reaches stored data only through browser.hark.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "./browser.ts";
import { value, type ExtensionPage } from "./export-session.ts";
import { pageAuditExpression, type DomAudit } from "./popup-audit.ts";

const PAGES = { history: "pages/history.html", options: "options/index.html" } as const;
export type PageName = keyof typeof PAGES;

const THEMES = [
  { name: "light", dark: 0 },
  { name: "dark", dark: 1 },
] as const;

/** One screenshot and the audit of the DOM it shows. */
export type PageShot = {
  readonly state: string;
  readonly theme: (typeof THEMES)[number]["name"];
  readonly file: string;
  readonly checked: DomAudit["checked"];
  readonly problems: readonly string[];
};

/** Runs `script` in the browser's chrome and throws the error it answers with. */
export const chrome = async <T>(
  session: BrowserSession,
  script: string,
  args: readonly unknown[] = [],
): Promise<T> => {
  const answer = (await session.evaluateChrome(script, args)) as T & {
    readonly ok?: boolean;
    readonly error?: string;
  };
  if (answer.ok === false) throw new Error(answer.error);
  return answer;
};

/** Reads until `ok` holds, for at most 30 s. The browser's own work has no event the harness can await. */
export async function until<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(v)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Both the system theme and the content override, so a page in a tab follows the theme as it would for a user. */
const SET_THEME = `const done = arguments[arguments.length - 1];
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);
  Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", arguments[0] === 1 ? 0 : 1);
  done(true);`;

/**
 * Waits until the window's tabs stop changing after startup. Zen's session manager restores its spaces after the
 * window opens, even with browser.startup.page 0, and a tab opened before that finished was closed under Marionette
 * (observed on the first restart of a profile: "contentBrowser is null", or a navigation that never ended).
 */
const SETTLE_TABS = `const done = arguments[arguments.length - 1];
  (async () => {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    await win.SessionStore.promiseAllWindowsRestored;
    await win.gZenWorkspaces?.promiseInitialized;
    let last = "";
    for (let stable = 0, i = 0; stable < 4 && i < 100; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 100));
      const now = [...win.gBrowser.tabs].map((t) => t.linkedPanel).join(",");
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
    done({ ok: true });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

/**
 * Selects the tab with this Marionette handle and sizes the window, so the screenshot is the page a user sees at that
 * width. Several tabs can show the same page, so the handle names the tab, not its URL. A resize lands after
 * resizeTo returns, so it answers once the window has the size and the tab's browser has held its size for 200 ms.
 */
const SELECT_TAB = `const done = arguments[arguments.length - 1];
  const [handle, width, height] = arguments;
  (async () => {
    const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const tab = [...win.gBrowser.tabs].find((t) => NavigableManager.getIdForBrowser(t.linkedBrowser) === handle);
    if (tab === undefined) throw new Error("no tab with handle " + handle);
    win.gBrowser.selectedTab = tab;
    if (win.outerWidth === width && win.outerHeight === height) return;
    win.resizeTo(width, height);
    let last = "";
    for (let held = 0, i = 0; held < 4 && i < 100; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 50));
      const b = tab.linkedBrowser;
      const size = [win.outerWidth, win.outerHeight, b.clientWidth, b.clientHeight].join("x");
      held = size === last && win.outerWidth === width && win.outerHeight === height ? held + 1 : 0;
      last = size;
    }
    if (win.outerWidth !== width || win.outerHeight !== height)
      throw new Error("the window stayed " + win.outerWidth + "x" + win.outerHeight);
  })().then(() => done({ ok: true }), (error) => done({ ok: false, error: String(error) }));`;

/** The selected tab's whole document, drawn from the compositor at `scale` device pixels per CSS pixel, as a PNG data URL. */
const SNAPSHOT = `const done = arguments[arguments.length - 1];
  const [width, height, scale] = arguments;
  (async () => {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const global = win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal;
    const bitmap = await global.drawSnapshot(new win.DOMRect(0, 0, width, height), scale, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    done({ ok: true, png: canvas.toDataURL("image/png") });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

/**
 * Replaces the platform's folder picker for this browser with one that answers the folder named in a pref, so the
 * product's own nsIFilePicker call runs unchanged. The product carries no harness hook for it.
 */
const FAKE_PICKER = `const done = arguments[arguments.length - 1];
  const [folder] = arguments;
  const PREF = "hark.harness.pickedFolder";
  Services.prefs.setStringPref(PREF, folder ?? "");
  const contract = "@mozilla.org/filepicker;1";
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  if (!Services.prefs.getBoolPref(PREF + ".registered", false)) {
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    const factory = {
      createInstance(iid) {
        const picked = () => Services.prefs.getStringPref(PREF, "");
        const picker = {
          init() {},
          appendFilters() {},
          appendFilter() {},
          get file() { return new FileUtils.File(picked()); },
          open(callback) {
            const result = picked() === "" ? Ci.nsIFilePicker.returnCancel : Ci.nsIFilePicker.returnOK;
            Services.tm.dispatchToMainThread(() => (typeof callback === "function" ? callback(result) : callback.done(result)));
          },
          QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
        };
        return picker.QueryInterface(iid);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
    registrar.registerFactory(Components.ID(Services.uuid.generateUUID().toString()), "harness folder picker", contract, factory);
    Services.prefs.setBoolPref(PREF + ".registered", true);
  }
  done(true);`;

/** One known failure per audit, put into the real page DOM; the audit must name it. */
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
  { name: "a transition", expect: "motion", css: `.btn { transition: background-color 150ms }` },
] as const;

/** One add-on page open in its own tab. */
export class PageDriver {
  readonly page: ExtensionPage;
  readonly url: string;
  readonly shots: PageShot[] = [];
  readonly #shotDir: string;
  readonly #log: (line: string) => void;

  private constructor(
    page: ExtensionPage,
    url: string,
    shotDir: string,
    log: (line: string) => void,
  ) {
    this.page = page;
    this.url = url;
    this.#shotDir = shotDir;
    this.#log = log;
  }

  /** The add-on's base URL, once its policy is active and the window's restored tabs have settled. */
  static async origin(session: BrowserSession, extensionPath: string): Promise<string> {
    await chrome(session, SETTLE_TABS);
    const popup = await waitForActiveExtensionUrl(
      session,
      await readExtensionId(extensionPath),
      await readExtensionPopupPath(extensionPath),
    );
    const url = new URL(popup);
    // Node gives a moz-extension URL the opaque origin "null".
    return `${url.protocol}//${url.host}`;
  }

  /** Opens the page in a new tab; `section` opens it at that element id, as a link from the popup does. */
  static async open(
    session: BrowserSession,
    origin: string,
    name: PageName,
    shotDir: string,
    log: (line: string) => void,
    section: string | null = null,
  ): Promise<PageDriver> {
    const url = `${origin}/${PAGES[name]}`;
    const tab = await session.openTab(section === null ? url : `${url}#${section}`);
    return new PageDriver({ session, tab }, url, shotDir, log);
  }

  run<T>(expression: string): Promise<T> {
    return value<T>(this.page, expression);
  }

  /** The page's `data-view`, which says which state it draws. */
  view(): Promise<string | null> {
    return this.run(`document.querySelector(".page")?.dataset.view ?? null`);
  }

  async waitFor(what: string, expression: string): Promise<void> {
    try {
      await until(
        () => this.run<unknown>(expression),
        (v) => v === true,
        what,
      );
    } catch (error) {
      const text = await this.run<string>(`document.body.innerText`);
      throw new Error(`${String(error)}; the page reads: ${JSON.stringify(text.slice(0, 600))}`, {
        cause: error,
      });
    }
  }

  /** Clicks the control whose accessible name is `name`, as a user's click does. Disabled controls ignore it. */
  click(name: string): Promise<unknown> {
    return this.run(`(() => {
      const named = (el) => (el.getAttribute("aria-label") ?? el.textContent).trim();
      const found = [...document.querySelectorAll("button, a[href]")].find((el) => named(el) === ${JSON.stringify(name)});
      if (found === undefined) throw new Error("no control named " + ${JSON.stringify(name)});
      found.click();
      return true;
    })()`);
  }

  async reload(): Promise<void> {
    await this.page.session.navigateTab(this.page.tab, this.url);
  }

  /**
   * Screenshots the page in both themes and audits its DOM in each, then leaves it light. `scale` is device pixels
   * per CSS pixel in the screenshots; `height` is the window's, which sets how tall a page that fits it is drawn.
   */
  async capture(
    state: string,
    { scale = 1, height = 900 }: { readonly scale?: number; readonly height?: number } = {},
  ): Promise<void> {
    this.#log(`pages: capture ${state}`);
    const session = this.page.session;
    await chrome(session, SELECT_TAB, [this.page.tab, 1280, height]);
    for (const theme of THEMES) {
      await chrome(session, SET_THEME, [theme.dark]);
      await this.waitFor(
        `the ${theme.name} theme`,
        `matchMedia("(prefers-color-scheme: dark)").matches === ${String(theme.dark === 1)}`,
      );
      const audit = await this.run<DomAudit>(pageAuditExpression());
      await this.run(`(window.scrollTo(0, 0), true)`);
      const size = await this.run<{ width: number; height: number }>(
        `({ width: document.documentElement.clientWidth, height: Math.min(4000, document.documentElement.scrollHeight) })`,
      );
      const snap = await chrome<{ png: string }>(session, SNAPSHOT, [
        size.width,
        size.height,
        scale,
      ]);
      const file = NodePath.join(this.#shotDir, `${state}-${theme.name}.png`);
      NodeFS.writeFileSync(file, Buffer.from(snap.png.slice(snap.png.indexOf(",") + 1), "base64"));
      this.shots.push({
        state,
        theme: theme.name,
        file,
        checked: audit.checked,
        problems: audit.problems,
      });
    }
    await chrome(session, SET_THEME, [0]);
  }

  /** Puts each audit's known failure into the page in turn; the audit must name every one, and none once removed. */
  async checkAudits(): Promise<{ caught: string[]; missed: string[]; clean: readonly string[] }> {
    const caught: string[] = [];
    const missed: string[] = [];
    for (const fault of AUDIT_FAULTS) {
      await this.run(`(() => {
        const html = ${JSON.stringify("html" in fault ? fault.html : "")};
        const css = ${JSON.stringify("css" in fault ? fault.css : "")};
        if (html) document.querySelector(".page").insertAdjacentHTML("beforeend", html);
        if (css) { const s = document.createElement("style"); s.dataset.fault = ""; s.textContent = css; document.head.append(s); }
        return true;
      })()`);
      const audit = await this.run<DomAudit>(pageAuditExpression());
      (audit.problems.some((p) => p.includes(fault.expect)) ? caught : missed).push(fault.name);
      await this.run(
        `(() => { for (const el of document.querySelectorAll("[data-fault]")) el.remove(); return true; })()`,
      );
    }
    const clean = (await this.run<DomAudit>(pageAuditExpression())).problems;
    return { caught, missed, clean };
  }
}

/** Points the platform folder picker at `folder`; null makes it answer Cancel. */
export const pickFolderNext = (session: BrowserSession, folder: string | null): Promise<unknown> =>
  chrome(session, FAKE_PICKER, [folder]);
