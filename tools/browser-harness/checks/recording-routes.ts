import { readStoredBytes } from "../src/archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { ROUTE_EVENTS_PATH, ROUTE_NO_CONTENT_PATH } from "../src/extended-fixtures.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import {
  flipFirstByte,
  checkExpectations,
  checkStoredBodies,
  routeExpectations,
  storedLines,
} from "../src/recording-verify.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { expectedFromServer } from "../src/recording-truth.ts";
import { startFixtureServer } from "../src/server.ts";

const EXTRA_FETCHES = [ROUTE_NO_CONTENT_PATH, "/id/r1", ROUTE_EVENTS_PATH];

/**
 * Each body route row's fixture settles to its row and body, and every stored body hashes to the fixture server's
 * SHA-256. One byte of one stored body flipped must read as exactly one wrong body.
 */
const check: HarnessCheck = {
  name: "recording-routes",
  description:
    "every body route row recorded as its row, every stored body byte-exact, a flipped byte caught",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const fail = (detail: string): CheckResult => ({
      name: "recording-routes",
      ok: false,
      durationMs: Date.now() - started,
      detail,
    });
    if (context.extensionPath === null) return fail("needs --extension");
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("routes");
    {
      await using session = await workspace.launch({
        binaryPath: context.binaryPath,
        extensionPath: context.extensionPath,
        display: context.display,
        protocol: "marionette",
        signal: context.signal,
      });
      await waitForActiveExtensionUrl(
        session,
        await readExtensionId(context.extensionPath),
        await readExtensionPopupPath(context.extensionPath),
      );
      const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
      await session.evaluate(tab, "window.__harnessReady");
      await session.evaluate(
        tab,
        `Promise.all(${JSON.stringify(EXTRA_FETCHES)}.map((path) => fetch(path).then((r) => r.arrayBuffer()))).then(() => "done")`,
      );
      await session.closeTab(tab);
      await callHook(session, { kind: "flush" });
    }
    const lines = workspace.lines();
    const root = workspace.root();
    const read = (at: Parameters<typeof readStoredBytes>[1]) => readStoredBytes(root, at);
    const expectedFor = expectedFromServer(server);
    const problems = [...checkExpectations(routeExpectations, lines)];
    const verdicts = checkStoredBodies(lines, expectedFor, read);
    const notExact = verdicts.filter((v) => v.verdict !== "exact");
    problems.push(...notExact.map((v) => `${v.url}: ${v.verdict} (${v.detail})`));
    const target = storedLines(lines).find((line) => expectedFor(line) !== null);
    if (target === undefined) problems.push("no stored body to flip a byte in");
    else {
      const flipped = checkStoredBodies(lines, expectedFor, flipFirstByte(read, target.body.at));
      const caught = flipped.filter((v) => v.verdict === "wrong").length;
      if (caught !== 1)
        problems.push(`a flipped byte was reported ${String(caught)} times, expected 1`);
    }
    return {
      name: "recording-routes",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `${String(lines.length)} lines; ${String(verdicts.length)} stored bodies exact against the server's SHA-256; a flipped byte is reported`
          : problems.join("; "),
      data: { verdicts, lines: lines.length },
    };
  },
};

/** @discovered-check */
export default check;
