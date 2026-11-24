// Every kind of minified file the build ships, the step that writes it and the options that step runs with, in one
// table. extension.config.js and build-experiment.ts build with these entries and check-xpi runs the same entry
// again on each packed file, comment handling included, so the build and the check cannot disagree.
import * as NodePath from "node:path";
import {
  Compilation,
  SwcJsMinimizerRspackPlugin,
  sources,
  experiments,
  type Compiler,
  type RspackPluginInstance,
} from "@rspack/core";
import { Features, transform, transformStyleAttribute } from "lightningcss";
import { parseSync } from "oxc-parser";

// extension.js turns reduce_vars and collapse_vars off; this keeps its choice. `passes: 0` runs compress until a pass
// changes nothing; rspack's default of 2 passes left 509 bytes on zod for a second run to find. Both script steps
// drop every comment from the code; the page step moves legal comments to a notice first.
const SCRIPT_OPTIONS = {
  compress: { passes: 0, reduce_vars: false, collapse_vars: false },
  mangle: true,
  ecma: 2022,
  module: false,
  format: { comments: false },
} as const;

// rspack's own condition for `extractComments: true`, written out so the check looks for the comments the build moves.
const LEGAL_COMMENT = /@preserve|@lic|@cc_on|^\**!/;

/** The comment SwcJsMinimizerRspackPlugin writes on the first line of a chunk whose legal comments it moved. */
const licensePointer = (path: string): string =>
  `/*! LICENSE: ${NodePath.posix.basename(path)}.LICENSE.txt */`;

/** A script step: SWC with `SCRIPT_OPTIONS`, after moving comments that match `extractComments`, if set. */
const scriptStep = <Extract extends RegExp | undefined>(extractComments: Extract) => ({
  extractComments,
  run: (code: string, path: string): string => {
    const moved =
      extractComments !== undefined &&
      parseSync("chunk.js", code, { lang: "js" }).comments.some(({ value }) =>
        extractComments.test(value),
      );
    const minified = experiments.swc.minifySync(code, SCRIPT_OPTIONS).code;
    return moved ? `${licensePointer(path)}\n${minified}` : minified;
  },
});

// No targets: every browser this ships to is a current Gecko, so lightningcss only minifies and never lowers syntax.
// extension.js also keeps :dir() and :lang() lists as written.
const STYLE_OPTIONS = {
  minify: true,
  exclude: Features.DirSelector | Features.LangSelectorList,
} as const;

// One lightningcss run is not always a fixed point. Of the 58 sheets the libraries in minify.test.ts ship, a second
// run changes 4 of Bootstrap 5.3.8's and shortens bootstrap.css by 1 byte; every one settles by the second run.
const MAX_STYLE_PASSES = 8;

/** Runs `pass` until it changes nothing, as `compress.passes: 0` does for scripts. */
const untilSettled =
  (pass: (code: string) => string) =>
  (code: string): string => {
    let current = pass(code);
    for (let run = 1; run < MAX_STYLE_PASSES; run++) {
      const next = pass(current);
      if (next === current) return current;
      current = next;
    }
    throw new Error(`lightningcss still changes the sheet after ${MAX_STYLE_PASSES} runs`);
  };

const minifyStyle = untilSettled((code) =>
  transform({ ...STYLE_OPTIONS, filename: "style.css", code: Buffer.from(code) }).code.toString(),
);

// An SVG's <style> is XML character data, where a bare `<` is not allowed. lightningcss writes media ranges as
// `(width<=14px)`, so for a vector it writes them as `(max-width:14px)`, the form that needs no `<`.
const minifyVectorStyle = untilSettled((code) =>
  transform({
    ...STYLE_OPTIONS,
    include: Features.MediaRangeSyntax,
    filename: "style.css",
    code: Buffer.from(code),
  }).code.toString(),
);

/** The declarations of a `style` attribute, which are not a stylesheet and parse differently. */
export const minifyStyleAttribute = untilSettled((code) =>
  transformStyleAttribute({
    ...STYLE_OPTIONS,
    filename: "style",
    code: Buffer.from(code),
  }).code.toString(),
);

// What a second run of a script step still saves on honest output, measured: 0 bytes on every packed script, and at
// most 8 on the libraries minify.test.ts builds (vue, parent build). 16 is twice that. A comment never counts against
// it: check-xpi fails any comment but the one a step writes. One 210 byte readable function saves 89.
const SCRIPT_MARGIN_BYTES = 16;

export interface Step {
  readonly builtBy: string;
  /** The step, on a file that ships at `path`. */
  readonly run: (code: string, path: string) => string;
  /** At most how many bytes a second run saves on the step's own output. */
  readonly margin: number;
  /** The one comment the step writes into a file at `path`, on its first line, if it writes any. */
  readonly comment?: (path: string) => string;
}

/** Each kind of minified file the build ships, keyed by the kind check-xpi gives a packed file. */
export const MINIFIED = {
  "page-script": {
    builtBy:
      "rspack's SwcJsMinimizerRspackPlugin in the page build, which moves legal comments to <chunk>.LICENSE.txt, leaves a pointer to it and drops every other comment",
    ...scriptStep(LEGAL_COMMENT),
    margin: SCRIPT_MARGIN_BYTES,
    comment: licensePointer,
  },
  "parent-script": {
    builtBy: "build-experiment.ts, which drops every comment, legal ones too",
    ...scriptStep(undefined),
    margin: SCRIPT_MARGIN_BYTES,
  },
  style: {
    builtBy: "the StyleMinimizer in the rspack page build, run until a pass changes nothing",
    run: minifyStyle,
    margin: 0,
  },
  "vector-style": {
    builtBy:
      "toolbar-icon.ts, which writes the icon's <style> already minified, with media ranges as min- and max-",
    run: minifyVectorStyle,
    margin: 0,
  },
} as const satisfies Readonly<Record<string, Step>>;

/** The parent script step, for code that is not a file in the archive. */
export const minifyScript = (code: string): string => MINIFIED["parent-script"].run(code, "");

/** Runs the stylesheet step on every stylesheet rspack emits, where extension.js would run its own options. */
class StyleMinimizer implements RspackPluginInstance {
  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap(StyleMinimizer.name, (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: StyleMinimizer.name, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE },
        (assets) => {
          for (const [name, asset] of Object.entries(assets)) {
            if (name.endsWith(".css"))
              compilation.updateAsset(
                name,
                new sources.RawSource(MINIFIED.style.run(asset.source().toString())),
              );
          }
        },
      );
    });
  }
}

/** The page build's minimizers, with the page-script and style entries of `MINIFIED`. */
export const pageMinimizers = (): RspackPluginInstance[] => [
  new SwcJsMinimizerRspackPlugin({
    extractComments: { condition: MINIFIED["page-script"].extractComments },
    minimizerOptions: SCRIPT_OPTIONS,
  }),
  new StyleMinimizer(),
];
