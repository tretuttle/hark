import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ARCHIVE_KEY_FILE } from "@hark/recording/layout";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { checkArchiveModes, checkDownloads } from "../src/recording-verify.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

type Status = { readonly recording: boolean; readonly problems: readonly string[] };

/** The tab stays open: under real-defaults, Developer Edition 161 refuses the harness's switch back after a close. */
const statusOf = async (session: BrowserSession, popupUrl: string): Promise<Status> =>
  JSON.parse(
    await session.evaluate(
      await session.openTab(popupUrl),
      "browser.hark.getRecordingStatus().then(JSON.stringify)",
    ),
  ) as Status;

const downloadTargets = async (session: BrowserSession): Promise<readonly string[]> =>
  (await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
     Downloads.getList(Downloads.ALL).then((list) => list.getAll()).then((all) => done(all.map((d) => d.target.path)));`,
  )) as readonly string[];

const MOZ_SRC_TARGET = `const done = arguments[arguments.length - 1];
  const spec = Services.io.getProtocolHandler("moz-src").QueryInterface(Ci.nsISubstitutingProtocolHandler)
    .resolveURI(Services.io.newURI("moz-src:///"));
  const outer = spec.startsWith("jar:") ? spec.slice(4, spec.indexOf("!/")) : spec;
  done(Services.io.newURI(outer).QueryInterface(Ci.nsIFileURL).file.path);`;

/**
 * The archive is $XDG_DATA_HOME/hark/<key>, the key 128 random bits kept in the profile, directories 0700 and
 * files 0600; nothing reaches the Downloads list; the status names a file:// page's way in; the folder guard covers
 * moz-src:// and refuses an archive inside the profile. A download added under the data home must be reported, and
 * an archive folder inside the profile must be refused.
 */
const check: HarnessCheck = {
  name: "recording-archive",
  description:
    "archive root, modes and unguessable name; nothing in Downloads; status and folder guard",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const problems: string[] = [];
    if (context.extensionPath === null) {
      return { name: "recording-archive", ok: false, durationMs: 0, detail: "needs --extension" };
    }
    const addonId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    await using server = await startFixtureServer();
    await using first = recordingWorkspace("archive-a");
    await using second = recordingWorkspace("archive-b");
    const base = {
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette" as const,
      signal: context.signal,
    };
    let entries: ReturnType<typeof first.entries> = [];
    {
      await using session = await first.launch({ ...base, launchMode: "recommended" });
      const popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
      const status = await statusOf(session, popupUrl);
      if (!status.recording || !status.problems.includes("file-pages-can-read-files"))
        problems.push(`with strict_origin_policy false the status was ${JSON.stringify(status)}`);
      const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
      await session.evaluate(tab, "window.__harnessReady");
      await session.closeTab(tab);
      await callHook(session, { kind: "seal" });

      const downloads = checkDownloads(await downloadTargets(session), first.dataHome);
      if (downloads !== null) problems.push(downloads);
      await session.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
         Downloads.createDownload({ source: arguments[0], target: arguments[1] })
           .then((d) => Downloads.getList(Downloads.ALL).then((list) => list.add(d))).then(() => done(true));`,
        [`${server.origin}/fixtures/no-store`, NodePath.join(first.dataHome, "stray.bin")],
      );
      if (checkDownloads(await downloadTargets(session), first.dataHome) === null)
        problems.push("a download added under the data home was not reported");

      const mozSrc = (await session.evaluateChrome(MOZ_SRC_TARGET)) as string;
      const guard = (await callHook(session, { kind: "guard", path: first.root() })) as {
        readonly forbidden: { readonly substitutions: readonly string[] };
        readonly verdict: { readonly ok: boolean };
      };
      if (!guard.forbidden.substitutions.includes(mozSrc))
        problems.push(`the folder guard does not cover moz-src:// (${mozSrc})`);
      if (!guard.verdict.ok) problems.push("the folder guard refused the archive's own root");
      entries = first.entries();
    }
    const key = first.root().split(NodePath.sep).at(-1) ?? "";
    const profileHash = NodeCrypto.createHash("sha256").update(first.profileDir).digest("hex");
    if (!/^[0-9a-f]{32}$/.test(key) || profileHash.startsWith(key.slice(0, 16)))
      problems.push(`archive name ${key} is not 128 random bits`);
    if (first.root() !== NodePath.join(first.dataHome, "hark", key))
      problems.push(`archive root ${first.root()} is not $XDG_DATA_HOME/hark/<key>`);
    const keyMode = NodeFS.statSync(NodePath.join(first.profileDir, ARCHIVE_KEY_FILE)).mode & 0o777;
    if (keyMode !== 0o600) problems.push(`key file mode ${keyMode.toString(8)}`);
    problems.push(...checkArchiveModes(entries, ["jsonl", "summary.json", "pack", "body"]));

    {
      await using session = await second.launch({ ...base, launchMode: "real-defaults" });
      const popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
      const status = await statusOf(session, popupUrl);
      if (!status.recording || status.problems.length > 0)
        problems.push(`with real defaults the status was ${JSON.stringify(status)}`);
    }
    if (second.root().endsWith(key)) problems.push("two profiles got the same archive name");

    {
      await using session = await second.launch({
        ...base,
        extensionPath: null,
        dataHome: NodePath.join(second.profileDir, "data-inside-profile"),
      });
      const popupUrl = await waitForActiveExtensionUrl(session, addonId, popupPath);
      const status = await statusOf(session, popupUrl);
      if (status.recording || !status.problems.includes("archive-refused"))
        problems.push(
          `with the data home inside the profile the status was ${JSON.stringify(status)}`,
        );
    }

    return {
      name: "recording-archive",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `root $XDG_DATA_HOME/hark/<32 hex>, ${String(entries.length)} entries 0700/0600, key file 0600; Downloads list untouched (an added download is reported); status names strict_origin_policy; guard covers moz-src:// and refuses an archive inside the profile`
          : problems.join("; "),
      data: { entries },
    };
  },
};

/** @discovered-check */
export default check;
