import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { waitForActiveExtensionUrl, type launchBrowser } from "./browser.ts";
import { runEnvironmentVerification, verifyBrowserIdentity } from "../checks/environment.ts";
import { runRestartVerification } from "../checks/restart.ts";
import { discoverChecks, runDiscoveredChecks } from "./checks.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";

requireIsolatedPidNamespace();

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("check discovery", () => {
  it("discovers every check module in checks/ sorted by name", async () => {
    const checksDir = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
      "checks",
    );
    const expected = NodeFS.readdirSync(checksDir)
      .filter(
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"),
      )
      .map((name) => name.slice(0, -".ts".length))
      .sort((left, right) => left.localeCompare(right));
    expect(expected.length).toBeGreaterThan(0);

    const checks = await discoverChecks();
    expect(checks.map((item) => item.name)).toEqual(expected);
  });

  it("fails when no check files are discovered", async () => {
    const emptyDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-empty-"));
    cleanupDirs.push(emptyDir);
    await expect(discoverChecks(emptyDir)).rejects.toThrow(/no check files discovered/);
    await expect(
      runDiscoveredChecks({
        checksDir: emptyDir,
        context: {
          binaryPath: process.execPath,
          extensionPath: null,
          display: "headless",
          short: true,
          outDir: null,
          signal: new AbortController().signal,
          log: () => undefined,
        },
      }),
    ).rejects.toThrow(/no check files discovered/);
  });

  it("sorts discovered checks regardless of file creation order and ignores .test.ts files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-sort-"));
    cleanupDirs.push(dir);
    for (const name of ["z-check", "a-check", "m-check"]) {
      await NodeFSP.writeFile(
        NodePath.join(dir, `${name}.ts`),
        `export const check = { name: ${JSON.stringify(name)}, description: "ok", run: async () => ({ name: ${JSON.stringify(name)}, ok: true, durationMs: 0, detail: "ok" }) };\n`,
        "utf8",
      );
    }
    await NodeFSP.writeFile(
      NodePath.join(dir, "ignored.test.ts"),
      `throw new Error("test files must not be imported as checks");\n`,
      "utf8",
    );
    // Return entries unsorted so the test holds regardless of filesystem readdir order.
    const checks = await discoverChecks(dir, async () => [
      "z-check.ts",
      "ignored.test.ts",
      "m-check.ts",
      "a-check.ts",
    ]);
    expect(checks.map((c) => c.name)).toEqual(["a-check", "m-check", "z-check"]);
  });

  it("rejects unknown --check names and treats a throwing check as failed", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-checks-"));
    cleanupDirs.push(dir);
    await NodeFSP.writeFile(
      NodePath.join(dir, "alpha.ts"),
      `export const check = {
        name: "alpha",
        description: "passing check",
        run: async () => ({ name: "alpha", ok: true, durationMs: 1, detail: "ok" }),
      };\n`,
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "throws.ts"),
      `export const check = {
        name: "throws",
        description: "throwing check",
        run: async () => { throw new Error("exploded check"); },
      };\n`,
      "utf8",
    );

    const outDir = NodePath.join(dir, "out");
    const run = await runDiscoveredChecks({
      checksDir: dir,
      context: {
        binaryPath: process.execPath,
        extensionPath: null,
        display: "headless",
        short: true,
        outDir,
        signal: new AbortController().signal,
        log: () => undefined,
      },
    });
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => ({ name: r.name, ok: r.ok }))).toEqual([
      { name: "alpha", ok: true },
      { name: "throws", ok: false },
    ]);
    expect(run.results[1]?.detail).toContain("exploded check");
    const saved = JSON.parse(
      await NodeFSP.readFile(NodePath.join(outDir, "check-results.json"), "utf8"),
    ) as { ok: boolean };
    expect(saved.ok).toBe(false);

    await expect(
      runDiscoveredChecks({
        checksDir: dir,
        filter: ["alpha", "does-not-exist"],
        context: {
          binaryPath: process.execPath,
          extensionPath: null,
          display: "headless",
          short: true,
          outDir: null,
          signal: new AbortController().signal,
          log: () => undefined,
        },
      }),
    ).rejects.toThrow(/unknown check does-not-exist/);
  });

  it("rejects a check file whose exported name does not match its filename", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-checks-"));
    cleanupDirs.push(dir);
    await NodeFSP.writeFile(
      NodePath.join(dir, "wrong.ts"),
      `export const check = { name: "other", description: "bad", run: async () => ({ name: "other", ok: true, durationMs: 0, detail: "" }) };\n`,
      "utf8",
    );
    await expect(discoverChecks(dir)).rejects.toThrow(/must match filename wrong/);
  });

  it("polls until WebExtensionPolicy becomes active and fails on inactive or missing policy", async () => {
    const runPolicyScript = async (
      policyState: () => {
        readonly active: boolean;
        readonly getURL: (p: string) => string;
      } | null,
      timeoutMs: number,
    ): Promise<string> =>
      waitForActiveExtensionUrl(
        {
          evaluateChrome: (script, args = []) =>
            new Promise((resolve) => {
              const fn = new Function("WebExtensionPolicy", "arguments", `${script}`) as (
                policyGlobal: { getByID: (id: string) => ReturnType<typeof policyState> },
                args: readonly unknown[],
              ) => void;
              fn({ getByID: () => policyState() }, [...args, resolve]);
            }),
        },
        "ext@test",
        "action/index.html",
        timeoutMs,
      );

    let polls = 0;
    const resolved = await runPolicyScript(() => {
      polls += 1;
      if (polls === 1) return null;
      if (polls === 2) return { active: false, getURL: (p) => `moz-extension://x/${p}` };
      return { active: true, getURL: (p) => `moz-extension://x/${p}` };
    }, 1000);
    expect(resolved).toBe("moz-extension://x/action/index.html");
    expect(polls).toBeGreaterThanOrEqual(3);

    await expect(
      runPolicyScript(() => ({ active: false, getURL: (p) => `moz-extension://x/${p}` }), 120),
    ).rejects.toThrow(/did not become active/);

    await expect(runPolicyScript(() => null, 120)).rejects.toThrow(/extension policy missing/);
  });

  it("verifies browser identity, toolbox state, and same-profile restart invariants", async () => {
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "20261115114312" },
        { name: "zen", version: "1.25t", buildId: "20261115114312" },
      ),
    ).toBeNull();
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "20261115114312" },
        { name: "zen", version: "9.99z", buildId: "20261115114312" },
      ),
    ).toMatch(/version expected 9\.99z got 1\.25t/);
    expect(
      verifyBrowserIdentity(
        { name: "Firefox", version: "161.0", buildId: "20261113104103" },
        { name: "zen", version: "161.0", buildId: "20261113104103" },
      ),
    ).toMatch(/name expected zen got Firefox/);
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "0000" },
        { name: "zen", version: "1.25t", buildId: "20261115114312" },
      ),
    ).toMatch(/buildId expected 20261115114312 got 0000/);

    const extDir = await makeTestExtensionDir("restart-check@test");
    const launchCalls: Array<{ extensionPath: string | null; profileDir: string | undefined }> = [];
    let restartToolboxOpen = false;

    const makeFakeLaunch = (
      mode: "ok" | "wrong-toolbox" | "bad-restart-toolbox",
    ): typeof launchBrowser =>
      (async (request: Parameters<typeof launchBrowser>[0]) => {
        launchCalls.push({
          extensionPath: request.extensionPath,
          profileDir: request.profileDir,
        });
        return {
          spawnedPid: 1,
          browserPid: 1,
          profileDir: request.profileDir ?? "/tmp/p",
          launchMode: "recommended",
          identity: {
            binaryPath: "/fake",
            name: "zen",
            version: "1.25t",
            buildId: "20261115114312",
            userAgent: "Fake",
            remoteProtocol: "marionette",
            headless: true,
          },
          openTab: async () => "tab-1",
          navigateTab: async () => undefined,
          reloadTab: async () => undefined,
          evaluate: async (_ctx: string, expr: string) => {
            if (expr.includes("querySelector")) return "empty-tab";
            if (expr.includes("browser.tabs.query")) {
              if (mode === "bad-restart-toolbox") {
                return JSON.stringify({
                  browser: { name: "zen", version: "1.25t", buildId: "20261115114312" },
                  toolbox: { open: true, host: "bottom" },
                });
              }
              if (mode === "wrong-toolbox") {
                return JSON.stringify({
                  browser: { name: "zen", version: "1.25t", buildId: "20261115114312" },
                  toolbox: { open: true, host: "bottom" },
                });
              }
              return JSON.stringify({
                browser: { name: "zen", version: "1.25t", buildId: "20261115114312" },
                toolbox: restartToolboxOpen
                  ? { open: true, host: "bottom" }
                  : { open: false, reason: "devtools-not-started" },
              });
            }
            return JSON.stringify({
              browser: { name: "zen", version: "1.25t", buildId: "20261115114312" },
              toolbox: { open: false, reason: "no-such-tab" },
            });
          },
          evaluateChrome: async (script: string) => {
            if (script.includes("WebExtensionPolicy")) {
              return { url: "moz-extension://id/action/index.html" };
            }
            if (script.includes("showToolboxForTab")) {
              restartToolboxOpen = true;
              return "bottom";
            }
            return null;
          },
          takeChromeScreenshot: async () => Buffer.alloc(0),
          closeTab: async () => undefined,
          quit: async () => undefined,
          [Symbol.asyncDispose]: async () => undefined,
        };
      }) as unknown as typeof launchBrowser;

    const baseContext = {
      binaryPath: process.execPath,
      extensionPath: extDir,
      display: "headless" as const,
      short: true,
      outDir: null,
      signal: new AbortController().signal,
      log: () => undefined,
    };

    const restartResult = await runRestartVerification(baseContext, {
      launch: makeFakeLaunch("ok"),
    });
    expect(restartResult.ok).toBe(true);
    expect(launchCalls).toHaveLength(2);
    expect(launchCalls[0]?.extensionPath).toBeNull();
    expect(launchCalls[1]?.extensionPath).toBeNull();
    expect(launchCalls[0]?.profileDir).toBe(launchCalls[1]?.profileDir);

    await expect(
      runRestartVerification(baseContext, { launch: makeFakeLaunch("bad-restart-toolbox") }),
    ).rejects.toThrow(/unexpected toolbox/);

    const envMismatch = await runEnvironmentVerification(baseContext, {
      launch: makeFakeLaunch("wrong-toolbox"),
    });
    expect(envMismatch.ok).toBe(false);
    expect(envMismatch.detail).toContain("before DevTools starts: toolbox");

    await expect(
      runEnvironmentVerification({
        ...baseContext,
        extensionPath: null,
      }),
    ).resolves.toMatchObject({ name: "environment", ok: false });
    await expect(
      runRestartVerification({
        ...baseContext,
        extensionPath: null,
      }),
    ).resolves.toMatchObject({ name: "restart", ok: false });
  });
});

async function makeTestExtensionDir(id: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-test-ext-"));
  cleanupDirs.push(dir);
  await NodeFSP.writeFile(
    NodePath.join(dir, "manifest.json"),
    JSON.stringify({
      manifest_version: 2,
      name: "test-ext",
      version: "0.1.0",
      browser_specific_settings: { gecko: { id } },
      action: { default_popup: "action/index.html" },
    }),
    "utf8",
  );
  return dir;
}
