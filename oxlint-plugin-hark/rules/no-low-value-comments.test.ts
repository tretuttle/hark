import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("hark/no-low-value-comments");

describe("hark/no-low-value-comments", () => {
  rule.valid(
    "allows concise why-comments and external issue references",
    `
      // System-principal streams must be closed before Windows deletes the temp file.
      const closeHandle = () => {};
      // Workaround for upstream bug mozilla/gecko-dev#12345.
      const fallback = true;
    `,
  );

  rule.valid(
    "allows license headers over four lines",
    `/*
 * Copyright (c) 2026 Hark
 * Line 2
 * Line 3
 * Line 4
 * Line 5
 */
export const ok = true;`,
  );

  rule.invalid(
    "reports section dividers",
    `
      // --- helpers ---
      export const x = 1;
    `,
    (output) => assert.include(output, "Drop the section divider"),
  );

  rule.invalid(
    "reports test step labels",
    `
      // Arrange
      const input = 1;
    `,
    (output) => assert.include(output, "Drop the test step label."),
  );

  rule.invalid(
    "reports unlinked task markers",
    `
      // TODO: handle stream errors
      export const x = 1;
    `,
    (output) => assert.include(output, "Link the issue that tracks this"),
  );

  rule.invalid(
    "reports bare issue numbers outside task or test markers",
    `
      // Added in #1234 to avoid race.
      export const x = 1;
    `,
    (output) => assert.include(output, "Drop the PR or issue number"),
  );

  rule.invalid(
    "reports JSDoc type annotations in TypeScript",
    `
      /** @param {string} name */
      export function greet(name: string) { return name; }
    `,
    (output) => assert.include(output, "Drop the JSDoc type"),
  );

  rule.invalid(
    "reports commented-out code",
    `
      // const previous = getThreshold();
      export const threshold = 1024;
    `,
    (output) => assert.include(output, "Delete commented-out code"),
  );

  rule.invalid(
    "reports comments that only restate the next identifier",
    `
      // Get threshold
      export function getThreshold() { return 1024; }
    `,
    (output) => assert.include(output, "it only repeats the name below it"),
  );

  rule.invalid(
    "reports comments longer than four lines",
    `
      // Line one explains something.
      // Line two keeps explaining.
      // Line three adds more background.
      // Line four keeps going.
      // Line five crosses the cap.
      export const x = 1;
    `,
    (output) => assert.include(output, "Cut this to 4 lines or fewer"),
  );
});
