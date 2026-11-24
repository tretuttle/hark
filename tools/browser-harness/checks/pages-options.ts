import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { FLUSH_BATCH_BYTES, LAYOUT } from "@hark/recording/layout";
import type { BrowserSession } from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { ended, waitForJob, type Job } from "../src/export-session.ts";
import { PageDriver, pickFolderNext, until, type PageShot } from "../src/pages-driver.ts";
import {
  checkCapAtStart,
  checkFolderRefused,
  compareSettings,
  checkStatusBlock,
  settingsOnDisk,
  type SettingsReading,
  type StatusBlock,
} from "../src/pages-verify.ts";
import { measureArchiveDisk } from "../src/recording-verify.ts";
import { callHook, recordingWorkspace, type RecordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "pages-options";
const MiB = 1_048_576;
/** The floor the settings parser raises any lower limit to; the page's smallest choice. */
const FLOOR = 64 * MiB;
const BLOB_BYTES = 10_000_000;
const BLOBS = 8;

/** What the user sets through the page. Written here from the request, not read from the product. */
const SET: SettingsReading = {
  maxBodyBytes: FLOOR,
  maxAgeDays: 3,
  media: "keep-bodies",
  secretStorage: "never-store",
  bodies: "omit",
  secrets: "remove",
  excludedSites: ["s09.localhost"],
};

/** The page's controls by the text a user reads beside them. */
const LABELS = {
  limit: "Storage limit for response bodies",
  keep: "Keep data for",
  media: { "details-only": "Record details only", "keep-bodies": "Keep bodies" },
  secretStorage: { store: "Store them", "never-store": "Never store them" },
  bodies: "Include response bodies",
  secrets: "Remove secrets",
} as const;

/**
 * The troubleshooting sections and the problem each explains. Written here, not read from the product: a section
 * shows only while its problem is reported or the page was opened at it.
 */
const PROBLEM_SECTIONS = {
  "export-holding": "over-cap-while-exporting",
  "unreadable-files": "archive-entries-unreadable",
} as const;
type ProblemSection = keyof typeof PROBLEM_SECTIONS;

/** Problem sections the page shows or hides wrongly, in its body or its side menu. */
const problemSections = async (
  page: PageDriver,
  openedAt: ProblemSection | null,
): Promise<string[]> => {
  const seen = await page.run<{ problems: string[]; sections: string[]; menu: string[] }>(
    `browser.hark.getRecordingStatus().then((s) => ({
      problems: s.problems,
      sections: [...document.querySelectorAll("section.section")].map((el) => el.id),
      menu: [...document.querySelectorAll(".sidenav a")].map((a) => a.hash.slice(1)),
    }))`,
  );
  const where = openedAt === null ? "" : ` opened at #${openedAt}`;
  return Object.entries(PROBLEM_SECTIONS).flatMap(([section, problem]) => {
    const due = section === openedAt || seen.problems.includes(problem);
    return (
      [
        ["page", seen.sections],
        ["side menu", seen.menu],
      ] as const
    )
      .filter(([, ids]) => ids.includes(section) !== due)
      .map(([part]) => `${section} is ${due ? "missing from" : "shown in"} the ${part}${where}`);
  });
};

/** The settings as the page's controls show them. */
const READ_PAGE = `(() => {
  const select = (label) => [...document.querySelectorAll("label.field")].find((l) => l.querySelector(".fl")?.textContent === label)?.querySelector("select")?.value;
  const radio = (name) => document.querySelector("input[name=" + name + "]:checked")?.closest("label").querySelector(".check-l").textContent ?? null;
  const box = (label) => [...document.querySelectorAll("label.check")].find((l) => l.querySelector(".check-l")?.textContent === label)?.querySelector("input").checked;
  return {
    limit: Number(select(${JSON.stringify(LABELS.limit)})),
    keep: Number(select(${JSON.stringify(LABELS.keep)})),
    media: radio("media"),
    secretStorage: radio("secrets"),
    bodies: box(${JSON.stringify(LABELS.bodies)}),
    secrets: box(${JSON.stringify(LABELS.secrets)}),
    excluded: [...document.querySelectorAll("#sites .list-rows > li > .grow")].map((el) => el.textContent).sort(),
  };
})()`;

type PageReading = {
  readonly limit: number;
  readonly keep: number;
  readonly media: string | null;
  readonly secretStorage: string | null;
  readonly bodies: boolean;
  readonly secrets: boolean;
  readonly excluded: readonly string[];
};

const valueOf = <T extends Record<string, string>>(labels: T, shown: string | null): string =>
  Object.entries(labels).find(([, label]) => label === shown)?.[0] ?? `unknown "${String(shown)}"`;

const fromPage = (r: PageReading): SettingsReading => ({
  maxBodyBytes: r.limit,
  maxAgeDays: r.keep,
  media: valueOf(LABELS.media, r.media),
  secretStorage: valueOf(LABELS.secretStorage, r.secretStorage),
  bodies: r.bodies ? "include" : "omit",
  secrets: r.secrets ? "remove" : "keep",
  excludedSites: r.excluded,
});

const statusBlock = (page: PageDriver): Promise<StatusBlock> =>
  page.run<StatusBlock>(`({
    text: document.querySelector(".status-block")?.textContent ?? "",
    controls: [...document.querySelectorAll("button, a[href], input, select")].map((el) =>
      (el.getAttribute("aria-label") ?? (el.labels?.[0]?.textContent) ?? el.textContent ?? "").trim()),
  })`);

/** A select changed as a user's choice changes it: React reads the native value setter and the change event. */
const choose = (label: string, value: number) => `(() => {
  const select = [...document.querySelectorAll("label.field")].find((l) => l.querySelector(".fl")?.textContent === ${JSON.stringify(label)}).querySelector("select");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(String(value))});
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;
const clickLabelled = (label: string) => `(() => {
  const found = [...document.querySelectorAll("label.check")].find((l) => l.querySelector(".check-l")?.textContent === ${JSON.stringify(label)});
  if (found === undefined) throw new Error("no control labelled " + ${JSON.stringify(label)});
  found.querySelector("input").click();
  return true;
})()`;
const typeSite = (site: string) => `(() => {
  const input = document.querySelector("#sites input[type=text]");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(site)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const settingsFile = (workspace: RecordingWorkspace): string | null => {
  const path = NodePath.join(workspace.root(), LAYOUT.settings);
  return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;
};
const savedFolder = (workspace: RecordingWorkspace) => {
  const text = settingsFile(workspace);
  return text === null
    ? null
    : (JSON.parse(text) as { exportFolder: { kind: string; path?: string } }).exportFolder;
};

/** Every recorded body of the site, exported through the API, as the history page's Export site does. */
async function exportSite(
  page: PageDriver,
  workspace: RecordingWorkspace,
  fileName: string,
): Promise<string> {
  const job = await page.run<Job>(
    `browser.hark.startExport(${JSON.stringify({
      selection: {
        scope: "site",
        site: "127.0.0.1",
        range: { kind: "everything" },
        include: "all",
      },
      bodies: "include",
      redaction: "none",
      packaging: "har",
      fileName,
    })})`,
  );
  const done = await waitForJob(page.page, job.id, ended);
  if (done.state.kind !== "done")
    throw new Error(`export ${fileName}: ${JSON.stringify(done.state)}`);
  return NodeFS.readFileSync(NodePath.join(workspace.downloads, done.state.fileName), "utf8");
}

/**
 * The options page: the status block says recording cannot be turned off; troubleshooting sections show only when
 * relevant; settings survive a restart, on disk and on the page; a cap lowered to the 64 MiB floor holds at the next
 * start while an export keeps every request; a folder in the profile is refused with a reason. Each check also runs
 * on a deliberately broken input and must fail there; every state is screenshotted and audited.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "the status block says recording cannot be turned off, troubleshooting shows only when relevant, settings survive a restart, a lowered cap applies at the next start, and a folder in the profile is refused",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const problems: string[] = [];
    const shots: PageShot[] = [];
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
    const extensionPath = context.extensionPath;
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace(NAME);
    const shotDir =
      context.outDir === null
        ? NodePath.join(workspace.downloads, "..", "shots")
        : NodePath.join(context.outDir, NAME);
    NodeFS.mkdirSync(shotDir, { recursive: true });
    let launches = 0;
    const launch = (
      target: RecordingWorkspace,
      extra: { dataHome?: string; apiOff?: boolean } = {},
    ) => {
      launches += 1;
      context.log(`${NAME}: launch ${String(launches)}`);
      return target.launch({
        binaryPath: context.binaryPath,
        extensionPath,
        display: context.display,
        protocol: "marionette",
        signal: context.signal,
        extraPrefs: [
          { name: "security.fileuri.strict_origin_policy", value: true },
          ...(extra.apiOff === true
            ? [{ name: "extensions.experiments.enabled", value: false }]
            : []),
        ],
        ...(extra.dataHome === undefined ? {} : { dataHome: extra.dataHome }),
      });
    };
    const open = async (
      session: BrowserSession,
      name: "options" | "history",
      section: string | null = null,
    ) =>
      PageDriver.open(
        session,
        await PageDriver.origin(session, extensionPath),
        name,
        shotDir,
        context.log,
        section,
      );
    const settled = (page: PageDriver, ok: string) =>
      until(
        () => page.run<boolean>(`browser.hark.getSettings().then((s) => ${ok})`),
        (v) => v,
        `settings where ${ok}`,
      );

    let status: StatusBlock | null = null;
    let statusBroken: string[] = [];
    let refusal: { shown: string | null; linked: string | null } = { shown: null, linked: null };
    let beforeCap = "";
    let diskBeforeRestart = 0;
    let audits: Awaited<ReturnType<PageDriver["checkAudits"]>> | null = null;
    {
      await using session = await launch(workspace);
      const web = await session.openTab(`${server.origin}/retention/page`);
      await session.evaluate(
        web,
        `(async () => {
          for (let i = 0; i < ${String(BLOBS)}; i += 1)
            await fetch("/retention/blob?bytes=${String(BLOB_BYTES)}&tag=cap-" + i).then((r) => r.arrayBuffer());
          return "done";
        })()`,
      );
      await callHook(session, { kind: "flush" });
      const page = await open(session, "options");
      await page.waitFor(
        "the settings",
        `document.querySelector(".page")?.dataset.view === "ready"`,
      );
      beforeCap = await exportSite(page, workspace, "before-cap");
      await page.capture("options-ready");
      audits = await page.checkAudits();
      problems.push(...(await problemSections(page, null)));
      for (const section of Object.keys(PROBLEM_SECTIONS) as ProblemSection[]) {
        const linked = await open(session, "options", section);
        await linked.waitFor(
          "the settings",
          `document.querySelector(".page")?.dataset.view === "ready"`,
        );
        problems.push(...(await problemSections(linked, section)));
        await linked.capture(`options-linked-${section}`);
        shots.push(...linked.shots);
      }

      status = await statusBlock(page);
      problems.push(...checkStatusBlock(status).map((p) => `status: ${p}`));
      await page.run(
        `(document.querySelector(".status-block p:nth-of-type(2)").textContent = "Recording runs whenever the browser is open.", true)`,
      );
      const droppedSentence = checkStatusBlock(await statusBlock(page));
      await page.reload();
      await page.waitFor(
        "the settings",
        `document.querySelector(".page")?.dataset.view === "ready"`,
      );
      await page.run(
        `(document.querySelector("#status").insertAdjacentHTML("beforeend", '<button type="button">Pause recording</button>'), true)`,
      );
      const addedSwitch = checkStatusBlock(await statusBlock(page));
      statusBroken = [droppedSentence.join(), addedSwitch.join()];
      if (droppedSentence.length === 0) problems.push("status: a dropped sentence was not caught");
      if (addedSwitch.length === 0)
        problems.push("status: an added recording switch was not caught");
      await page.reload();
      await page.waitFor(
        "the settings",
        `document.querySelector(".page")?.dataset.view === "ready"`,
      );

      await page.run(choose(LABELS.limit, SET.maxBodyBytes));
      await settled(page, `s.user.retention.maxBodyBytes === ${String(SET.maxBodyBytes)}`);
      await page.run(choose(LABELS.keep, SET.maxAgeDays));
      await settled(page, `s.user.retention.maxAgeDays === ${String(SET.maxAgeDays)}`);
      await page.run(clickLabelled(LABELS.media["keep-bodies"]));
      await settled(page, `s.user.media === "keep-bodies"`);
      await page.run(clickLabelled(LABELS.secretStorage["never-store"]));
      await settled(page, `s.user.secretStorage === "never-store"`);
      await page.run(clickLabelled(LABELS.bodies));
      await settled(page, `s.user.exportDefaults.bodies === "omit"`);
      await page.run(typeSite("s09.localhost"));
      await page.click("Exclude");
      await page.waitFor(
        "the question",
        `document.querySelectorAll("[role=alertdialog]").length === 1`,
      );
      await page.click("Exclude and delete");
      await settled(page, `s.user.excludedSites.includes("s09.localhost")`);

      const inside = NodePath.join(workspace.profileDir, "exports-in-profile");
      NodeFS.mkdirSync(inside, { recursive: true });
      const before = savedFolder(workspace);
      const choose_ = async (folder: string) => {
        await pickFolderNext(session, folder);
        await page.click("Choose folder");
        await page.waitFor(
          `the choice of ${folder}`,
          `document.querySelector(".refused") !== null || document.querySelector(".folder-name")?.textContent === ${JSON.stringify(NodePath.basename(folder))}`,
        );
        return {
          shown: await page.run<string | null>(
            `document.querySelector(".refused")?.textContent ?? null`,
          ),
          saved: savedFolder(workspace),
        };
      };
      const insideChoice = await choose_(inside);
      problems.push(...checkFolderRefused(insideChoice, before).map((p) => `folder: ${p}`));
      await page.capture("options-folder-refused");
      const link = NodePath.join(workspace.downloads, "..", "link-into-profile");
      NodeFS.symlinkSync(inside, link);
      const linkChoice = await choose_(link);
      problems.push(
        ...checkFolderRefused(linkChoice, before).map((p) => `folder through a link: ${p}`),
      );
      refusal = { shown: insideChoice.shown, linked: linkChoice.shown };
      const outside = NodePath.join(workspace.downloads, "..", "chosen-exports");
      NodeFS.mkdirSync(outside, { recursive: true });
      const outsideChoice = await choose_(outside);
      if (checkFolderRefused(outsideChoice, before).length === 0)
        problems.push("folder: a folder outside the profile was reported as refused");
      if (outsideChoice.saved?.path !== outside)
        problems.push(
          `folder: the folder outside the profile was not saved: ${JSON.stringify(outsideChoice.saved)}`,
        );
      await page.capture("options-changed");
      await page.click("Use Downloads");
      await settled(page, `s.exportTo.kind === "downloads"`);

      problems.push(
        ...compareSettings("settings.json", SET, settingsOnDisk(settingsFile(workspace))),
      );
      diskBeforeRestart = measureArchiveDisk(workspace.root()).bodyBytes;
      shots.push(...page.shots);
    }

    let capVerdict: ReturnType<typeof checkCapAtStart> | null = null;
    let diskAfterRestart = 0;
    {
      await using session = await launch(workspace);
      const page = await open(session, "options");
      await page.waitFor(
        "the settings",
        `document.querySelector(".page")?.dataset.view === "ready"`,
      );
      problems.push(
        ...compareSettings(
          "the page after a restart",
          SET,
          fromPage(await page.run<PageReading>(READ_PAGE)),
        ),
      );
      await page.capture("options-after-restart");
      diskAfterRestart = measureArchiveDisk(workspace.root()).bodyBytes;
      const reference = { host: `127.0.0.1:${String(server.port)}`, server };
      capVerdict = checkCapAtStart({
        cap: FLOOR,
        bodyBytesOnDisk: diskAfterRestart,
        slack: FLUSH_BATCH_BYTES,
        har: await exportSite(page, workspace, "after-cap"),
        server: reference,
      });
      problems.push(...capVerdict.problems.map((p) => `cap: ${p}`));
      const unlowered = checkCapAtStart({
        cap: FLOOR,
        bodyBytesOnDisk: diskAfterRestart,
        slack: FLUSH_BATCH_BYTES,
        har: beforeCap,
        server: reference,
      });
      if (!unlowered.problems.some((p) => p.includes("did not apply")))
        problems.push("cap: the export taken before the cap was lowered was not caught");
      shots.push(...page.shots);
    }

    let lostSettings: readonly string[] = [];
    {
      NodeFS.rmSync(NodePath.join(workspace.root(), LAYOUT.settings));
      await using session = await launch(workspace);
      const page = await open(session, "options");
      await page.waitFor(
        "the settings",
        `document.querySelector(".page")?.dataset.view === "ready"`,
      );
      lostSettings = compareSettings(
        "deleted settings",
        SET,
        fromPage(await page.run<PageReading>(READ_PAGE)),
      );
      if (lostSettings.length === 0) problems.push("restart: deleted settings were not caught");
    }

    {
      await using refused = recordingWorkspace(`${NAME}-stopped`);
      await using session = await launch(refused, {
        dataHome: NodePath.join(refused.profileDir, "archive-inside-profile"),
      });
      const options = await open(session, "options");
      await options.waitFor(
        "the stopped page",
        `document.querySelector(".page")?.dataset.view === "stopped"`,
      );
      await options.capture("options-stopped");
      const history = await open(session, "history");
      await history.waitFor(
        "the empty history",
        `document.querySelector(".page")?.dataset.view === "empty"`,
      );
      await history.capture("history-stopped");
      shots.push(...options.shots, ...history.shots);
    }
    {
      await using off = recordingWorkspace(`${NAME}-api-off`);
      await using session = await launch(off, { apiOff: true });
      for (const name of ["options", "history"] as const) {
        const page = await open(session, name);
        await page.waitFor(
          "the missing API",
          `document.querySelector(".page")?.dataset.view === "api-missing"`,
        );
        await page.capture(`${name}-api-missing`);
        shots.push(...page.shots);
      }
    }

    for (const shot of shots)
      problems.push(...shot.problems.map((p) => `${shot.state} ${shot.theme}: ${p}`));
    if (audits !== null) {
      problems.push(...audits.missed.map((m) => `the audits missed ${m}`));
      problems.push(...audits.clean.map((p) => `after the faults were removed: ${p}`));
    }
    return result(
      `${String(shots.length)} screenshots in ${shotDir}; status block says recording cannot be turned off, a dropped sentence and an added switch caught; troubleshooting sections shown only when reported or linked; settings survived a restart on disk and on the page, deleted settings caught; cap ${String(FLOOR)} at the next start: ${String(diskBeforeRestart)} body bytes before the restart, ${String(diskAfterRestart)} after, ${String(capVerdict?.removed)} bodies removed, ${String(capVerdict?.exact)} exact, every request kept, an export taken before the cap was lowered caught; folder in the profile refused (and through a link), a folder outside it accepted; audit faults caught: ${audits?.caught.join(", ") ?? "none"}`,
      {
        shots: shots.map(({ file, ...rest }) => ({ ...rest, file: NodePath.basename(file) })),
        status,
        statusBroken,
        refusal,
        cap: { cap: FLOOR, diskBeforeRestart, diskAfterRestart, ...capVerdict },
        lostSettings,
        audits,
      },
    );
  },
};

/** @discovered-check */
export default check;
