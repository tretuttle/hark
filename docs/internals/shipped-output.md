# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive, and it fails naming the file and the rule.

The check answers one question: is every shipped file what the build step that wrote it writes, with no source file or source map beside it? The reference is that step. It runs the step again on every script and stylesheet, including those a page or vector carries inline, and fails a file that comes back smaller by more than a measured margin. Everything else it does finds source maps and source files by their structure, or fails closed on what it cannot read.

## One table of build steps, shared by the build and the check

`MINIFIED` in `scripts/minify.ts` maps each kind of minified file to the step that writes it and that step's options, comment handling included. `extension.config.js` and `build-experiment.ts` build with its entries, and the check runs the same entry again on each packed file:

- **Page scripts**, every `.js` but the parent: rspack's `SwcJsMinimizerRspackPlugin`. It moves legal comments, by rspack's own condition, into `<chunk>.LICENSE.txt`, leaves a `/*! LICENSE: <chunk>.LICENSE.txt */` pointer, and drops every other comment.
- **The parent script**, where the manifest's `experiment_apis` names it: `build-experiment.ts` runs SWC with the same options after rolldown bundles it, and drops every comment, legal ones too.
- **Stylesheets**: lightningcss, run until a pass changes nothing.
- **A vector's `<style>`**: the same, with media ranges written as `min-width` and `max-width`. An SVG is XML, where a bare `<` is not allowed in character data, and lightningcss otherwise writes `(width<=14px)`. Written by the stylesheet step, the toolbar icon's style draws nothing in Zen or resvg. `toolbar-icon.ts` writes that style by hand, already at this step's fixed point.

The build writes no inline script or style attribute, so the check treats one like the parent script or a stylesheet.

The comment option has to be the writing step's own. Re-minifying every script with legal comments kept passed a page script that kept a 1,142 byte legal comment holding a readable function, because a second run saves 0. Dropping every comment failed the page build's own 36 byte pointer.

No step writes a comment but the page step's pointer, so a comment is not checked by length. The `comment` rule fails every comment the parser finds in a script, page or vector, except the pointer the page step writes for that file: exactly `/*! LICENSE: <chunk>.LICENSE.txt */`, naming the file's own notice, on the first line. A one byte `/*!a*/` fails, and so does `/*! function f(){return 1} */`, which an rspack build with `extractComments: false` keeps and which a length margin would have passed.

A file is minified when its step, run again, saves at most a small absolute margin. The margins are measured, not chosen:

- **Scripts, 16 bytes.** SWC with `compress.passes: 0` runs until a pass changes nothing. A second run then saves 0 bytes on every packed script. On the 25 libraries `minify.test.ts` builds through both script build paths, the most it saves is vue's: 6 bytes through the page build and 8 through the parent build. With rspack's default of 2 passes it left 509 bytes on zod and 468 on vue, which is why both build paths use `passes: 0`.
- **Stylesheets, 0 bytes.** One lightningcss run is not always a fixed point. Of the 58 sheets those libraries ship, a second run changes 4 of Bootstrap 5.3.8's and shortens `bootstrap.css` by 1 byte, so one run would fail that honest sheet by 1 byte. Every sheet settles by the second run, so the step runs until a pass changes nothing, and a second run of its output saves 0. A sheet that still changes after 8 runs fails the build, and `cannot-check` in the check. The step passes no browser targets, because every browser this ships to is a current Gecko.

A margin is the most readable code that can hide in a file's code, since a comment fails on its own. With 16 bytes, no readable function or arrow function fits on any packed script, two spaced statements (52 bytes) do, and nothing fits on a stylesheet. A version bump that moves a residual past its margin fails `minify.test.ts` first: re-measure and change the margin with the numbers.

## Fail closed is one rule

`KINDS` in `xpi-rules.ts` is total over what an XPI may ship: each kind of file, the suffixes it ends in, the build step that writes it and the parser that decodes it. Scripts are decoded by oxc-parser, stylesheets by lightningcss, pages by parse5, vectors by saxes as XML 1.0 with an `svg` root, JSON by `JSON.parse`, PNGs chunk by chunk, and notices as UTF-8. A file whose suffix no row names, or whose bytes its parser rejects, fails `cannot-check` with the parser's reason, such as `1:210: disallowed character in tag name` for the bare `<` the stylesheet step wrote into the toolbar icon.

`cannot-check` covers everything that stops the check from deciding on a file: an unknown suffix, bytes that are not UTF-8, nesting past the check's limit, a parser or minifier error, JSON that does not parse, a script or stylesheet the minifier reduces to nothing (an empty file included), a rule that throws, and a reading process that crashes or runs out of time. An archive that cannot be opened at all fails under its own name.

**Nesting has a limit of the check's own: 256 brackets.** The parsers and minifiers recurse natively, so where they crash depends on the machine's stack. SWC crashed on an array nested 5000 deep on one machine and minified it on the CI runner, and at a 1 MB stack it crashed from 600. A verdict that depends on the runner is not fail closed, so before any parser, minifier or `JSON.parse` sees a script, stylesheet, JSON file or JSON candidate, a plain loop counts its deepest bracket nesting. Past 256 the file fails with the depth it measured. Honest output is shallow: 20 levels at most across every packed file and the libraries through both script builds, brackets inside strings and regular expressions included. The check gives the same verdicts with `ulimit -s 1024` and `node --stack-size=200`.

The crash path stays as the backstop for what the limit does not cover. `xpi-check-child.ts` reads the files in a child process and prints a line before each one, so a native crash names the file it was on, and `check-xpi.ts` starts a new child for the rest. The child gets the check's own Node flags. The tests prove this with a child that kills itself with SIGKILL and one that exits without a verdict, because an abort or a segfault writes a core dump on every machine that runs the suite; `check-xpi.test.ts` fails if any check or reading process in it ends on a signal that dumps core.

## Real parsers, not scanners

- **Pages** are read with parse5, which implements the HTML standard's tokenizer, so tags, character references and end tags are what a browser sees. **Vectors** are read with saxes, a conforming XML 1.0 parser, because a browser loads an SVG file as XML: a file it rejects draws nothing, and fails. Saxes builds the same tree parse5 does, so one walk reads both. Every script-bearing place either exposes is checked as a file of its own kind: `<script>` and `<style>` bodies, `on*` handlers, `style` attributes, `javascript:` and `data:` URLs in URL attributes (after the URL parser strips tabs and line breaks), and `srcdoc` pages, recursively. A comment in a page or a vector fails. A vector fails when whitespace with a line break sits between its elements, because the build ships its icons on one line.
- **Scripts** are read with oxc-parser, the parser the build runs. Its comments are checked by the `comment` rule above, and its strings and object literals are read only to find a source map or a `sourceMappingURL`.
- **Source maps** are recognised by their keys in any order after `JSON.parse`: as a JSON file or any value in it, a JSON string inside a value, a script string or object literal, or a page or vector text or attribute value. A PNG is read chunk by chunk: anything after `IEND`, a text chunk or a bad checksum fails it.

## What the check does not cover

**String contents and the text of a license notice.** The minifier treats a string as data and writes its contents back unchanged. So "did the build minify this?" has no answer for a string, and minifying cannot make it smaller, which is the performance reason for the rule. Every rule that guesses which strings hold source fails a published library: ejs, handlebars and djv ship their own runtime source as strings to compile at run time. A `.LICENSE.txt` is the comments the page step moved out of a chunk; the browser does not run it, and it is searched only for a source map.

So readable source inside a string or a license notice passes. No build mistake writes it there: a skipped minify leaves whitespace, names and comments in the code, and those fail. Putting it there is concealment, not a build mistake. The same holds for a source map split across two files, base64-encoded in a string, or inside a CSS string.

A stylesheet whose rules are joined by U+2028, with nothing else to remove, passes, correctly. CSS reads U+2028 as part of a name, so lightningcss writes those bytes back unchanged, and that is what the build writes for any source holding the character. A sheet that skipped the minifier keeps spaces, line breaks or comments, which fail, and layout written with U+2028 does not parse.

## The parent's result shape is checked at run time

`experiment/parent-api.ts` builds the API object from injected reads, so `contract.test.ts` runs the real handler in Node. It compares `Object.keys` of the result, the browser object and both toolbox shapes with `environmentKeys` in `contract.ts`. TypeScript checks excess properties only on a fresh literal; a returned variable with an extra key passes typecheck and fails this comparison.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
