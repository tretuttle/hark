import * as NodeCrypto from "node:crypto";
import { readStoredBytes } from "../src/archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  ID_DOWNLOAD_PAGE_PATH,
  ID_DOWNLOAD_PATH,
  ID_ENDLESS_PATH,
  ID_INDEX_PATH,
} from "../src/extended-fixtures.ts";
import {
  flipFirstByte,
  identityExpectations,
  checkExpectations,
  checkStoredBodies,
  pathOf,
  storedLines,
} from "../src/recording-verify.ts";
import {
  callHook,
  recordingWorkspace,
  SMALL_CAP_BYTES,
  SMALL_CAP_SETTINGS,
} from "../src/recording-session.ts";
import { expectedFromServer, expectedFromText } from "../src/recording-truth.ts";
import { startFixtureServer } from "../src/server.ts";

/** The page reads this much of the endless stream, past the 16 MiB cap, then stops. */
const ENDLESS_READ_BYTES = 24 * 1_048_576;
const DOWNLOAD_DEADLINE_MS = 15_000;

/**
 * Every identity fixture is recorded as `identityExpectations` says, every stored body is byte-exact, an endless stream
 * past the body cap keeps its first part while the page reads on, and a download link counts under the page's site,
 * not the link's. A flipped byte in one stored body must be reported.
 */
const check: HarnessCheck = {
  name: "recording-identity",
  description:
    "identity fixtures recorded as designed, bodies byte-exact, cap and download site, a flipped byte caught",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const result = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: "recording-identity",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return result(["needs --extension"], "");
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("identity");
    workspace.seed(NodeCrypto.randomBytes(16).toString("hex"), SMALL_CAP_SETTINGS);
    const pageSite = "localhost";
    let page: { readonly sw: { readonly synth: string } };
    let endlessRead = 0;
    {
      await using session = await workspace.launch({
        binaryPath: context.binaryPath,
        extensionPath: context.extensionPath,
        display: context.display,
        protocol: "marionette",
        cache: true,
        signal: context.signal,
      });
      await waitForActiveExtensionUrl(
        session,
        await readExtensionId(context.extensionPath),
        await readExtensionPopupPath(context.extensionPath),
      );
      const tab = await session.openTab(`${server.origin}${ID_INDEX_PATH}`);
      page = JSON.parse(await session.evaluate(tab, "window.__identityReady")) as typeof page;
      endlessRead = Number(
        await session.evaluate(
          tab,
          `(async () => {
            const ac = new AbortController();
            const reader = (await fetch("${ID_ENDLESS_PATH}?rate=fast", { signal: ac.signal })).body.getReader();
            let got = 0;
            while (got < ${String(ENDLESS_READ_BYTES)}) { const { done, value } = await reader.read(); if (done) break; got += value.length; }
            ac.abort();
            return String(got);
          })()`,
        ),
      );
      const crossSite = await session.openTab(
        `http://${pageSite}:${String(server.port)}${ID_DOWNLOAD_PAGE_PATH}`,
      );
      await session.evaluate(
        crossSite,
        `(() => { const a = document.createElement("a"); a.href = "${server.origin}${ID_DOWNLOAD_PATH}"; document.body.append(a); a.click(); return "clicked"; })()`,
      );
      const deadline = Date.now() + DOWNLOAD_DEADLINE_MS;
      while (
        !server.getRequestLog().some((r) => r.path === ID_DOWNLOAD_PATH) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await callHook(session, { kind: "flush" });
      await session.closeTab(tab);
      await callHook(session, { kind: "flush" });
    }
    const lines = workspace.lines();
    const root = workspace.root();
    const read = (at: Parameters<typeof readStoredBytes>[1]) => readStoredBytes(root, at);
    const fromServer = expectedFromServer(server);
    const expectedFor: Parameters<typeof checkStoredBodies>[1] = (line) =>
      pathOf(line) === "/sw/synth" ? expectedFromText(page.sw.synth) : fromServer(line);

    const problems = [...checkExpectations(identityExpectations, lines)];
    const verdicts = checkStoredBodies(lines, expectedFor, read);
    problems.push(
      ...verdicts
        .filter((v) => v.verdict !== "exact")
        .map((v) => `${v.url}: ${v.verdict} (${v.detail})`),
    );

    const capped = storedLines(lines).filter(
      (l) => pathOf(l) === ID_ENDLESS_PATH && l.body.check === "first-part",
    );
    const cappedLength = capped[0]?.body.at.length ?? 0;
    if (capped.length !== 1 || cappedLength < SMALL_CAP_BYTES)
      problems.push(
        `endless stream: ${String(capped.length)} first-part lines of ${String(cappedLength)} bytes`,
      );
    if (endlessRead < ENDLESS_READ_BYTES)
      problems.push(`the page read only ${String(endlessRead)} bytes of the stream`);

    const download = lines.filter((l) => pathOf(l.exchange) === ID_DOWNLOAD_PATH);
    if (
      download.length !== 1 ||
      download[0]?.siteDir !== pageSite ||
      download[0].exchange.request.topSite !== pageSite
    )
      problems.push(
        `download line sites: ${JSON.stringify(download.map((l) => [l.siteDir, l.exchange.request.topSite]))}`,
      );

    const target = storedLines(lines).find((line) => expectedFor(line) !== null);
    if (target !== undefined) {
      const caught = checkStoredBodies(
        lines,
        expectedFor,
        flipFirstByte(read, target.body.at),
      ).filter((v) => v.verdict === "wrong").length;
      if (caught !== 1)
        problems.push(`a flipped byte was reported ${String(caught)} times, expected 1`);
    }
    return result(
      problems,
      `${String(lines.length)} lines; ${String(identityExpectations.length)} identity expectations hold; ${String(verdicts.length)} stored bodies exact; endless stream kept ${String(cappedLength)} bytes while the page read ${String(endlessRead)}; download under ${pageSite}; a flipped byte is reported`,
      { verdicts, cappedLength, endlessRead },
    );
  },
};

/** @discovered-check */
export default check;
