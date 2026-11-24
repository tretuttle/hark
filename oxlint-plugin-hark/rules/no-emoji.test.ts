import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const EM_DASH = "\u2014";

const rule = createOxlintRuleHarness("hark/no-emoji", {
  filename: "fixture.tsx",
});

describe("hark/no-emoji", () => {
  rule.valid("allows plain product copy", 'const copy = "Export captured responses as HAR";');

  rule.valid(
    "allows copyright, registered, and trademark symbols",
    `const legal = "© 2026 Hark ${EM_DASH} ® and ™ are typography, not emoji";`,
  );

  rule.valid("allows non-emoji arrow U+2192", 'const arrow = "Click Export → then Save";');

  rule.valid("allows horizontal ellipsis U+2026", 'const ellipsis = "Exporting HAR…";');

  rule.valid(
    "allows typographic apostrophe U+2019",
    'const quote = "Response’s body exceeds threshold";',
  );

  rule.valid(
    "allows template literals with non-emoji typography",
    "const t = `Saved ${count} files → archive`;",
  );

  rule.valid(
    "allows JSX text without emoji",
    `const a = <p>12 MB saved ${EM_DASH} ready to export</p>;`,
  );

  rule.valid(
    "ignores emoji in line comments",
    "const x = 1; // celebrate 🎉 in comments all you like",
  );

  rule.valid("ignores emoji in block comments", "/* 📦 block comments too */ const y = 2;");

  rule.invalid("reports emoji in a string literal", 'const s = "Have fun 🎉 today";', (output) => {
    assert.include(output, 'Emoji "🎉" is not allowed in product UI. Use an icon instead.');
  });

  rule.invalid(
    "reports emoji in a template literal chunk",
    "const s = `Saved ${count} files 📦`;",
    (output) => {
      assert.include(output, 'Emoji "📦" is not allowed in product UI. Use an icon instead.');
    },
  );

  rule.invalid("reports emoji in JSX text", "const a = <p>Capture ✨ ready</p>;", (output) => {
    assert.include(output, 'Emoji "✨" is not allowed in product UI. Use an icon instead.');
  });

  rule.invalid(
    "reports emoji in a JSX attribute string literal",
    'const a = <button label="Export 🚀" />;',
    (output) => {
      assert.include(output, 'Emoji "🚀" is not allowed in product UI. Use an icon instead.');
    },
  );

  rule.invalid(
    "reports the base pictograph in a skin-tone modifier sequence",
    'const s = "\\u{1F44D}\\u{1F3FD} looks great";',
    (output) => {
      assert.include(
        output,
        'Emoji "\u{1F44D}" is not allowed in product UI. Use an icon instead.',
      );
    },
  );

  rule.invalid(
    "reports regional-indicator flag sequences",
    'const s = "Made in the \\u{1F1FA}\\u{1F1F8}";',
    (output) => {
      assert.include(
        output,
        'Emoji "\u{1F1FA}" is not allowed in product UI. Use an icon instead.',
      );
    },
  );

  rule.invalid(
    "reports variation selector U+FE0F in a keycap sequence",
    'const s = "Press 1\\uFE0F\\u20E3 to continue";',
    (output) => {
      assert.include(output, 'Emoji "\uFE0F" is not allowed in product UI. Use an icon instead.');
    },
  );

  rule.invalid(
    "reports the first pictograph in a ZWJ sequence",
    'const s = "\\u{1F468}\\u200D\\u{1F469}\\u200D\\u{1F467}";',
    (output) => {
      assert.include(
        output,
        'Emoji "\u{1F468}" is not allowed in product UI. Use an icon instead.',
      );
    },
  );

  rule.invalid(
    "reports only the first emoji when a node contains multiple emoji",
    'const s = "🎉📦";',
    (output) => {
      assert.include(output, 'Emoji "🎉" is not allowed in product UI. Use an icon instead.');
      assert.notInclude(output, 'Emoji "📦"');
      assert.strictEqual(output.match(/hark\(no-emoji\)/gu)?.length, 1);
    },
  );
});
