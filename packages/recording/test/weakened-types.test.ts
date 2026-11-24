import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const PACKAGE = NodePath.resolve(import.meta.dirname, "..");
const require = NodeModule.createRequire(import.meta.url);
const CHECKER = NodePath.join(
  NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
  "dist",
  "effect-tsgo.cjs",
);
const BASE = JSON.parse(
  NodeFS.readFileSync(NodePath.join(PACKAGE, "..", "..", "tsconfig.base.json"), "utf8"),
) as {
  readonly compilerOptions: object;
};
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hark-weakened-types-"));
afterAll(() => NodeFS.rmSync(work, { recursive: true, force: true }));

interface Weakening {
  readonly id: string;
  readonly file: string;
  readonly from: string | RegExp;
  readonly to: string;
  /** Text the checker's output must contain, so a failure for an unrelated reason does not count. */
  readonly expect: string;
}

// Each weakens one type the illegal states depend on.
const WEAKENINGS: readonly Weakening[] = [
  {
    id: "abandoned-may-store",
    file: "src/exchange.ts",
    from: "export type AbandonedBody = EmptyBody",
    to: "export type AbandonedBody = CopiedBody | EmptyBody",
    expect: "TS2578",
  },
  {
    id: "abandoned-body-names-a-reason",
    file: "src/exchange.ts",
    from: 'export type AbandonedBody = EmptyBody | NotKeptBody | { readonly kind: "incomplete" };',
    to: 'export type AbandonedBody = EmptyBody | NotKeptBody | { readonly kind: "incomplete"; readonly reason?: AbandonReason };',
    expect: "TS2578",
  },
  {
    id: "headless-abandon-any-body",
    file: "src/exchange.ts",
    from: 'readonly body: { readonly kind: "incomplete" };\n      readonly upload: { readonly kind: "none" };',
    to: "readonly body: AbandonedBody;\n      readonly upload: UploadOutcome;",
    expect: "TS2578",
  },
  {
    id: "answered-route-any-body",
    file: "src/exchange.ts",
    from: "    readonly route: Id;",
    to: "    readonly route: BodyRouteId;",
    expect: "TS2578",
  },
  {
    id: "copying-sink-optional",
    file: "src/exchange.ts",
    from: "readonly capture: CopyingCapture; readonly stop: StopFacts; readonly sink: SinkResult };",
    to: "readonly capture: CopyingCapture; readonly stop: StopFacts; readonly sink: SinkResult | null };",
    expect: "TS2578",
  },
  {
    id: "route-id-any-kind",
    file: "src/routes.ts",
    from: "{ readonly id: Id } & Resolved<RowOutcomes[Id]>",
    to: "{ readonly id: BodyRouteId } & Resolved<RouteOutcome>",
    expect: "TS2578",
  },
  {
    id: "row-any-outcome",
    file: "src/routes.ts",
    from: "    readonly outcome: RowOutcomes[P];",
    to: "    readonly outcome: RouteOutcome;",
    expect: "TS2578",
  },
  {
    id: "window-unbranded",
    file: "src/activity.ts",
    from: "  readonly [nonEmpty]: true;\n",
    to: "",
    expect: "TS2578",
  },
  {
    id: "capped-incomplete-back",
    file: "src/exchange.ts",
    from: 'export type IncompleteReason = "network-aborted"',
    to: 'export type IncompleteReason = "over-body-cap" | "network-aborted"',
    expect: "TS2578",
  },
  {
    id: "answered-stop-optional",
    file: "src/exchange.ts",
    from: /(kind: "answered";\n(?:.*\n){2}\s*readonly stop: StopFacts)/,
    to: "$1 | null",
    expect: "TS2578",
  },
  {
    id: "awaiting-merge-takes-route",
    file: "src/exchange.ts",
    from: 'phase: "awaiting-merge";',
    to: 'phase: "awaiting-merge"; readonly route?: Route;',
    expect: "TS2578",
  },
  {
    id: "examine-phase-missing",
    file: "src/exchange.ts",
    from: /^ {2}decided: \{\n(?: {4}.*\n)* {2}\},\n/m,
    to: "",
    expect: "decided",
  },
  {
    id: "xdg-under-allowed",
    file: "src/layout.ts",
    from: 'kind: "xdg-data-home";',
    to: 'kind: "xdg-data-home"; readonly under?: readonly string[];',
    expect: "TS2578",
  },
  {
    id: "root-row-missing",
    file: "src/layout.ts",
    from: /^ {2}win: \{\n(?: {4}.*\n)* {2}\},\n/m,
    to: "",
    expect: "win",
  },
  {
    id: "platform-cutoff-missing",
    file: "src/routes.ts",
    from: /^ {2}macosx: \{ bytes: [^\n]*\n/m,
    to: "",
    expect: "macosx",
  },
  {
    id: "copy-may-name-nothing",
    file: "src/routes.ts",
    from: "readonly actions: NonEmpty<CaptureAction>",
    to: "readonly actions: readonly CaptureAction[]",
    expect: "TS2578",
  },
  {
    id: "tab-any-number",
    file: "src/ids.ts",
    from: 'export type TabId = Brand<number, "TabId">;',
    to: "export type TabId = number;",
    expect: "TS2578",
  },
];

function copyPackage(dir: string): void {
  NodeFS.cpSync(NodePath.join(PACKAGE, "src"), NodePath.join(dir, "src"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dir, "test"));
  for (const file of ["illegal-states.ts", "fixtures.ts"])
    NodeFS.copyFileSync(NodePath.join(PACKAGE, "test", file), NodePath.join(dir, "test", file));
  const compilerOptions = { ...BASE.compilerOptions, types: [], lib: ["ESNext"] };
  NodeFS.writeFileSync(
    NodePath.join(dir, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions, include: ["src/**/*.ts", "test/**/*.ts"] }),
  );
}

function check(dir: string): { readonly code: number | null; readonly out: string } {
  const r = NodeChildProcess.spawnSync(
    process.execPath,
    [CHECKER, "tsrs", "--noEmit", "-p", NodePath.join(dir, "tsconfig.json")],
    { encoding: "utf8" },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function weaken(dir: string, m: Weakening): void {
  const path = NodePath.join(dir, m.file);
  const before = NodeFS.readFileSync(path, "utf8");
  const hits =
    typeof m.from === "string"
      ? before.split(m.from).length - 1
      : (before.match(new RegExp(m.from.source, `${m.from.flags}g`)) ?? []).length;
  expect(hits, `${m.id} must match ${m.file} exactly once`).toBe(1);
  NodeFS.writeFileSync(path, before.replace(m.from, m.to));
}

describe("the illegal states stay type errors", () => {
  it("the unweakened copy typechecks", () => {
    const dir = NodePath.join(work, "baseline");
    copyPackage(dir);
    const r = check(dir);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  it.each(WEAKENINGS)("weakened by $id, the copy fails the checker", (m) => {
    const dir = NodePath.join(work, m.id);
    copyPackage(dir);
    weaken(dir, m);
    const r = check(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(m.expect);
  });
});
