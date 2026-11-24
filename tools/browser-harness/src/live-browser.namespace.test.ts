import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { launchBrowser, type BrowserSession } from "./browser.ts";
import { ID_CACHED_PATH, ID_INDEX_PATH, ID_REVAL_PATH } from "./extended-fixtures.ts";
import { startFixtureServer } from "./server.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";

requireIsolatedPidNamespace();

const binary = process.env.BROWSER_HARNESS_BINARY;

describe.runIf(binary !== undefined && binary.length > 0 && NodeFS.existsSync(binary))(
  "real browser",
  () => {
    it.each(["bidi", "marionette"] as const)("drives %s through two tabs", async (protocol) => {
      await using session = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol,
        signal: new AbortController().signal,
      });
      expect(session.identity.remoteProtocol).toBe(protocol);
      const first = await roundTrip(session);
      const second = await roundTrip(session);
      expect(first).toContain("Gecko");
      expect(second).toBe(first);
    });

    it("keeps security.fileuri.strict_origin_policy true under real-defaults and false under recommended", async () => {
      await using realDefaults = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "real-defaults",
        allowSystemAccess: true,
        signal: new AbortController().signal,
      });
      const realStrict = await realDefaults.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         done(Services.prefs.getBoolPref("security.fileuri.strict_origin_policy"));`,
      );
      expect(realStrict).toBe(true);

      await using recommended = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "recommended",
        allowSystemAccess: true,
        signal: new AbortController().signal,
      });
      const recommendedStrict = await recommended.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         done(Services.prefs.getBoolPref("security.fileuri.strict_origin_policy"));`,
      );
      expect(recommendedStrict).toBe(false);
    });

    it("serves all page requests under launchMode none even when MOZ_LOG is enabled", async () => {
      const previous = process.env.MOZ_LOG;
      process.env.MOZ_LOG = "timestamp,nsHttp:5,nsSocketTransport:5";
      try {
        await using server = await startFixtureServer();
        await using session = await launchBrowser({
          binaryPath: binary ?? "",
          extensionPath: null,
          display: "headless",
          launchMode: "none",
          urls: [`${server.origin}${ID_INDEX_PATH}`],
          signal: new AbortController().signal,
        });
        expect(session.launchMode).toBe("none");
        expect(session.spawnedPid).toBeGreaterThan(0);

        const deadline = Date.now() + 10_000;
        let sawEndless = false;
        while (Date.now() < deadline) {
          if (server.getRequestLog().some((entry) => entry.path === "/id/endless")) {
            sawEndless = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(sawEndless).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.MOZ_LOG;
        else process.env.MOZ_LOG = previous;
      }
    });

    it("observes real 304 revalidation and cache hits in the server request log when cache: true", async () => {
      await using server = await startFixtureServer();
      await using session = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        cache: true,
        signal: new AbortController().signal,
      });
      const tab = await session.openTab(`${server.origin}${ID_INDEX_PATH}`);
      try {
        const raw = await session.evaluate(tab, "window.__identityReady");
        const result = JSON.parse(raw) as {
          reval1: { status: number; seq: string; len: number };
          reval2: { status: number; seq: string; len: number };
          cached1: { seq: string; len: number };
          cached2: { seq: string; len: number };
        };
        expect(result.reval1.status).toBe(200);
        expect(result.reval2.status).toBe(200);
        expect(result.reval1.len).toBe(20_000);
        expect(result.reval2.len).toBe(20_000);
        expect(result.cached1.len).toBe(30_000);
        expect(result.cached2.len).toBe(30_000);
        expect(result.cached2.seq).toBe(result.cached1.seq);

        const log = server.getRequestLog();
        expect(log.filter((entry) => entry.path === ID_REVAL_PATH).map((e) => e.status)).toEqual([
          200, 304,
        ]);
        expect(log.filter((entry) => entry.path === ID_CACHED_PATH)).toHaveLength(1);
      } finally {
        await session.closeTab(tab);
      }
    });
  },
);

async function roundTrip(session: BrowserSession): Promise<string> {
  const context = await session.openTab("about:blank");
  try {
    return await session.evaluate(context, "navigator.userAgent");
  } finally {
    await session.closeTab(context);
  }
}
