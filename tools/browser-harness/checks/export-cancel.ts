import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { checkCancel, type CancelObservation } from "../src/export-verify.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-cancel";
const MIB = 1_048_576;
/** Cancel once this much of the file is written: well inside the first 50 MB body, which streams in chunks. */
const CANCEL_AFTER_BYTES = 6 * MIB;

/**
 * The fixtures page (two 50 MB bodies) is exported and cancelled mid-body. The export must end cancelled, having
 * written at most one more body chunk after cancel was asked, and leave no file: no .har, no .har.part, no unnamed
 * file still open, no journal line open. A stop two chunks after cancel, and an export that ended done, are reported.
 */
const check: HarnessCheck = {
  name: NAME,
  description: "cancel stops an export within one body chunk and leaves no file",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null)
      return { name: NAME, ok: false, durationMs: 0, detail: "needs --extension" };
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("export-cancel");
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, context.extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const tabId = await newestPageTab(page);
    const job = await startExport(page, {
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "cancelled",
    });
    const writing = await waitForJob(
      page,
      job.id,
      (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= CANCEL_AFTER_BYTES),
    );
    await page.session.evaluate(
      page.tab,
      `browser.hark.cancelExport(${JSON.stringify(job.id)}).then(String)`,
    );
    const final = await waitForJob(page, job.id, ended);
    // The job ends cancelled at once; the audit's stop comes when the run itself has stopped and cleaned up.
    let audit: CancelObservation["audit"] = null;
    for (const by = Date.now() + 10_000; Date.now() < by;) {
      audit = (await callHook(session, {
        kind: "export-audit",
        id: job.id,
      })) as CancelObservation["audit"];
      if (audit?.bytesAtStop !== null && audit?.bytesAtStop !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const journal = NodePath.join(workspace.root(), "exports.jsonl");
    const fds = `/proc/${String(session.browserPid)}/fd`;
    const observation: CancelObservation = {
      state: final.state.kind,
      audit,
      left: NodeFS.readdirSync(workspace.downloads).filter((name) => name.startsWith("cancelled")),
      journal: NodeFS.existsSync(journal) ? NodeFS.readFileSync(journal, "utf8") : "",
      // /proc names an unnamed file `<folder>/#<inode> (deleted)`.
      openUnnamed: NodeFS.readdirSync(fds).filter((fd) => {
        try {
          return NodeFS.readlinkSync(`${fds}/${fd}`).startsWith(`${workspace.downloads}/#`);
        } catch {
          return false;
        }
      }).length,
    };
    const problems = [...checkCancel(observation)];
    if (writing.state.kind !== "writing")
      problems.push(`ended before cancel: ${JSON.stringify(writing.state)}`);
    const missed = [
      { ...observation, audit: { bytesAtCancel: 0, bytesAtStop: 11 * MIB } },
      { ...observation, state: "done" },
    ].filter((wrong) => checkCancel(wrong).length === 0);
    if (missed.length > 0)
      problems.push(`wrong cancel outcomes were not reported: ${JSON.stringify(missed)}`);
    return {
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `cancelled at ${String(audit?.bytesAtCancel)} bytes, stopped at ${String(audit?.bytesAtStop)}; no file left, named or open; journal ended; a late stop and a finished export are reported`
          : problems.join("; "),
      data: observation,
    };
  },
};

/** @discovered-check */
export default check;
