import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ReconcileStep } from "@hark/recording/reconcile";
import { readStoredBytes } from "./archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "./browser.ts";
import { checkStoredBodies, checkSummaryFiles, pathOf } from "./recording-verify.ts";
import {
  callHook,
  recordingWorkspace,
  type HookRequest,
  type RecordingWorkspace,
} from "./recording-session.ts";
import { expectedFromServer } from "./recording-truth.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";

const SITE = "127.0.0.1";
const DEADLINE_MS = 20_000;

export type CrashRunContext = {
  readonly session: BrowserSession;
  readonly server: FixtureServer;
  readonly workspace: RecordingWorkspace;
  readonly tab: string;
};

export type CrashAfterContext = {
  readonly workspace: RecordingWorkspace;
  readonly server: FixtureServer;
};

export type CrashRowSpec = {
  readonly row: number;
  readonly diedDuring: string;
  readonly plan: readonly ReconcileStep["kind"][];
  /** Brings the browser to the crash point before killAtPoint sends SIGKILL via decideSignal. */
  readonly reach: (run: CrashRunContext) => Promise<void>;
  readonly beforeRestart?: (after: CrashAfterContext) => readonly string[];
  /** How the archive reads after the next start's recovery; [] when it reads as the table says. */
  readonly reads: (after: CrashAfterContext) => readonly string[];
};

export const until = async (
  ready: () => Promise<boolean> | boolean,
  what: string,
  deadlineMs = DEADLINE_MS,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Sends a request whose answer never comes, because it parks the write chain. */
const fireHook = (session: BrowserSession, request: HookRequest): Promise<unknown> =>
  session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     Services.obs.notifyObservers({ wrappedJSObject: { request: arguments[0], done: () => undefined } }, "hark-harness");
     done(true);`,
    [request],
  );

const holdAtPoint = async (
  session: BrowserSession,
  point: string,
  act: () => Promise<unknown>,
): Promise<void> => {
  await callHook(session, { kind: "arm", point });
  await act();
  await until(
    async () => (await callHook(session, { kind: "reached", point })) === true,
    `hold ${point}`,
  );
};

/** Reaches a crash point and kills the browser tree through decideSignal and owned-process.ts. */
export async function killAtPoint(
  run: CrashRunContext,
  reach: (run: CrashRunContext) => Promise<void>,
): Promise<void> {
  await reach(run);
  await run.session.kill();
}

const fetchIn = (run: CrashRunContext, path: string): Promise<string> =>
  run.session.evaluate(
    run.tab,
    `fetch(${JSON.stringify(path)}).then((r) => r.arrayBuffer()).then(() => "done")`,
  );

const streamPart = async (run: CrashRunContext): Promise<void> => {
  await run.session.evaluate(
    run.tab,
    `(async () => { const reader = (await fetch("/id/endless")).body.getReader(); await reader.read(); window.__held = reader; return "streaming"; })()`,
  );
  const incoming = NodePath.join(run.workspace.root(), "incoming");
  await until(
    () =>
      NodeFS.readdirSync(incoming).some(
        (name) => NodeFS.statSync(NodePath.join(incoming, name)).size > 0,
      ),
    "a growing part",
  );
};

const incomingParts = (workspace: RecordingWorkspace): readonly string[] =>
  NodeFS.readdirSync(NodePath.join(workspace.root(), "incoming"));

const readSummaries = (workspace: RecordingWorkspace) => {
  const logDir = NodePath.join(workspace.root(), "sites", SITE, "log");
  if (!NodeFS.existsSync(logDir)) return [];
  return NodeFS.readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => {
      const segPath = NodePath.join(logDir, name);
      const segmentText = NodeFS.readFileSync(segPath, "utf8");
      const segBytes = NodeFS.statSync(segPath).size;
      const sumName = name.replace(/\.jsonl$/u, ".summary.json");
      const sumPath = NodePath.join(logDir, sumName);
      return {
        name: sumName,
        raw: NodeFS.existsSync(sumPath) ? NodeFS.readFileSync(sumPath, "utf8") : null,
        segmentBytes: segBytes,
        segmentText,
      };
    });
};

const absent =
  (path: string) =>
  ({ workspace, server }: CrashAfterContext): readonly string[] => {
    const lines = workspace.lines();
    const problems: string[] = [];
    if (lines.some((l) => pathOf(l.exchange) === path)) problems.push(`${path} has a line`);
    if (incomingParts(workspace).length > 0)
      problems.push(`parts left: ${incomingParts(workspace).join(", ")}`);
    const bodies = NodePath.join(workspace.root(), "sites", SITE, "bodies");
    if (NodeFS.existsSync(bodies) && NodeFS.readdirSync(bodies).length > 0)
      problems.push("a body file is left");
    problems.push(...available({ workspace, server }));
    return problems;
  };

const available = ({ workspace, server }: CrashAfterContext): readonly string[] => {
  const earlier = workspace.lines().filter((l) => pathOf(l.exchange) === "/fixtures/range");
  const verdicts = checkStoredBodies(earlier, expectedFromServer(server), (at) =>
    readStoredBytes(workspace.root(), at),
  );
  return [
    ...(verdicts.length === 1 && verdicts[0]?.verdict === "exact"
      ? []
      : [`the earlier page reads as ${JSON.stringify(verdicts.map((v) => v.verdict))}`]),
    ...checkSummaryFiles(readSummaries(workspace)),
  ];
};

const siteGone = ({ workspace }: CrashAfterContext): readonly string[] => [
  ...(NodeFS.existsSync(NodePath.join(workspace.root(), "sites", SITE))
    ? [`sites/${SITE} still exists`]
    : []),
  ...(incomingParts(workspace).length > 0
    ? [`parts left: ${incomingParts(workspace).join(", ")}`]
    : []),
];

const hasTornSummaryTmp = ({ workspace }: CrashAfterContext): readonly string[] => {
  const logDir = NodePath.join(workspace.root(), "sites", SITE, "log");
  const files = NodeFS.existsSync(logDir) ? NodeFS.readdirSync(logDir) : [];
  const problems: string[] = [];
  if (!files.some((name) => name.endsWith(".summary.json.tmp")))
    problems.push("no .summary.json.tmp left before restart");
  if (files.some((name) => name.endsWith(".summary.json")))
    problems.push(".summary.json already present before restart");
  return problems;
};

/** The rows of the crash table (packages/recording/test/crash-rows.ts) that a browser killed at a point can reach. */
export const CRASH_ROWS: readonly CrashRowSpec[] = [
  {
    row: 1,
    diedDuring: "a file tee, streaming",
    plan: ["delete-part", "summarize-log"],
    reach: streamPart,
    reads: absent("/id/endless"),
  },
  {
    row: 3,
    diedDuring: "after the rename, before the line flushed",
    plan: ["delete-orphan-body", "summarize-log"],
    reach: (run) =>
      holdAtPoint(run.session, "before-line-append", () => fetchIn(run, "/id/big?delayMs=0")),
    reads: absent("/id/big"),
  },
  {
    row: 6,
    diedDuring: "after the pack append, before the line append",
    plan: ["summarize-log"],
    reach: (run) => holdAtPoint(run.session, "before-line-append", () => fetchIn(run, "/poll")),
    reads: absent("/poll"),
  },
  {
    row: 14,
    diedDuring: "an exclusion, after settings, during the directory delete",
    plan: ["delete-excluded-site"],
    reach: (run) =>
      holdAtPoint(run.session, "exclusion-mid-delete", () =>
        fireHook(run.session, { kind: "exclude", site: SITE }),
      ),
    reads: siteGone,
  },
  {
    row: 16,
    diedDuring: "a summary write, during the .tmp write",
    plan: ["delete-tmp", "summarize-log"],
    reach: (run) =>
      holdAtPoint(run.session, "summary-tmp-written", () =>
        fireHook(run.session, { kind: "seal" }),
      ),
    beforeRestart: hasTornSummaryTmp,
    reads: available,
  },
  {
    row: 18,
    diedDuring: "an exclusion while a tee for that site streamed",
    plan: ["delete-excluded-site", "delete-part"],
    reach: async (run) => {
      await streamPart(run);
      await holdAtPoint(run.session, "exclusion-mid-delete", () =>
        fireHook(run.session, { kind: "exclude", site: SITE }),
      );
    },
    reads: siteGone,
  },
];

export async function runCrashRow(
  row: CrashRowSpec,
  options: {
    readonly binaryPath: string;
    readonly extensionPath: string;
    readonly display: "headless" | "window";
    readonly signal: AbortSignal;
    readonly kill?: typeof killAtPoint;
  },
): Promise<{
  readonly steps: readonly ReconcileStep["kind"][];
  readonly problems: readonly string[];
}> {
  await using server = await startFixtureServer();
  await using workspace = recordingWorkspace(`crash-${String(row.row)}`);
  const addonId = await readExtensionId(options.extensionPath);
  const popupPath = await readExtensionPopupPath(options.extensionPath);
  const base = {
    binaryPath: options.binaryPath,
    display: options.display,
    protocol: "marionette" as const,
    signal: options.signal,
  };
  const problems: string[] = [];
  {
    await using session = await workspace.launch({ ...base, extensionPath: options.extensionPath });
    await waitForActiveExtensionUrl(session, addonId, popupPath);
    const tab = await session.openTab(`${server.origin}/id/download.html`);
    await session.evaluate(
      tab,
      `fetch("/fixtures/range", { headers: { Range: "bytes=1000-1999" } }).then((r) => r.arrayBuffer()).then(() => "done")`,
    );
    await callHook(session, { kind: "flush" });
    await (options.kill ?? killAtPoint)({ session, server, workspace, tab }, row.reach);
  }
  if (row.beforeRestart !== undefined) problems.push(...row.beforeRestart({ workspace, server }));
  let stepKinds: readonly ReconcileStep["kind"][] = [];
  {
    await using session = await workspace.launch({ ...base, extensionPath: null });
    await waitForActiveExtensionUrl(session, addonId, popupPath);
    const steps = (await callHook(session, { kind: "recovery" })) as readonly ReconcileStep[];
    stepKinds = steps.map((step) => step.kind);
    if (JSON.stringify(stepKinds) !== JSON.stringify(row.plan)) {
      problems.push(
        `row ${String(row.row)} planned ${JSON.stringify(stepKinds)}, expected ${JSON.stringify(row.plan)}`,
      );
    }
  }
  problems.push(...row.reads({ workspace, server }));
  return { steps: stepKinds, problems };
}

async function runCorruptSummaryRow(
  options: {
    readonly binaryPath: string;
    readonly extensionPath: string;
    readonly display: "headless" | "window";
    readonly signal: AbortSignal;
  },
  label: string,
  corrupt: (logDir: string, summaryName: string) => void,
): Promise<{
  readonly steps: readonly ReconcileStep["kind"][];
  readonly problems: readonly string[];
}> {
  await using server = await startFixtureServer();
  await using workspace = recordingWorkspace(label);
  const addonId = await readExtensionId(options.extensionPath);
  const popupPath = await readExtensionPopupPath(options.extensionPath);
  const base = {
    binaryPath: options.binaryPath,
    display: options.display,
    protocol: "marionette" as const,
    signal: options.signal,
  };
  const problems: string[] = [];
  {
    await using session = await workspace.launch({ ...base, extensionPath: options.extensionPath });
    await waitForActiveExtensionUrl(session, addonId, popupPath);
    const tab = await session.openTab(`${server.origin}/id/download.html`);
    await session.evaluate(
      tab,
      `fetch("/fixtures/range", { headers: { Range: "bytes=1000-1999" } }).then((r) => r.arrayBuffer()).then(() => "done")`,
    );
    await callHook(session, { kind: "seal" });
  }
  const logDir = NodePath.join(workspace.root(), "sites", SITE, "log");
  const summaries = NodeFS.readdirSync(logDir).filter((name) => name.endsWith(".summary.json"));
  if (summaries.length !== 1 || summaries[0] === undefined) {
    return {
      steps: [],
      problems: [`expected 1 summary before corrupting it, got ${String(summaries.length)}`],
    };
  }
  corrupt(logDir, summaries[0]);
  if (checkSummaryFiles(readSummaries(workspace)).length === 0) {
    problems.push(`${label} corrupted summary was trusted by checkSummaryFiles`);
  }
  let stepKinds: readonly ReconcileStep["kind"][] = [];
  {
    await using session = await workspace.launch({ ...base, extensionPath: null });
    await waitForActiveExtensionUrl(session, addonId, popupPath);
    const steps = (await callHook(session, { kind: "recovery" })) as readonly ReconcileStep[];
    stepKinds = steps.map((step) => step.kind);
    const expected: readonly ReconcileStep["kind"][] = ["delete-invalid-summary", "summarize-log"];
    if (JSON.stringify(stepKinds) !== JSON.stringify(expected)) {
      problems.push(
        `${label} planned ${JSON.stringify(stepKinds)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  problems.push(...available({ workspace, server }));
  return { steps: stepKinds, problems };
}

/** Row 17: an unreadable summary written over the real one is caught before recovery, deleted, and re-summarized. */
export const runRow17Corrupt = (options: {
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly display: "headless" | "window";
  readonly signal: AbortSignal;
}): Promise<{
  readonly steps: readonly ReconcileStep["kind"][];
  readonly problems: readonly string[];
}> =>
  runCorruptSummaryRow(options, "crash-17", (logDir, summaryName) => {
    NodeFS.writeFileSync(NodePath.join(logDir, summaryName), "{corrupt-unreadable-summary", "utf8");
  });

/** Row 17b: a valid JSON summary whose byte count no longer matches its grown log is deleted and re-summarized. */
export const runRow17bCorrupt = (options: {
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly display: "headless" | "window";
  readonly signal: AbortSignal;
}): Promise<{
  readonly steps: readonly ReconcileStep["kind"][];
  readonly problems: readonly string[];
}> =>
  runCorruptSummaryRow(options, "crash-17b", (logDir, summaryName) => {
    const segName = summaryName.replace(/\.summary\.json$/u, ".jsonl");
    const segPath = NodePath.join(logDir, segName);
    const lines = NodeFS.readFileSync(segPath, "utf8").trimEnd().split("\n");
    const pageLine = lines.find((line) => line.includes("/id/download.html")) ?? lines[0];
    if (pageLine === undefined) throw new Error(`no line in ${segPath}`);
    NodeFS.appendFileSync(segPath, `${pageLine}\n`, "utf8");
  });
