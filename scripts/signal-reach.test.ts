import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { findSignalViolations, listSourceFiles } from "./signal-reach.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

// Source text only: the scan parses these files and never runs them.
const SAMPLE_FILES: Readonly<Record<string, string>> = {
  "package.json": "{}",
  "src/kill.ts": 'export function stop(pid: number) { process.kill(pid, "SIGTERM"); }',
  "src/wrapper.ts": 'import * as Kill from "./kill.ts";\nexport const run = () => Kill.stop(5);',
  "src/pure.ts": "export const add = (a: number, b: number) => a + b;",
  "src/handle.ts": "export const end = (child: { kill(): void }) => child.kill();",
  "src/spawner.ts":
    'import * as NodeChildProcess from "node:child_process";\nexport const shoot = () => NodeChildProcess.spawnSync("pkill", ["zen"]);',
  "src/loader.ts": "export const load = (path: string) => import(path);",
  "src/isolation.ts": "export function requireIsolatedPidNamespace() {}",
  "reaches-through-namespace-import.test.ts": 'import { run } from "./src/wrapper.ts";\nrun();',
  "type-only.test.ts":
    'import { add } from "./src/pure.ts";\nimport { type stop } from "./src/kill.ts";\ntype Stop = typeof stop;\nadd(1, 2);',
  "handle-kill.test.ts": "const child = { kill() {} };\nchild.kill();",
  "kill-command.test.ts": 'import { shoot } from "./src/spawner.ts";\nshoot();',
  "unfollowed-import.test.ts": 'import { load } from "./src/loader.ts";\nload("./x.ts");',
  "proves-first.namespace.test.ts":
    'import { run } from "./src/wrapper.ts";\nimport { requireIsolatedPidNamespace } from "./src/isolation.ts";\nrequireIsolatedPidNamespace();\nrun();',
  "proves-late.namespace.test.ts":
    'import { run } from "./src/wrapper.ts";\nimport { requireIsolatedPidNamespace } from "./src/isolation.ts";\nrun();\nrequireIsolatedPidNamespace();',
};

describe("signal reach", () => {
  it("finds no test in this repository that reaches a real signal outside a namespaced suite", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    expect(findSignalViolations(root, listSourceFiles(root))).toEqual([]);
  });

  it("reports each sample test that reaches a signal, with the path it takes, and nothing else", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-reach-"));
    cleanupDirs.push(root);
    for (const [file, text] of Object.entries(SAMPLE_FILES)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, file), text, "utf8");
    }
    const found = findSignalViolations(root, listSourceFiles(root));
    expect(found.map(({ file, message }) => `${file}: ${message}`).sort()).toEqual([
      "handle-kill.test.ts: reaches a real signal outside a *.namespace.test.ts suite: .kill()",
      'kill-command.test.ts: reaches a real signal outside a *.namespace.test.ts suite: shoot (src/spawner.ts) -> the "pkill" command',
      "proves-late.namespace.test.ts: a namespaced suite must call requireIsolatedPidNamespace() as its first statement",
      "reaches-through-namespace-import.test.ts: reaches a real signal outside a *.namespace.test.ts suite: run (src/wrapper.ts) -> stop (src/kill.ts) -> process.kill",
      "unfollowed-import.test.ts: reaches a real signal outside a *.namespace.test.ts suite: load (src/loader.ts) -> end (src/handle.ts) -> .kill()",
    ]);
  });
});
