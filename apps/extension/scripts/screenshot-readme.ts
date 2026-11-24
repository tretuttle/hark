// Saves the README screenshots: the toolbar popup, the history page and the settings page, each in light and dark, at
// two device pixels per CSS pixel. The packed XPI records real traffic first: three fixture servers on loopback stand
// in for example.com, example.org and example.net, and every number shown is what the add-on recorded.
// Usage: pnpm run screenshot:readme [--binary <path>] [--xpi <path>] [--out <folder>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  readExtensionId,
  type BrowserSession,
} from "../../../tools/browser-harness/src/browser.ts";
import { BINARY_ENV, GECKO_BINARY_ENV } from "../../../tools/browser-harness/src/cli.ts";
import { openExtensionPage } from "../../../tools/browser-harness/src/export-session.ts";
import {
  COST_IMAGES_PATH,
  ID_DOWNLOAD_PAGE_PATH,
} from "../../../tools/browser-harness/src/extended-fixtures.ts";
import { PAGE_PATH } from "../../../tools/browser-harness/src/fixtures.ts";
import { chrome, PageDriver } from "../../../tools/browser-harness/src/pages-driver.ts";
import { CLOSE_POPUPS, PopupDriver } from "../../../tools/browser-harness/src/popup-driver.ts";
import {
  callHook,
  recordingWorkspace,
} from "../../../tools/browser-harness/src/recording-session.ts";
import { getCostScenario } from "../../../tools/browser-harness/src/scenarios.ts";
import {
  startFixtureServer,
  type FixtureServer,
} from "../../../tools/browser-harness/src/server.ts";
import { buildDir, extensionRoot, readManifest, xpiPath } from "./manifest.ts";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));
const { values: options } = NodeUtil.parseArgs({
  args,
  strict: true,
  options: {
    binary: { type: "string" },
    xpi: { type: "string", default: xpiPath(builtManifest.version) },
    out: {
      type: "string",
      default: NodePath.join(extensionRoot, "..", "..", "docs", "screenshots"),
    },
  },
});
const binary = options.binary ?? process.env[GECKO_BINARY_ENV] ?? process.env[BINARY_ENV];
if (binary === undefined || binary.length === 0) {
  throw new Error(`a browser binary is required: pass --binary <path> or set ${GECKO_BINARY_ENV}`);
}

/** Device pixels per CSS pixel in every screenshot. */
const SCALE = 2;
/** The history page fills the window; at this height it ends a little below the busiest site's session. */
const HISTORY_HEIGHT = 640;

type Request = { readonly method: "GET" | "POST"; readonly path: string };

/** The heavy cost page's stylesheet, scripts, images and API calls, without its 50 MB download. */
const heavy: readonly Request[] = getCostScenario("cost-heavy")
  .responses.slice(1)
  .filter((r) => !r.path.endsWith(".bin"));
/** The mixed cost page's responses, 70 B to 40 KB each. */
const mixed: readonly Request[] = getCostScenario("cost-mixed").responses.slice(1);

/**
 * Each site, the fixture server that answers for it, and its visits: one tab per visit, on a fixture page, then the
 * requests its scripts make. The busiest site comes last, so it is the most recent and the history page opens on
 * it, and the popup is opened on its last tab.
 */
const SITES = [
  {
    site: "example.net",
    visits: [
      { host: "status.example.net", page: ID_DOWNLOAD_PAGE_PATH, requests: mixed.slice(0, 60) },
    ],
  },
  {
    site: "example.org",
    visits: [{ host: "docs.example.org", page: PAGE_PATH, requests: mixed.slice(60, 100) }],
  },
  {
    site: "example.com",
    visits: [
      { host: "shop.example.com", page: COST_IMAGES_PATH, requests: mixed.slice(100, 200) },
      { host: "www.example.com", page: PAGE_PATH, requests: heavy },
    ],
  },
] as const;

/**
 * The example hosts resolve to loopback, where only the fixture servers listen, and nothing upgrades them to HTTPS,
 * so no request leaves the machine. The request counts below are checked against the servers' logs.
 */
const NETWORK_PREFS = [
  {
    name: "network.dns.localDomains",
    value: SITES.flatMap((s) => s.visits.map((v) => v.host)).join(","),
  },
  { name: "network.dns.disableIPv6", value: true },
  { name: "network.proxy.type", value: 0 },
  { name: "network.trr.mode", value: 5 },
  { name: "dom.security.https_first", value: false },
  { name: "dom.security.https_first_schemeless", value: false },
  { name: "dom.security.https_only_mode", value: false },
  // Marionette turns this off as a recommended pref; a user's browser has it on.
  { name: "security.fileuri.strict_origin_policy", value: true },
] as const;

/** Opens a tab on `url`, waits for the fixture page to finish its own requests, then makes `requests` from it. */
async function visit(
  session: BrowserSession,
  url: string,
  requests: readonly Request[],
): Promise<void> {
  const tab = await session.openTab(url);
  await session.evaluate(tab, `Promise.resolve(window.__harnessReady).then(() => "loaded")`);
  await session.evaluate(
    tab,
    `Promise.all(${JSON.stringify(requests)}.map((r) =>
      fetch(r.path, { method: r.method, body: r.method === "POST" ? "{}" : undefined }).then((res) => res.arrayBuffer())
    )).then(() => "done")`,
  );
}

const xpi = NodePath.resolve(options.xpi);
const outDir = NodePath.resolve(options.out);
NodeFS.mkdirSync(outDir, { recursive: true });
const log = (line: string) => console.log(line);

await using stack = new AsyncDisposableStack();
/** One fixture server per site, so its request log holds exactly that site's traffic. */
const servers = new Map<string, FixtureServer>();
for (const { site } of SITES) servers.set(site, stack.use(await startFixtureServer()));
await using workspace = recordingWorkspace("readme-screenshots");
await using session = await workspace.launch({
  binaryPath: NodePath.resolve(binary),
  extensionPath: xpi,
  display: "headless",
  protocol: "marionette",
  signal: new AbortController().signal,
  extraPrefs: NETWORK_PREFS,
});
const origin = await PageDriver.origin(session, xpi);
log(`installed ${xpi}`);

let popupTab = "";
for (const { site, visits } of SITES) {
  const port = String(servers.get(site)?.port);
  for (const { host, page, requests } of visits) {
    popupTab = `http://${host}:${port}${page}`;
    await visit(session, popupTab, requests);
  }
  log(`${site}: visited ${visits.map((v) => v.host).join(", ")}`);
}
await callHook(session, { kind: "flush" });

const history = await PageDriver.open(session, origin, "history", outDir, log);
const recorded = await history.run<{ rows: { site: string; requests: number }[] }>(
  `browser.hark.listSites({ cursor: null })`,
);
const mismatched = SITES.filter(({ site }) => {
  const served = servers.get(site)?.getRequestLog().length ?? 0;
  const count = recorded.rows.find((r) => r.site === site)?.requests ?? 0;
  log(
    `${site}: ${String(count)} requests recorded, ${String(served)} served by its fixture server`,
  );
  return count !== served;
});
if (mismatched.length > 0 || recorded.rows.length !== SITES.length)
  throw new Error(
    `the recording does not match the fixture servers: ${JSON.stringify(recorded.rows)}`,
  );

const popup = new PopupDriver(
  session,
  await openExtensionPage(session, xpi),
  await readExtensionId(xpi),
  outDir,
  log,
  "popup",
);
await popup.open({ url: popupTab, private: false }, "ready");
await popup.capture("popup", false, SCALE);
await chrome(session, CLOSE_POPUPS);

await history.reload();
await history.waitFor(
  "the sessions of the busiest site",
  `document.querySelectorAll(".site-btn").length === ${String(SITES.length)} && document.querySelector('input[data-site]') !== null`,
);
await history.capture("history", { scale: SCALE, height: HISTORY_HEIGHT });

const settings = await PageDriver.open(session, origin, "options", outDir, log);
await settings.waitFor("the settings", `document.querySelector(".page")?.dataset.view === "ready"`);
const problems = await settings.run<string[]>(
  `browser.hark.getRecordingStatus().then((s) => s.problems)`,
);
if (problems.length > 0) throw new Error(`the recording reports problems: ${problems.join(", ")}`);
await settings.capture("settings", { scale: SCALE });

for (const shot of [...popup.shots, ...history.shots, ...settings.shots]) {
  for (const problem of shot.problems) log(`warning: ${shot.state} ${shot.theme}: ${problem}`);
  log(`saved ${String(shot.file)}`);
}
