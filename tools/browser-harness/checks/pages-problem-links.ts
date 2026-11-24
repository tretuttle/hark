import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { LAYOUT } from "@hark/recording/layout";
import { readExtensionId, type BrowserSession } from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { PageDriver, until, type PageShot } from "../src/pages-driver.ts";
import { checkProblemLink, type ProblemLink } from "../src/pages-verify.ts";
import { CLOSE_POPUPS, inPopup, OPEN_POPUP } from "../src/popup-driver.ts";
import { callHook, recordingWorkspace, SMALL_CAP_SETTINGS } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "pages-problem-links";
const BLOB_BYTES = 12_000_000;

/**
 * Each retention problem the popup shows, the words its row starts with, and the settings section its link must open.
 * Written here, not read from the product, so a row that links elsewhere fails.
 */
const ROWS = [
  {
    problem: "over-cap-while-exporting",
    row: "The recording is temporarily over its size limit",
    section: "export-holding",
  },
  {
    problem: "archive-entries-unreadable",
    row: "Some files in the recording could not be read on startup",
    section: "unreadable-files",
  },
] as const;

/** The add-on's options tabs, newest last, read from a page of the add-on: they share its process. */
const OPTIONS_VIEWS = `browser.extension.getViews({ type: "tab" }).filter((v) => v.location.pathname === "/options/index.html")`;

const landing = (index: number, section: string) => `(() => {
  const w = ${OPTIONS_VIEWS}[${String(index)}];
  if (w === undefined || w.document.querySelector(".page")?.dataset.view !== "ready") return null;
  const el = w.document.getElementById(${JSON.stringify(section)});
  const top = el === null ? null : el.getBoundingClientRect().top;
  return {
    section: ${JSON.stringify(section)},
    hash: w.location.hash || null,
    found: el !== null,
    inView: top !== null && top >= 0 && top < w.innerHeight,
    text: el?.innerText ?? "",
  };
})()`;

const MISSING_TAB = (section: string): ProblemLink => ({
  section,
  hash: null,
  found: false,
  inView: false,
  text: "",
});

const chrome = async (session: BrowserSession, script: string, args: readonly unknown[]) => {
  const answer = (await session.evaluateChrome(script, args)) as { ok?: boolean; error?: string };
  if (answer.ok === false) throw new Error(answer.error);
  return answer;
};

/**
 * Both retention problem rows of the real popup, raised for real (a pinned pack held over the 64 MiB cap, and an
 * unreadable folder in the archive at startup), each followed by its link: the settings tab it opens must show the
 * row's own section, in view, with an explanation and what the user can do. A link to a section the page lacks
 * must be reported.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "each popup retention problem row links to a settings section that explains it and says what to do",
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
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace(NAME);
    const shotDir =
      context.outDir === null
        ? NodePath.join(workspace.downloads, "..", "shots")
        : NodePath.join(context.outDir, NAME);
    NodeFS.mkdirSync(shotDir, { recursive: true });

    const key = NodeCrypto.randomBytes(16).toString("hex");
    workspace.seed(key, SMALL_CAP_SETTINGS);
    const denied = NodePath.join(
      workspace.dataHome,
      "hark",
      key,
      LAYOUT.sitesDir,
      "denied.localhost",
    );
    NodeFS.mkdirSync(NodePath.join(denied, LAYOUT.packDir), { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(denied, 0o000);
    const shots: PageShot[] = [];
    const landed: ProblemLink[] = [];
    let missingSection: readonly string[] = [];
    try {
      await using session = await workspace.launch({
        binaryPath: context.binaryPath,
        extensionPath: context.extensionPath,
        display: context.display,
        protocol: "marionette",
        signal: context.signal,
        extraPrefs: [{ name: "security.fileuri.strict_origin_policy", value: true }],
      });
      const origin = await PageDriver.origin(session, context.extensionPath);
      const anchor = await PageDriver.open(session, origin, "history", shotDir, context.log);
      const url = `${server.origin}/retention/page`;
      const web = await session.openTab(url);
      const fetchBlobs = (tag: string, n: number) =>
        session.evaluate(
          web,
          `(async () => {
            for (let i = 0; i < ${String(n)}; i += 1)
              await fetch("/retention/blob?bytes=${String(BLOB_BYTES)}&tag=${tag}-" + i).then((r) => r.arrayBuffer());
            return "done";
          })()`,
        );
      await fetchBlobs("oldest", 2);
      await callHook(session, { kind: "flush" });
      await callHook(session, { kind: "seal" });
      if ((await callHook(session, { kind: "pin-oldest-pack" })) === null)
        problems.push("pin-oldest-pack found no pack to hold");
      await fetchBlobs("newer", 8);
      await callHook(session, { kind: "flush" });
      await until(
        () => anchor.run<{ problems: string[] }>(`browser.hark.getRecordingStatus()`),
        (s) => ROWS.every((r) => s.problems.includes(r.problem)),
        "both retention problems",
      );

      const addonId = await readExtensionId(context.extensionPath);
      for (const row of ROWS) {
        await chrome(session, CLOSE_POPUPS, []);
        const opened = (await chrome(session, OPEN_POPUP, [addonId, { url, private: false }])) as {
          selected?: boolean;
          detail?: unknown;
        };
        if (opened.selected !== true)
          throw new Error(`the popup did not open on ${url}: ${JSON.stringify(opened.detail)}`);
        await anchor.waitFor(
          `the popup row for ${row.problem}`,
          inPopup(
            `return [...w.document.querySelectorAll(".warn-line")].some((l) => l.textContent.startsWith(${JSON.stringify(row.row)}));`,
          ),
        );
        const before = await anchor.run<number>(`${OPTIONS_VIEWS}.length`);
        await anchor.run(
          inPopup(`const line = [...w.document.querySelectorAll(".warn-line")].find((l) => l.textContent.startsWith(${JSON.stringify(row.row)}));
            const link = line.querySelector(".btn-link");
            if (link === null) throw new Error("the row has no link");
            link.click();
            return true;`),
        );
        landed.push(
          (await until(
            () => anchor.run<ProblemLink | null>(landing(before, row.section)),
            (v) => v !== null,
            `the settings tab for ${row.problem}`,
          ).catch(() => null)) ?? MISSING_TAB(row.section),
        );
      }
      for (const link of landed) problems.push(...checkProblemLink(link));

      const before = await anchor.run<number>(`${OPTIONS_VIEWS}.length`);
      await anchor.run(
        `browser.tabs.create({ url: browser.runtime.getURL("options/index.html#over-the-limit") }).then(() => true)`,
      );
      const wrong = await until(
        () => anchor.run<ProblemLink | null>(landing(before, "over-the-limit")),
        (v) => v !== null,
        "the tab of the link to a missing section",
      );
      missingSection = checkProblemLink(wrong ?? MISSING_TAB("over-the-limit"));
      if (missingSection.length === 0)
        problems.push("a link to a section the page lacks was not caught");

      for (const row of ROWS) {
        const page = await PageDriver.open(session, origin, "options", shotDir, context.log);
        await page.run(`(location.hash = ${JSON.stringify(row.section)}, true)`);
        await page.waitFor(
          "the settings",
          `document.querySelector(".page")?.dataset.view === "ready"`,
        );
        await page.capture(`options-${row.section}`);
        shots.push(...page.shots);
      }
    } finally {
      NodeFS.chmodSync(denied, 0o700);
    }
    for (const shot of shots)
      problems.push(...shot.problems.map((p) => `${shot.state} ${shot.theme}: ${p}`));
    return result(
      `${landed.map((l) => `${l.section} opened ${String(l.hash)}, ${l.found ? "found" : "missing"}, ${l.inView ? "in view" : "out of view"}`).join("; ")}; a link to a missing section caught (${missingSection.join("; ")}); ${String(shots.length)} screenshots in ${shotDir}`,
      {
        landed: landed.map(({ text, ...rest }) => ({ ...rest, words: text.split(/\s+/u).length })),
        missingSection,
        shots: shots.map(({ file, ...rest }) => ({ ...rest, file: NodePath.basename(file) })),
      },
    );
  },
};

/** @discovered-check */
export default check;
