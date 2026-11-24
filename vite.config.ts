import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const TEST_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.{idea,git,cache,output,temp}/**"];
// Suites that can reach a real signal run only inside the PID namespace that
// tools/browser-harness/src/namespace-suites.test.ts starts, and each proves its isolation first.
const NAMESPACE_SUITES = "**/*.namespace.test.ts";
const namespaceRun = process.env.HARK_NAMESPACE_RUN === "1";

export default defineConfig({
  test: {
    environment: "node",
    ...(namespaceRun ? { include: [NAMESPACE_SUITES] } : {}),
    exclude: namespaceRun ? TEST_EXCLUDE : [...TEST_EXCLUDE, NAMESPACE_SUITES],
    // Unset, Vitest shares one cache at the monorepo root, and parallel workspace runs fail on it with ENOTEMPTY.
    fsModuleCachePath: "node_modules/.vitest-cache",
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
  },
  staged: {
    // In order, so lint reads the formatted file. CI lint failures cost a full round trip.
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
    // knip checks the whole repo, so it takes no file list. Any code or manifest change can leave
    // a file, export, or dependency unused.
    "{*.{js,jsx,ts,tsx,mjs,cjs,mts,cts},package.json,knip.jsonc}": () => "pnpm run knip:check",
  },
  fmt: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-hark/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "react/no-object-type-as-default-prop": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react/memo-dependencies": "error",
      "react/purity": "error",
      "react/refs": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/set-state-in-effect": "error",
      "react/immutability": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/static-components": "error",
      "react/capitalized-calls": "error",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "unicorn/no-useless-spread": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/require-module-specifiers": "error",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "hark/namespace-node-imports": "error",
      "hark/no-low-value-comments": "error",
      "hark/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: ["apps/*/src/**", "packages/*/src/**"],
        excludeFiles: ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
        rules: { "hark/no-em-dash-copy": "error", "hark/no-emoji": "error" },
      },
      {
        files: ["apps/*/src/**", "packages/*/src/**"],
        rules: { "hark/no-unreasoned-state-sync": "error" },
      },
      {
        // Pages hold the moz-extension principal and reach the host only through browser.hark.
        files: ["apps/extension/src/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/experiment/*", "!**/experiment/contract.ts"],
                  message:
                    "Extension pages call browser.hark; only experiment/contract.ts is theirs to import.",
                },
              ],
            },
          ],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
