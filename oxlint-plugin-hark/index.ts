import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noEmoji from "./rules/no-emoji.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import noUnreasonedStateSync from "./rules/no-unreasoned-state-sync.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "hark",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-em-dash-copy": noEmDashCopy,
    "no-emoji": noEmoji,
    "no-low-value-comments": noLowValueComments,
    "no-unreasoned-state-sync": noUnreasonedStateSync,
    "require-suppression-reason": requireSuppressionReason,
  },
});
