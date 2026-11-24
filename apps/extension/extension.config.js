import { pageMinimizers } from "./scripts/minify.ts";

// `pnpm dev` runs a Gecko browser on a managed profile. Set GECKO_BINARY to choose the binary.
const geckoBinary = process.env.GECKO_BINARY;

export default {
  // scripts/ holds this repo's tooling. By default extension.js bundles any script in it that imports no Node builtin.
  folders: { scripts: false, pages: "src/pages" },
  browser: {
    zen: {
      ...(geckoBinary !== undefined && geckoBinary.length > 0 ? { geckoBinary } : {}),
      preferences: { "extensions.experiments.enabled": true },
    },
  },
  // The page scripts and styles are minified by scripts/minify.ts, which check-xpi runs again on the packed files.
  config: (config) => ({
    ...config,
    optimization: { ...config.optimization, minimizer: pageMinimizers() },
  }),
};
