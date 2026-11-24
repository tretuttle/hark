import { defineRule, type ESTree } from "@oxlint/plugins";

// ©, ®, and ™ have the Extended_Pictographic Unicode property, but are legal typography rather than emoji.
const ALLOWED = new Set(["©", "®", "™"]);
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{20E3}/u;

function findEmoji(text: string): string | null {
  for (const ch of text) {
    if (ALLOWED.has(ch)) continue;
    if (EMOJI.test(ch)) return ch;
  }
  return null;
}

// Comments never reach the UI, so only string and JSX text nodes are checked.
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow emoji in strings and JSX text; product UI uses icons.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      const char = findEmoji(text);
      if (char !== null) {
        context.report({
          node,
          message: `Emoji "${char}" is not allowed in product UI. Use an icon instead.`,
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});
