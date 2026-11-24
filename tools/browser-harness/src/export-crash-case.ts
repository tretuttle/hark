import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { readExtensionId, readExtensionPopupPath, waitForActiveExtensionUrl } from "./browser.ts";
import { checkAfterCrash } from "./export-verify.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  waitForJob,
} from "./export-session.ts";
import { FIXTURES_PAGE_PATH } from "./fixtures.ts";
import { callHook, recordingWorkspace } from "./recording-session.ts";
import { startFixtureServer } from "./server.ts";

const MIB = 1_048_576;

export type ExportCrashResult = {
  readonly writingKind: string;
  readonly beforeRestartNamed: readonly string[];
  readonly journalExists: boolean;
  readonly leftoverProblems: readonly string[];
};

/**
 * Runs one crash-row-13 case against a real browser: writes at least 1 MiB, SIGKILLs mid-write,
 * optionally leaves an unjournaled file behind, restarts, and checks what recovery reports left over.
 */
export async function runExportCrashCase(options: {
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly namedParts: boolean;
  readonly unjournaledLeftover: boolean;
}): Promise<ExportCrashResult> {
  await using server = await startFixtureServer();
  await using workspace = recordingWorkspace(`export-crash-${String(options.unjournaledLeftover)}`);
  const base = {
    binaryPath: options.binaryPath,
    display: "headless" as const,
    protocol: "marionette" as const,
    signal: new AbortController().signal,
  };
  const named = () => NodeFS.readdirSync(workspace.downloads).filter((n) => n.startsWith("killed"));
  let writingKind = "";
  {
    await using session = await workspace.launch({
      ...base,
      extensionPath: options.extensionPath,
      ...(options.namedParts
        ? {
            extraPrefs: [{ name: "extensions.hark.harness.namedParts", value: true }],
          }
        : {}),
    });
    const page = await openExtensionPage(session, options.extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const job = await startExport(page, {
      selection: {
        scope: "tab",
        tabId: await newestPageTab(page),
        range: { kind: "since-tab-opened" },
        include: "all",
      },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "killed",
    });
    const writing = await waitForJob(
      page,
      job.id,
      (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
    );
    writingKind = writing.state.kind;
    await session.kill();
  }
  const journal = NodePath.join(workspace.root(), "exports.jsonl");
  const beforeRestartNamed = named();
  const journalExists = NodeFS.existsSync(journal);
  if (options.unjournaledLeftover && options.namedParts) NodeFS.rmSync(journal);
  if (options.unjournaledLeftover && !options.namedParts)
    NodeFS.writeFileSync(NodePath.join(workspace.downloads, "killed.har"), "");
  let leftoverProblems: readonly string[] = [];
  {
    await using session = await workspace.launch({ ...base, extensionPath: null });
    await waitForActiveExtensionUrl(
      session,
      await readExtensionId(options.extensionPath),
      await readExtensionPopupPath(options.extensionPath),
    );
    const steps = (await callHook(session, { kind: "recovery" })) as readonly {
      kind: string;
    }[];
    leftoverProblems = checkAfterCrash({
      steps: steps.map((s) => s.kind),
      left: named(),
      journaled: options.namedParts,
    });
  }
  return { writingKind, beforeRestartNamed, journalExists, leftoverProblems };
}
