import { describe, expect, it } from "vite-plus/test";
import {
  currentIsolation,
  checkIsolation,
  LAUNCHER_MARKER,
  namespacedOutcome,
  namespacedSuitesCommand,
  namespaceUnavailableReason,
  probeRefusal,
  requireIsolatedPidNamespace,
  runNamespacedSuites,
} from "./namespace-isolation.ts";
import type { ProcessIdentity } from "./signal-policy.ts";
import { processIdentity } from "./simulated-process-io.ts";

const launcher = processIdentity(1, {
  parentPid: 0,
  args: ["sh", "-c", "script", LAUNCHER_MARKER, "prlimit", "--core=1:1", "--", "vp"],
});
const vitest = processIdentity(2, { parentPid: 1, args: ["node", "vp", "test"] });
const worker = processIdentity(9, { parentPid: 2, args: ["node", "worker"] });
const table = (...rows: ProcessIdentity[]) => new Map(rows.map((row) => [row.pid, row]));

describe("PID namespace isolation", () => {
  it("accepts a namespace whose PID 1 is the launcher and where the named host process is invisible", () => {
    expect(
      checkIsolation({ table: table(launcher, vitest, worker), sentinel: "4242:777" }),
    ).toEqual({ isolated: true });
  });

  it.each([
    {
      name: "no host process was named",
      rows: [launcher, vitest],
      sentinel: undefined,
      reason: /no host process was named/,
    },
    {
      name: "PID 1 is the host's init (launcher ran without --pid --mount-proc)",
      rows: [processIdentity(1, { parentPid: 0, args: ["/sbin/init"] }), vitest],
      sentinel: "4242:777",
      reason: /PID 1 is not the namespace launcher \(\/sbin\/init\)/,
    },
    {
      name: "the named host process is visible",
      rows: [launcher, vitest, processIdentity(4242, { parentPid: 1, startTime: "777" })],
      sentinel: "4242:777",
      reason: /host process 4242 is visible/,
    },
    {
      name: "a sentinel that is not <pid>:<start time>",
      rows: [launcher, vitest],
      sentinel: "4242",
      reason: /no host process was named/,
    },
    {
      name: "PID 1 is absent",
      rows: [vitest],
      sentinel: "4242:777",
      reason: /PID 1 is not the namespace launcher \(absent\)/,
    },
    {
      name: "two processes name each other as parent",
      rows: [
        launcher,
        processIdentity(5, { parentPid: 6, args: ["a"] }),
        processIdentity(6, { parentPid: 5, args: ["b"] }),
      ],
      sentinel: "4242:777",
      reason: /process 5 \(a\) does not descend from the launcher/,
    },
    {
      name: "a process's parent is not in the table",
      rows: [launcher, processIdentity(5, { parentPid: 99, args: ["a"] })],
      sentinel: "4242:777",
      reason: /process 5 \(a\) does not descend from the launcher/,
    },
    {
      name: "a process does not descend from the launcher",
      rows: [launcher, { ...vitest, parentPid: 0 }],
      sentinel: "4242:777",
      reason: /process 2 \(node vp test\) does not descend from the launcher/,
    },
  ])("refuses when $name", ({ rows, sentinel, reason }) => {
    const verdict = checkIsolation({ table: table(...rows), sentinel });
    expect(verdict.isolated).toBe(false);
    expect(verdict.isolated ? "" : verdict.reason).toMatch(reason);
  });

  it("refuses real-signal tests when no host process was named, even when the environment claims a namespaced run", () => {
    const refusal =
      /refusing to run real-signal tests outside an isolated PID namespace: .*no host process was named/;
    const claimed = ["HARK_NAMESPACE_RUN", "HARK_HOST_SENTINEL"] as const;
    const previous = claimed.map((name) => process.env[name]);
    try {
      delete process.env.HARK_HOST_SENTINEL;
      delete process.env.HARK_NAMESPACE_RUN;
      expect(() => requireIsolatedPidNamespace()).toThrow(refusal);
      process.env.HARK_NAMESPACE_RUN = "1";
      expect(() => requireIsolatedPidNamespace()).toThrow(refusal);
    } finally {
      claimed.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

describe("the namespace launcher", () => {
  it("runs the suites under a 1-byte core limit as the child of PID 1 in a new PID, user and /proc namespace", () => {
    const launch = namespacedSuitesCommand("/repo", "/repo/tools/browser-harness");
    expect(launch.command).toBe("unshare");
    const separator = launch.args.indexOf("--");
    expect(new Set(launch.args.slice(0, separator))).toEqual(
      new Set(["--user", "--map-current-user", "--pid", "--fork", "--mount-proc", "--kill-child"]),
    );
    const [shell, flag, script, marker, ...command] = launch.args.slice(separator + 1);
    expect([shell, flag, marker]).toEqual(["sh", "-c", LAUNCHER_MARKER]);
    expect(script).toMatch(/^\[ "\$\$" = 1 \] \|\| \{[^}]*exit 97; \}\n"\$@"\nexit \$\?$/u);
    expect(command).toEqual([
      "prlimit",
      "--core=1:1",
      "--",
      "/repo/node_modules/.bin/vp",
      "test",
      "run",
      "--config",
      "/repo/vite.config.ts",
      "--dir",
      "/repo/tools/browser-harness",
    ]);
  });
});

describe("the namespaced run's outcome", () => {
  const output =
    "\u001b[2m Test Files \u001b[22m 5 passed (5)\n      Tests  27 passed (27)\n other line\n";
  it.each([
    {
      code: 0,
      expected: {
        outcome: "passed",
        summary: " Test Files  5 passed (5)\n      Tests  27 passed (27)",
      },
    },
    { code: 1, expected: { outcome: "failed", detail: `exit 1\n${output.trim()}` } },
    { code: null, expected: { outcome: "failed", detail: `exit null\n${output.trim()}` } },
  ])("reads exit $code", ({ code, expected }) => {
    expect(namespacedOutcome(code, output)).toEqual(expected);
  });
});

describe("outside Linux", () => {
  it("reports PID namespaces as unavailable and this process as not isolated", () => {
    expect(namespaceUnavailableReason("darwin")).toBe("PID namespaces are Linux-only (darwin)");
    expect(currentIsolation("win32")).toEqual({
      isolated: false,
      reason: "PID namespaces are Linux-only (win32)",
    });
  });
});

describe("the user namespace probe", () => {
  it("makes the namespaced run report the refusal instead of starting it", async () => {
    expect(await runNamespacedSuites("/nonexistent", "refused for this test")).toEqual({
      outcome: "unavailable",
      reason: "refused for this test",
    });
  });

  it("refuses a nested namespaced run inside an isolated PID namespace regardless of env", async () => {
    const prev = process.env.HARK_NAMESPACE_RUN;
    try {
      delete process.env.HARK_NAMESPACE_RUN;
      expect(await runNamespacedSuites("/nonexistent", null, { isolated: true })).toEqual({
        outcome: "failed",
        detail: "refusing to start a nested namespaced run inside an isolated PID namespace",
      });
      process.env.HARK_NAMESPACE_RUN = "0";
      expect(await runNamespacedSuites("/nonexistent", null, { isolated: true })).toEqual({
        outcome: "failed",
        detail: "refusing to start a nested namespaced run inside an isolated PID namespace",
      });
    } finally {
      if (prev === undefined) delete process.env.HARK_NAMESPACE_RUN;
      else process.env.HARK_NAMESPACE_RUN = prev;
    }
  });

  it.each([
    { name: "unshare succeeded", probe: { status: 0, stdout: "", stderr: "" }, refusal: null },
    {
      name: "the kernel refused the mapping",
      probe: { status: 1, stdout: "", stderr: "unshare: write failed /proc/self/uid_map\n" },
      refusal: "unshare: write failed /proc/self/uid_map",
    },
    {
      name: "unshare said nothing",
      probe: { status: 1, stdout: "", stderr: "" },
      refusal: "unshare exited 1",
    },
    {
      name: "unshare is missing",
      probe: { error: new Error("spawnSync unshare ENOENT"), status: null, stdout: "", stderr: "" },
      refusal: "spawnSync unshare ENOENT",
    },
  ])("reads $name", ({ probe, refusal }) => {
    expect(probeRefusal(probe)).toBe(refusal);
  });
});
