// Honest output must pass check-xpi whatever library it bundles. Each library is built through both script build
// paths the product has, the rspack page build with pageMinimizers and the parent build with bundleScript, and the
// packed result is checked the way CI checks the real XPI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DefinePlugin,
  rspack,
  SwcJsMinimizerRspackPlugin,
  type RspackPluginInstance,
} from "@rspack/core";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { bundleScript } from "./build-experiment.ts";
import { extensionRoot } from "./manifest.ts";
import { MINIFIED, pageMinimizers } from "./minify.ts";

const checkScript = NodePath.join(extensionRoot, "scripts", "check-xpi.ts");

// Popular libraries, each built through both paths. Several ship their own runtime source as
// strings (ejs, handlebars, djv), which the check does not inspect. Packages without `exports` are imported by file,
// because the parent build's neutral platform ignores `main`.
const LIBRARIES: Readonly<Record<string, string>> = {
  react: 'import * as a from "react";import * as b from "react-dom/client";globalThis.lib=[a,b];',
  fflate: 'import * as a from "fflate";globalThis.lib=a;',
  zod: 'import * as a from "zod";globalThis.lib=a;',
  effect: 'import * as a from "effect/Effect";globalThis.lib=a;',
  vue: 'import * as a from "vue";globalThis.lib=a;',
  yaml: 'import * as a from "yaml";globalThis.lib=a;',
  "js-yaml": 'import * as a from "js-yaml";globalThis.lib=a;',
  acorn: 'import * as a from "acorn";globalThis.lib=a;',
  ajv: 'import * as a from "ajv/dist/ajv.js";globalThis.lib=a;',
  bootstrap: 'import * as a from "bootstrap/dist/js/bootstrap.bundle.js";globalThis.lib=a;',
  "libphonenumber-js/max": 'import * as a from "libphonenumber-js/max";globalThis.lib=a;',
  dayjs: 'import * as a from "dayjs/dayjs.min.js";globalThis.lib=a;',
  zustand: 'import * as a from "zustand/vanilla";globalThis.lib=a;',
  marked: 'import * as a from "marked";globalThis.lib=a;',
  pako: 'import * as a from "pako";globalThis.lib=a;',
  "lru-cache": 'import * as a from "lru-cache";globalThis.lib=a;',
  "lit-html": 'import * as a from "lit-html";globalThis.lib=a;',
  ejs: 'import * as a from "ejs/ejs.js";globalThis.lib=a;',
  handlebars: 'import * as a from "handlebars/dist/cjs/handlebars.js";globalThis.lib=a;',
  djv: 'import * as a from "djv/lib/djv.js";globalThis.lib=a;',
  kysely: 'import * as a from "kysely";globalThis.lib=a;',
  prismjs: 'import * as a from "prismjs/prism.js";globalThis.lib=a;',
  greenlet: 'import * as a from "greenlet/dist/greenlet.m.js";globalThis.lib=a;',
  "sql.js": 'import * as a from "sql.js/dist/sql-wasm.js";globalThis.lib=a;',
  jsonschema: 'import * as a from "jsonschema/lib/index.js";globalThis.lib=a;',
};

/** The rspack production build of the pages, with the minimizers extension.config.js installs unless `minimizer`. */
const buildPage = (
  entry: string,
  outDir: string,
  minimizer: RspackPluginInstance[] = pageMinimizers(),
): Promise<void> =>
  new Promise((resolve, reject) => {
    const compiler = rspack({
      mode: "production",
      target: "web",
      entry,
      output: { path: outDir, filename: "vendor.js", cssFilename: "vendor.css" },
      module: { rules: [{ test: /\.css$/, type: "css/auto" }] },
      // sql.js and jsonschema refer to Node modules they only use under Node; a page build leaves them out.
      resolve: { fallback: { crypto: false, fs: false, path: false, url: false } },
      plugins: [new DefinePlugin({ "process.env.NODE_ENV": JSON.stringify("production") })],
      optimization: { minimize: true, minimizer },
    });
    compiler.run((error, stats) => {
      if (error !== null) reject(error);
      else if (stats?.hasErrors() === true)
        reject(new Error(stats.toString({ all: false, errors: true })));
      else compiler.close(() => resolve());
    });
  });

/** Every file under `dir`, keyed by the archive path it gets below `prefix`. */
const filesUnder = (dir: string, prefix: string): Record<string, Uint8Array> =>
  Object.fromEntries(
    NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        return [
          `${prefix}${NodePath.relative(dir, file).split(NodePath.sep).join("/")}`,
          NodeFS.readFileSync(file),
        ];
      }),
  );

// A legal comment that holds a readable function, to show how each script step handles legal comments.
const LEGAL_ENTRY = `console.log(/*! @license MIT
function collectHeaders(entries) {
  const result = [];
  for (const entry of entries) result.push(entry.name);
  return result;
}
${"Permission is hereby granted, free of charge, to any person obtaining a copy. ".repeat(10)}*/ "x");`;

const BUILD_PATHS = {
  page: async (entry: string, dir: string) => {
    await buildPage(entry, dir);
    return filesUnder(dir, "shared/");
  },
  parent: async (entry: string, dir: string) => {
    await bundleScript(entry, NodePath.join(dir, "parent.js"), true);
    return filesUnder(dir, "experiment/");
  },
  "parent, not minified": async (entry: string, dir: string) => {
    await bundleScript(entry, NodePath.join(dir, "parent.js"), false);
    return filesUnder(dir, "experiment/");
  },
  // Two page builds that keep legal comments in the code, one with the extractor off and one beside it.
  "page, comments kept and not extracted": async (entry: string, dir: string) => {
    await buildPage(entry, dir, [
      new SwcJsMinimizerRspackPlugin({
        extractComments: false,
        minimizerOptions: { format: { comments: "all" } },
      }),
    ]);
    return filesUnder(dir, "shared/");
  },
  "page, legal comments kept beside the pointer": async (entry: string, dir: string) => {
    await buildPage(entry, dir, [
      new SwcJsMinimizerRspackPlugin({
        extractComments: true,
        minimizerOptions: { format: { comments: "some" } },
      }),
    ]);
    return filesUnder(dir, "shared/");
  },
} as const;

// Entries sit under node_modules so the bundlers resolve each library from this package.
let workDir = "";

beforeAll(() => {
  const cache = NodePath.join(extensionRoot, "node_modules", ".cache");
  NodeFS.mkdirSync(cache, { recursive: true });
  workDir = NodeFS.mkdtempSync(NodePath.join(cache, "minify-test-"));
});

afterAll(() => {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
});

/** Builds `source` along `path`, packs what it writes and runs check-xpi on the archive. */
const checkBuilt = async (
  name: string,
  source: string,
  path: keyof typeof BUILD_PATHS,
): Promise<{ status: number | null; stderr: string; files: Record<string, Uint8Array> }> => {
  const dir = NodePath.join(workDir, `${name}-${path}`.replaceAll(/\W+/g, "-"));
  NodeFS.mkdirSync(dir, { recursive: true });
  const entry = NodePath.join(dir, "entry.js");
  NodeFS.writeFileSync(entry, source);
  const out = NodePath.join(dir, "out");
  const xpi = NodePath.join(dir, "built.xpi");
  const files = await BUILD_PATHS[path](entry, out);
  NodeFS.writeFileSync(xpi, zipSync(files));
  const { NO_COLOR: _noColor, FORCE_COLOR: _forceColor, ...env } = process.env;
  const child = NodeChildProcess.spawn(process.execPath, [checkScript, xpi], { env });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr, files };
};

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe.concurrent("honest builds of popular libraries", () => {
  it.each(Object.entries(LIBRARIES))("pass through the page build: %s", async (library, source) => {
    const result = await checkBuilt(library, source, "page");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(Object.entries(LIBRARIES))(
    "pass through the parent build: %s",
    async (library, source) => {
      const result = await checkBuilt(library, source, "parent");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  // One lightningcss run leaves 1 byte of this sheet for a second run; the style step runs until nothing changes.
  it("pass through the page build: bootstrap's stylesheet", async () => {
    const result = await checkBuilt(
      "bootstrap-css",
      'import "bootstrap/dist/css/bootstrap.css";console.log("styled");',
      "page",
    );
    expect(Object.keys(result.files)).toContain("shared/vendor.css");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fail through the parent build with minify off, so this test can see a failure", async () => {
    const result = await checkBuilt("fflate", LIBRARIES.fflate ?? "", "parent, not minified");
    expect(result.stderr).toMatch(/^FAIL experiment\/parent\.js: not-minified: /m);
    expect(result.status).toBe(1);
  });
});

describe.concurrent("legal comments, as each script step handles them", () => {
  it("the page build moves them to a notice and leaves the pointer the check's page step writes", async () => {
    const result = await checkBuilt("legal", LEGAL_ENTRY, "page");
    const chunk = text(result.files["shared/vendor.js"]);
    expect(text(result.files["shared/vendor.js.LICENSE.txt"])).toContain("@license MIT");
    expect(chunk.startsWith("/*! LICENSE: vendor.js.LICENSE.txt */\n")).toBe(true);
    expect(MINIFIED["page-script"].run(chunk, "shared/vendor.js")).toBe(chunk);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("the parent build drops them, and its output passes", async () => {
    const result = await checkBuilt("legal", LEGAL_ENTRY, "parent");
    const script = text(result.files["experiment/parent.js"]);
    expect(script).not.toContain("@license");
    expect(MINIFIED["parent-script"].run(script, "experiment/parent.js")).toBe(script);
    expect(result.status).toBe(0);
  });

  it("a page build that keeps a 28 byte one fails, though removing it would save less than the margin", async () => {
    const result = await checkBuilt(
      "short-legal",
      'console.log(/*! function f(){return 1} */ "x");',
      "page, comments kept and not extracted",
    );
    expect(text(result.files["shared/vendor.js"])).toContain("/*! function f(){return 1} */");
    expect(result.stderr).toMatch(/^FAIL shared\/vendor\.js: comment: /m);
    expect(result.status).toBe(1);
  });

  it.each([
    "page, comments kept and not extracted",
    "page, legal comments kept beside the pointer",
  ] as const)("a page build that keeps them fails: %s", async (path) => {
    const result = await checkBuilt("legal", LEGAL_ENTRY, path);
    expect(result.stderr).toMatch(/^FAIL shared\/vendor\.js: not-minified: /m);
    expect(result.status).toBe(1);
  });
});
