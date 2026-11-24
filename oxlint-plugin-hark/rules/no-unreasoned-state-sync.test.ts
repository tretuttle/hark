import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const reports = (output: string) => output.match(/hark\(no-unreasoned-state-sync\)/g)?.length ?? 0;
const lint = (filename: string) =>
  createOxlintRuleHarness("hark/no-unreasoned-state-sync", { filename });

const component = lint("apps/extension/src/Panel.tsx");

describe("hark/no-unreasoned-state-sync", () => {
  component.invalid(
    "reports every effect hook, including member calls",
    `import React, { useEffect } from "react";
export function Panel() {
  useEffect(() => {}, []);
  React.useLayoutEffect(() => {});
  React.useInsertionEffect(() => {});
  return null;
}
`,
    (output) => assert.strictEqual(reports(output), 3),
  );

  component.valid(
    "ignores comments, strings and lookalike names",
    `// useEffect(() => {}) in a comment
/* React.useLayoutEffect(() => {}) */
const label = "useEffect(() => {})";
const pipeline = Effect.matchCauseEffect(effect, {});
const alias = useEffect;
`,
  );

  component.valid(
    "accepts an effect whose suppression states its reason",
    `export function Panel() {
  // oxlint-disable-next-line hark/no-unreasoned-state-sync -- subscribes to browser runtime port events
  React.useEffect(() => {});
  return null;
}
`,
  );

  for (const filename of [
    "apps/extension/src/Panel.test.tsx",
    "apps/extension/src/Panel.spec.tsx",
    "apps/extension/tests/Panel.tsx",
  ]) {
    lint(filename).valid(
      `skips ${filename}`,
      `export function Panel() { useEffect(() => {}); return null; }`,
    );
  }
});
