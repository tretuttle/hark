import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Site } from "@hark/recording/ids";
import { LAYOUT, siteDirName } from "@hark/recording/layout";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { checkExport, validateHar } from "../src/export-verify.ts";
import { call } from "../src/export-session.ts";
import { PageDriver, until, type PageShot } from "../src/pages-driver.ts";
import {
  checkEmptySelection,
  checkExclusion,
  type EmptySelection,
  type ExclusionMoment,
} from "../src/pages-verify.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer, type FixtureServer } from "../src/server.ts";

const NAME = "pages-history";
const SECRET = "HARK-NO-SECRET-MARKER";
/** Button names as the page shows them. Written here, not read from the product, so a renamed button fails. */
const NAMES = {
  exportTicked: "Export as one file",
  exclude: "Exclude site",
  confirm: "Exclude and delete",
  cancel: "Cancel",
} as const;

const SELECTION = `document.querySelector(".selbar .btn-primary")`;
const PROMPTS = `document.querySelectorAll("[role=alertdialog]").length`;

/**
 * The history page in Zen with the packed add-on: two sessions ticked on two sites export one file holding exactly
 * their requests, compared with the fixture servers' request logs and SHA-256; an empty selection cannot be
 * exported; excluding a site asks once and deletes its data. Each check also runs on a deliberately broken input and
 * must fail there, every state is screenshotted in light and dark, and the popup's DOM audits run on the page.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "two ticked sessions on two sites export exactly their requests, an empty selection cannot export, and excluding a site asks once and deletes it",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const problems: string[] = [];
    const result = (detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) {
      problems.push("needs --extension");
      return result("");
    }
    await using a = await startFixtureServer();
    await using b = await startFixtureServer();
    await using c = await startFixtureServer();
    await using workspace = recordingWorkspace(NAME);
    const shotDir =
      context.outDir === null
        ? NodePath.join(workspace.downloads, "..", "shots")
        : NodePath.join(context.outDir, NAME);
    NodeFS.mkdirSync(shotDir, { recursive: true });
    const sites: readonly { readonly site: string; readonly server: FixtureServer }[] = [
      { site: "s01.localhost", server: a },
      { site: "s02.localhost", server: b },
      { site: "s03.localhost", server: c },
    ];
    const servers = sites.map((s) => ({
      host: `${s.site}:${String(s.server.port)}`,
      server: s.server,
    }));

    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
      extraPrefs: [{ name: "security.fileuri.strict_origin_policy", value: true }],
    });
    const origin = await PageDriver.origin(session, context.extensionPath);
    const page = await PageDriver.open(session, origin, "history", shotDir, context.log);
    const api = <T>(expression: string) => page.run<T>(`browser.hark.${expression}`);
    const listed = async (site: string) =>
      (await api<{ rows: { site: string }[] }>(`listSites({ cursor: null })`)).rows.some(
        (r) => r.site === site,
      );
    const onDisk = (site: string) =>
      NodeFS.existsSync(
        NodePath.join(workspace.root(), LAYOUT.sitesDir, siteDirName(site as Site)),
      );
    const jobs = async () => (await api<unknown[]>(`listExports()`)).length;

    await page.waitFor(
      "the empty history",
      `document.querySelector(".page")?.dataset.view === "empty"`,
    );
    await page.capture("history-empty");
    const audits = await page.checkAudits();

    const web = await session.openTab("about:blank");
    const visit = async (site: string, server: FixtureServer, n: number) => {
      await session.navigateTab(web, `http://${site}:${String(server.port)}/`);
      await session.evaluate(
        web,
        `fetch("/?n=${String(n)}").then((r) => r.text()).then(() => "done")`,
      );
    };
    for (const s of sites) await visit(s.site, s.server, 2);
    await callHook(session, { kind: "flush" });

    const showSite = async (site: string) => {
      await page.run(`(() => {
        const button = [...document.querySelectorAll(".site-btn")].find((b) => b.querySelector(".grow")?.textContent === ${JSON.stringify(site)});
        if (button === undefined) throw new Error("no site button for " + ${JSON.stringify(site)});
        button.click();
        return true;
      })()`);
      await page.waitFor(
        `the sessions of ${site}`,
        `document.querySelector('input[data-site="${site}"]') !== null`,
      );
    };
    const tick = async (site: string) => {
      await showSite(site);
      await page.run(
        `(document.querySelector('input[data-site="${site}"]:not(:checked)')?.click(), true)`,
      );
      await page.waitFor(
        `${site} ticked`,
        `document.querySelector('input[data-site="${site}"]').checked`,
      );
    };
    /** Clicks Export as one file and waits for a saved result naming a file other than `previous`. */
    const exportTicked = async (
      previous: string | null,
    ): Promise<{ file: string; shown: number }> => {
      const shown = Number(
        (await page.run<string>(`document.querySelector("#selection-summary").textContent`))
          .split(",")[1]
          ?.replace(/[^0-9]/gu, ""),
      );
      await page.click(NAMES.exportTicked);
      await page.waitFor(
        "the export to be saved",
        `(document.querySelector(".job.callout-ok .file")?.textContent ?? ${JSON.stringify(previous)}) !== ${JSON.stringify(previous)}`,
      );
      const file = await page.run<string>(
        `document.querySelector(".job.callout-ok .file").textContent`,
      );
      return { file, shown };
    };
    const compared = (file: string, hosts: readonly string[], shown: number) => {
      const text = NodeFS.readFileSync(NodePath.join(workspace.downloads, file), "utf8");
      return {
        text,
        verdict: checkExport(text, { servers, hosts, previewCount: shown, secret: SECRET }),
      };
    };

    await page.reload();
    await page.waitFor(
      "three sites in history",
      `document.querySelectorAll(".site-btn").length === 3 && document.querySelector('input[data-site]') !== null`,
    );
    await page.capture("history-site");

    const emptyObserved = async (): Promise<EmptySelection> => {
      const jobsBefore = await jobs();
      const buttonDisabled = await page.run<boolean>(`${SELECTION}.disabled`);
      await page.run(`(${SELECTION}.click(), true)`);
      const jobsAfter = await jobs();
      const refused = await call(
        page.page,
        `browser.hark.startExport(${JSON.stringify({
          selection: { scope: "sessions", sessions: [], include: "all" },
          bodies: "include",
          redaction: "standard",
          packaging: "har",
          fileName: null,
        })})`,
      );
      return { buttonDisabled, jobsBefore, jobsAfter, apiRefused: !refused.ok };
    };
    const empty = await emptyObserved();
    problems.push(...checkEmptySelection(empty).map((p) => `empty selection: ${p}`));
    await page.run(`(${SELECTION}.disabled = false, true)`);
    const enabledButton = checkEmptySelection(await emptyObserved());
    if (enabledButton.length === 0)
      problems.push("empty selection: an enabled button was not caught");
    await page.run(`(${SELECTION}.disabled = ${String(empty.buttonDisabled)}, true)`);

    await tick("s01.localhost");
    await tick("s02.localhost");
    await page.capture("history-selected");
    const two = await exportTicked(null);
    await page.capture("history-saved");
    const twoHosts = servers.slice(0, 2).map((t) => t.host);
    const twoCompared = compared(two.file, twoHosts, two.shown);
    problems.push(...twoCompared.verdict.problems.map((p) => `two sessions: ${p}`));
    const invalid = await validateHar(twoCompared.text);
    if (invalid !== null) problems.push(`two sessions: har-validator: ${invalid}`);
    const served = servers.slice(0, 2).reduce((n, t) => n + t.server.getRequestLog().length, 0);

    await tick("s03.localhost");
    const three = await exportTicked(two.file);
    const withThird = compared(three.file, twoHosts, two.shown).verdict.problems;
    if (!withThird.some((p) => p.startsWith("unexpected entry")))
      problems.push(`two sessions: a third ticked site was not caught: ${withThird.join("; ")}`);

    const moment = async (site: string): Promise<ExclusionMoment> => ({
      prompts: await page.run<number>(PROMPTS),
      onDisk: onDisk(site),
      listed: await listed(site),
    });
    const site = "s03.localhost";
    await showSite(site);
    await page.click(NAMES.exclude);
    await page.waitFor("the question", `${PROMPTS} === 1`);
    const asked = await moment(site);
    await page.capture("history-exclude-confirm");
    await page.click(NAMES.cancel);
    await page.waitFor("the question to close", `${PROMPTS} === 0`);
    const cancelled = await moment(site);
    await page.click(NAMES.exclude);
    await page.waitFor("the question", `${PROMPTS} === 1`);
    await page.click(NAMES.confirm);
    await page.waitFor(
      "the exclusion",
      `[...document.querySelectorAll("[role=status]")].some((el) => el.textContent.includes(${JSON.stringify(`${site} is excluded`)}))`,
    );
    await until(
      async () => onDisk(site),
      (there) => !there,
      `${site}'s folder to be deleted`,
    ).catch(() => undefined);
    const settings = await api<{ user: { excludedSites: string[] } } | null>(`getSettings()`);
    const confirmed = {
      ...(await moment(site)),
      inSettings: settings?.user.excludedSites.includes(site) ?? false,
    };
    await page.capture("history-excluded");
    await visit(site, c, 3);
    await callHook(session, { kind: "flush" });
    const revisited = { onDisk: onDisk(site), listed: await listed(site) };
    const exclusion = { asked, cancelled, confirmed, revisited };
    problems.push(...checkExclusion(site, exclusion).map((p) => `exclude: ${p}`));

    const unasked = "s04.localhost";
    await visit(unasked, a, 2);
    await callHook(session, { kind: "flush" });
    await api(`excludeSite(${JSON.stringify(unasked)})`);
    const skipped = checkExclusion(unasked, { ...exclusion, asked: await moment(unasked) });
    if (!skipped.some((p) => p.includes("asked 0 times")))
      problems.push(`exclude: an exclusion that never asked was not caught: ${skipped.join("; ")}`);

    const shots: readonly PageShot[] = page.shots;
    for (const shot of shots)
      problems.push(...shot.problems.map((p) => `${shot.state} ${shot.theme}: ${p}`));
    problems.push(...audits.missed.map((m) => `the audits missed ${m}`));
    problems.push(...audits.clean.map((p) => `after the faults were removed: ${p}`));
    return result(
      `${String(shots.length)} screenshots in ${shotDir}; two sessions: ${two.file}, ${String(twoCompared.verdict.entries)} entries for ${String(served)} logged requests, ${String(twoCompared.verdict.exact)} exact; a third ticked site caught; empty selection held (${JSON.stringify(empty)}), an enabled button caught; exclusion asked once and deleted, an exclusion that never asked caught; audit faults caught: ${audits.caught.join(", ")}`,
      {
        shots: shots.map(({ file, ...rest }) => ({ ...rest, file: NodePath.basename(file) })),
        twoSessions: { file: two.file, shown: two.shown, served, ...twoCompared.verdict },
        empty,
        exclusion,
        audits,
      },
    );
  },
};

/** @discovered-check */
export default check;
