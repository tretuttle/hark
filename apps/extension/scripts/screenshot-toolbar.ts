// Installs the packed XPI into a fresh profile, pins the toolbar button to the navigation bar, switches the browser
// between its light and dark appearance, and saves a screenshot of the window and of the toolbar for each.
// Usage: pnpm run screenshot:toolbar --out <folder> [--binary <path>] [--xpi <path>] [--visible] [--scale <ratio>]
//   [--window <width>x<height>] [--pref <name>=<value>]...  --scale is layout.css.devPixelsPerPx, as given.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  launchBrowser,
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../../../tools/browser-harness/src/browser.ts";
import type { Pref } from "../../../tools/browser-harness/src/browser.ts";
import { BINARY_ENV, GECKO_BINARY_ENV } from "../../../tools/browser-harness/src/cli.ts";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));
const { values: options } = NodeUtil.parseArgs({
  args,
  strict: true,
  options: {
    binary: { type: "string" },
    xpi: { type: "string", default: xpiPath(builtManifest.version) },
    out: { type: "string" },
    visible: { type: "boolean", default: false },
    scale: { type: "string" },
    window: { type: "string" },
    pref: { type: "string", multiple: true, default: [] },
  },
});
if (options.out === undefined) throw new Error("Pass --out <folder> for the screenshots");
const binary = options.binary ?? process.env[GECKO_BINARY_ENV] ?? process.env[BINARY_ENV];
if (binary === undefined || binary.length === 0) {
  throw new Error(`a browser binary is required: pass --binary <path> or set ${GECKO_BINARY_ENV}`);
}

// `ui.systemUsesDarkTheme` is the switch the browser's own light and dark appearance follows, in Zen and in Firefox.
const APPEARANCES = [
  { name: "light", systemUsesDarkTheme: 0 },
  { name: "dark", systemUsesDarkTheme: 1 },
] as const;

const prefValue = (text: string): Pref["value"] =>
  text === "true" ? true : text === "false" ? false : /^-?\d+$/.test(text) ? Number(text) : text;
const extraPrefs: Pref[] = options.pref.map((entry) => {
  const at = entry.indexOf("=");
  if (at <= 0) throw new Error(`--pref takes <name>=<value>, got ${entry}`);
  return { name: entry.slice(0, at), value: prefValue(entry.slice(at + 1)) };
});
if (options.scale !== undefined) {
  extraPrefs.push({ name: "layout.css.devPixelsPerPx", value: options.scale });
}
const windowSize = options.window?.match(/^(\d+)x(\d+)$/);
if (options.window !== undefined && !windowSize) throw new Error("--window takes <width>x<height>");

const xpi = NodePath.resolve(options.xpi);
const addonId = await readExtensionId(xpi);
const popupPath = await readExtensionPopupPath(xpi);
const outDir = NodePath.resolve(options.out);
NodeFS.mkdirSync(outDir, { recursive: true });

await using session = await launchBrowser({
  binaryPath: NodePath.resolve(binary),
  extensionPath: xpi,
  display: options.visible ? "window" : "headless",
  protocol: "marionette",
  allowSystemAccess: true,
  extraPrefs,
  signal: new AbortController().signal,
});
await waitForActiveExtensionUrl(session, addonId, popupPath);
console.log(`installed ${xpi} as ${addonId}`);

const widget = (await session.evaluateChrome(
  `const done = arguments[arguments.length - 1];
   const { CustomizableUI } = window;
   const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
   const widgetId = ExtensionCommon.makeWidgetId(arguments[0]) + "-browser-action";
   const installed = CustomizableUI.getPlacementOfWidget(widgetId)?.area ?? null;
   CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_NAVBAR);
   done({ widgetId, installed, placement: CustomizableUI.getPlacementOfWidget(widgetId)?.area ?? null });`,
  [addonId],
)) as { widgetId: string; installed: string | null; placement: string | null };
console.log(
  `toolbar button ${widget.widgetId} installed in ${widget.installed}, placed in ${widget.placement}`,
);

if (windowSize) {
  await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     window.resizeTo(arguments[0], arguments[1]);
     setTimeout(done, 500);`,
    [Number(windowSize[1]), Number(windowSize[2])],
  );
}

for (const { name, systemUsesDarkTheme } of APPEARANCES) {
  const state = (await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[1]);
     // Wait for the toolbar to repaint and re-pick its icon.
     const [widgetId] = arguments;
     setTimeout(() => {
       try {
         const button = document.getElementById(widgetId);
         // Zen lists extension buttons in #zen-overflow-extensions-list. Firefox puts them in a toolbar.
         const toolbar = button.closest("#zen-overflow-extensions-list, toolbar");
         const image = button.querySelector(".toolbarbutton-icon");
         const box = image.getBoundingClientRect();
         done({
           icon: getComputedStyle(image).listStyleImage,
           toolbarText: getComputedStyle(toolbar).color,
           toolbarSelector: "#" + toolbar.id,
           box: box.width + " by " + box.height + " CSS px at " + box.x + ", " + box.y,
           // An element screenshot resamples a box that does not start on a device pixel, so the icon is read from
           // the window screenshot at these device pixels.
           device: [box.left, box.top, box.right, box.bottom]
             .map((edge) => edge * window.devicePixelRatio)
             .join(" "),
           ratio: window.devicePixelRatio,
           windowWidth: window.innerWidth,
         });
       } catch (error) {
         done({ icon: "ERROR " + error, toolbarText: "", toolbarSelector: "", box: "", device: "", ratio: 0, windowWidth: 0 });
       }
     }, 1500);`,
    [widget.widgetId, systemUsesDarkTheme],
  )) as {
    icon: string;
    toolbarText: string;
    toolbarSelector: string;
    box: string;
    device: string;
    ratio: number;
    windowWidth: number;
  };
  console.log(`${name}: toolbar text ${state.toolbarText}, button icon ${state.icon}`);
  console.log(
    `${name}: icon box ${state.box}, device px left top right bottom ${state.device}, devicePixelRatio ${state.ratio}, window ${state.windowWidth} CSS px`,
  );

  for (const [label, selector] of [
    ["window", undefined],
    ["toolbar", state.toolbarSelector],
  ] as const) {
    const png = await session.takeChromeScreenshot(selector);
    const file = NodePath.join(outDir, `${label}-${name}.png`);
    NodeFS.writeFileSync(file, png);
    console.log(`saved ${file}`);
  }
}
