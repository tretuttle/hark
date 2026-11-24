import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const PACKAGE = NodePath.resolve(import.meta.dirname, "..");
const ROOT = NodePath.resolve(PACKAGE, "..", "..");
const require = NodeModule.createRequire(import.meta.url);
const CHECKER = NodePath.join(
  NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
  "dist",
  "effect-tsgo.cjs",
);
const BASE = JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, "tsconfig.base.json"), "utf8")) as {
  readonly compilerOptions: object;
};
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hark-export-weakened-"));
afterAll(() => NodeFS.rmSync(work, { recursive: true, force: true }));

interface Weakening {
  readonly id: string;
  readonly target: "export" | "har" | "recording";
  readonly file: string;
  readonly from: string | RegExp;
  readonly to: string;
  readonly expect: string;
}

const WEAKENINGS: readonly Weakening[] = [
  {
    id: "merge-row-removed",
    target: "export",
    file: "src/merge.ts",
    from: '  "timings.ssl": { kind: "group", group: "timings" },\n',
    to: "",
    expect: "timings.ssl",
  },
  {
    id: "merge-row-unknown-field",
    target: "export",
    file: "src/merge.ts",
    from: '  "timings.ssl": {',
    to: '  "timings.sssl": { kind: "group", group: "timings" },\n  "timings.ssl": {',
    expect: "timings.sssl",
  },
  {
    id: "har-model-gains-a-field",
    target: "har",
    file: "src/model.ts",
    from: "  readonly _harExport?: HarEntryExtension | undefined;\n}",
    to: "  readonly _harExport?: HarEntryExtension | undefined;\n  readonly _newField?: string | undefined;\n}",
    expect: "_newField",
  },
  {
    id: "missing-reason-row-removed",
    target: "export",
    file: "src/missing.ts",
    from: /^  "no-response": \{[\s\S]*?\n  \},\n/m,
    to: "",
    expect: "no-response",
  },
  {
    id: "range-rule-row-removed",
    target: "export",
    file: "src/selection.ts",
    from: /^  today: \(_range, context\) => \(\{[\s\S]*?\n  \}\),\n/m,
    to: "",
    expect: "today",
  },
  {
    id: "packaging-table-row-removed",
    target: "export",
    file: "src/jobs.ts",
    from: '  "har.zip": false,\n',
    to: "",
    expect: "har.zip",
  },
  {
    id: "candidates-with-reason",
    target: "export",
    file: "src/source.ts",
    from: '{ readonly kind: "candidates"; readonly list: NonEmpty<BodySource> }',
    to: '{ readonly kind: "candidates"; readonly list: NonEmpty<BodySource>; readonly reason?: MissingReason }',
    expect: "TS2578",
  },
  {
    id: "candidates-may-be-empty",
    target: "export",
    file: "src/source.ts",
    from: "readonly list: NonEmpty<BodySource>",
    to: "readonly list: readonly BodySource[]",
    expect: "TS2578",
  },
  {
    id: "cache-source-added",
    target: "export",
    file: "src/source.ts",
    from: "export type BodySource =\n",
    to: 'export type BodySource =\n  | { readonly kind: "cache"; readonly ref: { readonly key: string }; readonly wireEncoding: string | null }\n',
    expect: "TS2578",
  },
  {
    id: "minutes-any-number",
    target: "export",
    file: "src/selection.ts",
    from: '{ readonly kind: "last"; readonly minutes: PositiveMinutes }',
    to: '{ readonly kind: "last"; readonly minutes: number }',
    expect: "TS2578",
  },
  {
    id: "between-loose-minutes",
    target: "export",
    file: "src/selection.ts",
    from: '{ readonly kind: "between"; readonly span: MinuteSpan }',
    to: '{ readonly kind: "between"; readonly span?: MinuteSpan; readonly from?: Minute; readonly to?: Minute }',
    expect: "TS2578",
  },
  {
    id: "sessions-may-be-empty",
    target: "export",
    file: "src/selection.ts",
    from: "readonly sessions: NonEmpty<SessionRef>;",
    to: "readonly sessions: readonly SessionRef[];",
    expect: "TS2578",
  },
  {
    id: "tab-any-number",
    target: "recording",
    file: "src/ids.ts",
    from: 'export type TabId = Brand<number, "TabId">;',
    to: "export type TabId = number;",
    expect: "TS2578",
  },
  {
    id: "redaction-any-string",
    target: "export",
    file: "src/jobs.ts",
    from: "readonly redaction: RedactionChoice;",
    to: "readonly redaction: string;",
    expect: "TS2578",
  },
  {
    id: "packaging-any-string",
    target: "export",
    file: "src/jobs.ts",
    from: "readonly packaging: Packaging;",
    to: "readonly packaging: string;",
    expect: "TS2578",
  },
];

function copyWorkspace(dir: string): void {
  const nm = NodePath.join(dir, "node_modules", "@hark");
  NodeFS.mkdirSync(nm, { recursive: true });
  for (const name of ["har", "recording", "export"]) {
    const dest = NodePath.join(dir, name);
    NodeFS.cpSync(NodePath.join(ROOT, "packages", name, "src"), NodePath.join(dest, "src"), {
      recursive: true,
    });
    NodeFS.copyFileSync(
      NodePath.join(ROOT, "packages", name, "package.json"),
      NodePath.join(dest, "package.json"),
    );
    NodeFS.symlinkSync(dest, NodePath.join(nm, name));
  }
  NodeFS.mkdirSync(NodePath.join(dir, "export", "test"));
  NodeFS.copyFileSync(
    NodePath.join(PACKAGE, "test", "illegal-states.ts"),
    NodePath.join(dir, "export", "test", "illegal-states.ts"),
  );
  const compilerOptions = { ...BASE.compilerOptions, types: [], lib: ["ESNext"] };
  NodeFS.writeFileSync(
    NodePath.join(dir, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions,
      include: ["export/src/**/*.ts", "export/test/illegal-states.ts", "har/src/model.ts"],
    }),
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
  const path = NodePath.join(dir, m.target, m.file);
  const before = NodeFS.readFileSync(path, "utf8");
  const hits =
    typeof m.from === "string"
      ? before.split(m.from).length - 1
      : (before.match(new RegExp(m.from.source, `${m.from.flags}g`)) ?? []).length;
  expect(hits, `${m.id} must match ${m.target}/${m.file} exactly once`).toBe(1);
  NodeFS.writeFileSync(path, before.replace(m.from, m.to));
}

describe("type weakenings fail the checker", () => {
  it("the unweakened package and illegal-states file typecheck", () => {
    const dir = NodePath.join(work, "baseline");
    copyWorkspace(dir);
    const r = check(dir);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  it.each(WEAKENINGS)("$id fails with $expect", (m) => {
    const dir = NodePath.join(work, m.id);
    copyWorkspace(dir);
    weaken(dir, m);
    const r = check(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(m.expect);
  });
});
