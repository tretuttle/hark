import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { BINARY_ENV, GECKO_BINARY_ENV, parseCommand, report } from "./cli.ts";
import type { MeasureResult } from "./measure.ts";
import { parseScenarioName } from "./scenarios.ts";

const executable = process.execPath;

describe("command line", () => {
  it("requires a browser binary on every platform and names both ways to give it", () => {
    expect(() => parseCommand(["measure"], {})).toThrow(
      `a browser binary is required: pass --binary <path> or set ${BINARY_ENV}`,
    );
    expect(() => parseCommand(["baseline", "--runs", "2"], {})).toThrow(
      /browser binary is required/,
    );
  });

  it("refuses a binary that does not exist", () => {
    const missing = NodePath.resolve("no-such-browser-binary");
    expect(() => parseCommand(["measure", "--binary", missing], {})).toThrow(
      `browser binary not found or not executable: ${missing}`,
    );
  });

  it("takes the binary from the environment, runs headless by default and shows a window only when asked", () => {
    expect(parseCommand(["measure"], { [BINARY_ENV]: executable })).toMatchObject({
      kind: "measure",
      binaryPath: executable,
      display: "headless",
      protocol: "bidi",
    });
    expect(
      parseCommand(["--", "baseline", "--binary", executable, "--show-window"], {}),
    ).toMatchObject({ kind: "baseline", binaryPath: executable, display: "window" });
    expect(parseCommand(["check"], { [GECKO_BINARY_ENV]: executable })).toMatchObject({
      kind: "check",
      binaryPath: executable,
      display: "headless",
      short: false,
      skip: [],
    });
    expect(
      parseCommand(["check", "--skip", "pages-history,pages-options"], {
        [GECKO_BINARY_ENV]: executable,
      }),
    ).toMatchObject({ kind: "check", filter: [], skip: ["pages-history", "pages-options"] });
    expect(() =>
      parseCommand(["check", "--check", "a", "--skip", "b"], { [GECKO_BINARY_ENV]: executable }),
    ).toThrow(/--check or --skip/);
    expect(
      parseCommand(["--", "cost", "--extension", "a.xpi", "--short"], {
        [GECKO_BINARY_ENV]: executable,
      }),
    ).toMatchObject({
      kind: "cost",
      binaryPath: executable,
      extensionPath: "a.xpi",
      rounds: 3,
      scenarios: ["cost-images"],
    });
  });

  it("needs a scenario for har-check", () => {
    expect(() => parseCommand(["har-check", "capture.har"], {})).toThrow(
      /har-check needs --scenario/,
    );
    expect(parseCommand(["har-check", "--scenario", "page", "capture.har"], {})).toEqual({
      kind: "har-check",
      scenario: "page",
      file: "capture.har",
    });
    expect(parseCommand(["har-check", "--scenario", "fixtures", "capture.har"], {})).toEqual({
      kind: "har-check",
      scenario: "fixtures",
      file: "capture.har",
    });
    expect(() => parseScenarioName("no-such")).toThrow(
      "unknown scenario no-such; expected one of page, fixtures",
    );
  });

  it("selects one remote protocol and exits 1 when a run failed", () => {
    expect(
      parseCommand(["measure", "--protocol", "marionette"], { [BINARY_ENV]: executable }),
    ).toMatchObject({ protocol: "marionette" });
    expect(() =>
      parseCommand(["baseline", "--protocol", "cdp", "--binary", executable], {}),
    ).toThrow("--protocol expects bidi or marionette");
    const previous = process.exitCode;
    try {
      process.exitCode = 0;
      report(commandResult(0));
      expect(process.exitCode).toBe(0);
      process.exitCode = 0;
      report(commandResult(2));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });
});

function commandResult(errors: number): Omit<MeasureResult, "extensionPath"> {
  return {
    scenario: "page",
    sampleDefinition: "last-resource-finished",
    runCount: 2,
    errors,
    failures:
      errors === 0
        ? []
        : [
            { run: 1, reason: "page failed /r/css/0" },
            { run: 2, reason: "page did not finish /r/json/0" },
          ],
    samples: [],
    lastResourceFinishedMs: null,
    parentWorkingSetBytes: null,
    wallTimeMs: 0,
    browserCpuMs: 0,
    limiter: "No run completed, so there is no wall time.",
    browser: {
      binaryPath: executable,
      name: "zen",
      version: "1",
      buildId: "1",
      userAgent: "Mozilla",
      remoteProtocol: "bidi",
      headless: true,
    },
    machine: {
      platform: "linux",
      release: "1",
      arch: "x64",
      cpuModel: "test",
      cpuCount: 1,
      totalMemoryBytes: 1,
    },
    load: {
      before: { cpuBusyPercent: 0, loadAverage: null },
      after: { cpuBusyPercent: 0, loadAverage: null },
    },
  };
}
