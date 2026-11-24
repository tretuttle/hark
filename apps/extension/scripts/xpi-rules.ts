// What may ship in an XPI, as tables: the kind of each file, the build step that writes it with the minifier that
// step runs, and the rules. A file's suffix only says what it claims to be; a reader parses its bytes into facts and
// the rules check the facts. Every rule carries at least one archive that must fail it, and check-xpi.test.ts runs them.
import * as NodeZlib from "node:zlib";
import { CANNOT_CHECK } from "./check-xpi.ts";
import { FILE_WORKER } from "../experiment/contract.ts";
import { readManifest } from "./manifest.ts";
import { MINIFIED, minifyScript, minifyStyleAttribute, type Step } from "./minify.ts";
import { readMarkup, type BodyKind, type Markup } from "./xpi-markup.ts";
import { lineOf, parseScript, type ScriptFacts } from "./xpi-source.ts";

/** A body's kind, or for a file in the archive, the build step it comes from. A carried `script` is inline code. */
export type Kind = BodyKind | "page-script" | "parent-script" | "notice" | "source-map" | "source";

// build-experiment.ts writes the parent script where the manifest names it, and the parent's file worker; rspack writes
// every other script.
const PARENT_SCRIPT = [
  ...Object.values(readManifest().experiment_apis).map(({ parent }) =>
    parent.script.replace(/^\//, ""),
  ),
  FILE_WORKER,
];

/** A file in the archive, or a body carried inside one (an inline `<script>`, a `srcdoc` page). */
export interface Unit {
  readonly path: string;
  /** Set for a body carried inside the file at `path`. */
  readonly where: string | undefined;
  readonly kind: Kind | undefined;
  readonly bytes: Uint8Array;
  /** How many archive entries have this path. */
  readonly entries: number;
}

/** What reading a unit found, by how it was read. */
export type Facts =
  | {
      readonly form: "script";
      readonly text: string;
      readonly script: ScriptFacts;
      readonly saved: number;
    }
  | { readonly form: "style"; readonly text: string; readonly saved: number }
  | { readonly form: "markup"; readonly text: string; readonly markup: Markup }
  | { readonly form: "data"; readonly text: string; readonly value: unknown }
  | { readonly form: "text"; readonly text: string }
  | { readonly form: "raster" };

export type Read =
  | { readonly unit: Unit; readonly facts: Facts }
  | { readonly unit: Unit; readonly failure: string; readonly text: string | undefined };

const textOf = (read: Read): string | undefined =>
  "facts" in read ? ("text" in read.facts ? read.facts.text : undefined) : read.text;

class Unreadable extends Error {}

// The parsers and minifiers recurse natively, so a deep enough file crashes them, at a depth set by the machine's
// stack: SWC on 5000 nested brackets here, not on the CI runner. The check stops first, at its own limit. Honest
// output is shallow: 20 levels at most in every packed file and in eight libraries through both script builds,
// counting brackets inside strings and regular expressions too. 256 is over twelve times that.
const MAX_NESTING = 256;

/** The deepest bracket nesting in `text`, counted without parsing, so no input can make the count itself recurse. */
const nestingDepth = (text: string): number => {
  let depth = 0;
  let deepest = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x28 || code === 0x5b || code === 0x7b) deepest = Math.max(deepest, ++depth);
    else if ((code === 0x29 || code === 0x5d || code === 0x7d) && depth > 0) depth--;
  }
  return deepest;
};

/** Refuses text nested past `MAX_NESTING` before any parser or minifier sees it. */
const ensureShallow = (text: string, what: string): void => {
  const depth = nestingDepth(text);
  if (depth > MAX_NESTING)
    throw new Unreadable(
      `${what} is nested ${depth} brackets deep; the check reads at most ${MAX_NESTING}, and minified output reaches about 20`,
    );
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // swc throws a debug dump that repeats the whole source; its `message` field is the part worth reading.
  return (/message: "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text)
    .slice(0, 200)
    .replaceAll(/\s+/g, " ");
};

/** Runs the producer's step. A file it cannot read, or one it reduces to nothing, is not minified output. */
const measure = (unit: Unit, text: string): number => {
  const { step } = KINDS[unit.kind ?? "source"];
  if (step === undefined) throw new Error(`no minifier for ${String(unit.kind)}`);
  let minified: string;
  try {
    minified = step.run(text, unit.path);
  } catch (error) {
    throw new Unreadable(`the build's minifier fails on it: ${messageOf(error)}`);
  }
  if (unit.where === undefined && minified.trim() === "")
    throw new Unreadable("the build's minifier reduces it to nothing, so it does no work");
  return text.length - minified.length;
};

const textIn = (unit: Unit): string => {
  try {
    return utf8.decode(unit.bytes);
  } catch {
    throw new Unreadable("is not valid UTF-8");
  }
};

const decodeScript = (unit: Unit): Facts => {
  const text = textIn(unit);
  ensureShallow(text, "it");
  const script = parseScript(text);
  const [error] = script.errors;
  if (error !== undefined) throw new Unreadable(`does not parse: ${error}`);
  return { form: "script", text, script, saved: measure(unit, text) };
};

const decodeStyle = (unit: Unit): Facts => {
  const text = textIn(unit);
  ensureShallow(text, "it");
  return { form: "style", text, saved: measure(unit, text) };
};

const decodeMarkup =
  (form: "page" | "vector") =>
  (unit: Unit): Facts => {
    const text = textIn(unit);
    let markup: Markup;
    try {
      markup = readMarkup(text, form);
    } catch (error) {
      throw new Unreadable(`is not well-formed XML: ${messageOf(error)}`);
    }
    if (unit.where === undefined && !markup.hasRoot)
      throw new Unreadable(
        form === "page"
          ? "is not an HTML page: it has no doctype and no html tag"
          : "is not an SVG image: it parses to no svg element",
      );
    return { form: "markup", text, markup };
  };

const decodeData = (unit: Unit): Facts => {
  const text = textIn(unit);
  ensureShallow(text, "it");
  try {
    return { form: "data", text, value: JSON.parse(text) };
  } catch (error) {
    throw new Unreadable(`is not valid JSON: ${messageOf(error)}`);
  }
};

const decodeRaster = (unit: Unit): Facts => {
  const problem = pngProblem(unit.bytes);
  if (problem !== undefined) throw new Unreadable(`is not a PNG of image data alone: ${problem}`);
  return { form: "raster" };
};

const decodeText = (unit: Unit): Facts => ({ form: "text", text: textIn(unit) });

interface KindRow {
  /** What a file of this kind ends in. A kind with none is found by path, or is only ever carried inside a file. */
  readonly suffixes: readonly string[];
  readonly builtBy: string;
  /** The step that minified it, which the check runs again. */
  readonly step?: Step;
  readonly decodedBy: string;
  /** The facts in the unit, or `Unreadable` with why the decoder rejects it. */
  readonly decode: (unit: Unit) => Facts;
}

/**
 * Every kind of file an XPI may ship: the suffixes it ends in, the build step that writes it, and the parser that
 * decodes it. A path whose suffix no row names cannot be decoded, and fails cannot-check like any file a parser rejects.
 */
export const KINDS: Readonly<Record<Kind, KindRow>> = {
  "page-script": {
    suffixes: [".js"],
    builtBy: MINIFIED["page-script"].builtBy,
    step: MINIFIED["page-script"],
    decodedBy: "oxc-parser",
    decode: decodeScript,
  },
  "parent-script": {
    suffixes: [],
    builtBy: MINIFIED["parent-script"].builtBy,
    step: MINIFIED["parent-script"],
    decodedBy: "oxc-parser",
    decode: decodeScript,
  },
  script: {
    suffixes: [],
    builtBy: "nothing; the build writes no inline script, so one is checked like the parent script",
    step: MINIFIED["parent-script"],
    decodedBy: "oxc-parser",
    decode: decodeScript,
  },
  style: {
    suffixes: [".css"],
    builtBy: MINIFIED.style.builtBy,
    step: MINIFIED.style,
    decodedBy: "lightningcss",
    decode: decodeStyle,
  },
  "vector-style": {
    suffixes: [],
    builtBy: MINIFIED["vector-style"].builtBy,
    step: MINIFIED["vector-style"],
    decodedBy: "lightningcss",
    decode: decodeStyle,
  },
  "style-attribute": {
    suffixes: [],
    builtBy: "nothing; the build writes no style attribute, so one is checked like a stylesheet",
    step: { ...MINIFIED.style, run: minifyStyleAttribute },
    decodedBy: "lightningcss, as a declaration list",
    decode: decodeStyle,
  },
  vector: {
    suffixes: [".svg"],
    builtBy: "extension.js, which copies src/icons as written, on one line",
    decodedBy: "saxes, an XML 1.0 parser, then an svg root element",
    decode: decodeMarkup("vector"),
  },
  markup: {
    suffixes: [".html"],
    builtBy: "extension.js, which writes each page shell and loads every script by src",
    decodedBy: "parse5, then a doctype or an html tag",
    decode: decodeMarkup("page"),
  },
  data: {
    suffixes: [".json"],
    builtBy: "JSON.stringify: the manifest by extension.js, the schema by build-experiment.ts",
    decodedBy: "JSON.parse",
    decode: decodeData,
  },
  raster: {
    suffixes: [".png"],
    builtBy: "write-icons.ts, which renders the SVG master with resvg",
    decodedBy: "PNG chunks, each with a valid checksum, image chunks only, ending at IEND",
    decode: decodeRaster,
  },
  notice: {
    suffixes: [".LICENSE.txt"],
    builtBy: "SwcJsMinimizerRspackPlugin, which extracts legal comments into <chunk>.LICENSE.txt",
    decodedBy: "UTF-8",
    decode: decodeText,
  },
  "source-map": {
    suffixes: [".map"],
    builtBy: "nothing; the build writes no source map",
    decodedBy: "UTF-8",
    decode: decodeText,
  },
  source: {
    suffixes: [".ts", ".tsx", ".mts", ".cts", ".jsx", ".vue", ".svelte", ".scss", ".sass", ".less"],
    builtBy: "nothing; the build ships no source file",
    decodedBy: "UTF-8",
    decode: decodeText,
  },
};

export const kindOf = (path: string): Kind | undefined =>
  PARENT_SCRIPT.includes(path)
    ? "parent-script"
    : (Object.entries(KINDS) as Array<[Kind, KindRow]>).find(([, row]) =>
        row.suffixes.some((suffix) => path.endsWith(suffix)),
      )?.[0];

/** Reads a unit into facts, or throws `Unreadable` with the reason it cannot be checked. */
const read = (unit: Unit): Facts => {
  if (unit.kind === undefined)
    throw new Unreadable("ends in no suffix of KINDS, so no parser in the check can read it");
  return KINDS[unit.kind].decode(unit);
};

export const readUnit = (unit: Unit): Read => {
  try {
    return { unit, facts: read(unit) };
  } catch (error) {
    let text: string | undefined;
    try {
      text = utf8.decode(unit.bytes);
    } catch {
      text = undefined;
    }
    return {
      unit,
      failure: error instanceof Unreadable ? error.message : `reading threw: ${messageOf(error)}`,
      text,
    };
  }
};

/** The bodies a page or vector carries, as units of their own. */
export const carriedUnits = (read: Read): readonly Unit[] =>
  "facts" in read && read.facts.form === "markup"
    ? read.facts.markup.bodies.map((body) => ({
        path: read.unit.path,
        where: read.unit.where === undefined ? body.where : `${read.unit.where} > ${body.where}`,
        kind: body.kind,
        bytes: body.bytes,
        entries: 1,
      }))
    : [];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The chunks resvg writes. A text chunk could carry anything, and bytes after IEND are not image data.
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, i) => bytes[i] === byte);

/** Why the bytes are not a PNG built from image chunks alone, or undefined when they are. */
const pngProblem = (bytes: Uint8Array): string | undefined => {
  if (!startsWith(bytes, PNG_SIGNATURE)) return "does not start with the PNG signature";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > bytes.length) return `the ${type} chunk runs past the end of the file`;
    if (NodeZlib.crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4))
      return `the ${type} chunk fails its checksum`;
    if (!PNG_CHUNKS.has(type)) return `has a ${type} chunk, which the icon renderer never writes`;
    if (type === "IEND")
      return end === bytes.length ? undefined : `${bytes.length - end} bytes follow the IEND chunk`;
    at = end;
  }
  return "ends without an IEND chunk";
};

// Byte signatures of containers the build never emits. The container itself does not belong in a packed extension.
const FOREIGN_BYTES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["ZIP archive", [0x50, 0x4b, 0x03, 0x04]],
  ["ZIP archive", [0x50, 0x4b, 0x05, 0x06]],
  ["ZIP archive", [0x50, 0x4b, 0x07, 0x08]],
  ["gzip stream", [0x1f, 0x8b]],
  ["WebAssembly module", [0x00, 0x61, 0x73, 0x6d]],
  ["ELF binary", [0x7f, 0x45, 0x4c, 0x46]],
  ["Mach-O binary", [0xcf, 0xfa, 0xed, 0xfe]],
  ["Mach-O binary", [0xce, 0xfa, 0xed, 0xfe]],
  ["PDF document", [0x25, 0x50, 0x44, 0x46]],
  ["RAR archive", [0x52, 0x61, 0x72, 0x21]],
  ["7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ["PNG image", PNG_SIGNATURE],
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): boolean => Array.isArray(value) || value === "array";

/** A version 3 source map, recognised by its keys in any order. Takes a parsed JSON object or an object literal. */
const isSourceMap = (value: Readonly<Record<string, unknown>>): boolean =>
  value.version === 3 &&
  ((typeof value.mappings === "string" && isList(value.sources)) || isList(value.sections));

/** The JSON value a text holds: all of it, or the span from its first `{` to its last `}`. */
const jsonIn = (text: string): unknown => {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!/^[[{]/.test(candidate)) continue;
    ensureShallow(candidate, "JSON in it");
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Not JSON; try the next span.
    }
  }
  return undefined;
};

/** Where in a JSON value a source map sits, following strings that hold JSON of their own. */
const sourceMapIn = (root: unknown): string | undefined => {
  const pending: Array<readonly [string, unknown]> = [["$", root]];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const [at, value] = next;
    if (typeof value === "string") {
      if (value.includes("{")) pending.push([`${at} (as JSON)`, jsonIn(value)]);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => pending.push([`${at}[${i}]`, item]));
    } else if (isRecord(value)) {
      if (isSourceMap(value)) return at;
      for (const [key, item] of Object.entries(value)) pending.push([`${at}.${key}`, item]);
    }
  }
  return undefined;
};

/** Every text in a unit where JSON could sit, by how the unit was read. */
const jsonPlaces = (facts: Facts): ReadonlyArray<readonly [string, unknown]> => {
  switch (facts.form) {
    case "data":
      return [["$", facts.value]];
    case "script":
      return facts.script.strings.map(({ span, value }) => [
        `the string at line ${lineOf(facts.text, span.start)}`,
        value,
      ]);
    case "markup":
      return facts.markup.texts.map((text) => ["a text or attribute value", text]);
    case "text":
      return [["the text", facts.text]];
    default:
      return [];
  }
};

// Strings that only a development build keeps. A production build folds these away.
const DEVELOPMENT_MARKERS: ReadonlyArray<string> = [
  "NODE_ENV",
  "jsxDEV",
  "__DEV__",
  "Download the React DevTools",
];

const DEV_ONLY_PATH =
  /(^|\/)(node_modules|__tests__|__mocks__|fixtures?|tests?|scripts)\/|\.(test|spec|stories)\.|(^|\/)(package|tsconfig[^/]*)\.json$/;

const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;

const excerpt = (text: string): string => {
  const line = text.split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}...` : line;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What a failing archive needs from the real build, supplied by the test. */
export interface Fixtures {
  /** The real parent script, bundled by the real build with minify on. */
  readonly minifiedParent: string;
  /** The same bundle with minify off. */
  readonly unminifiedParent: string;
  /** React's own react-dom-client.development.js, as published. */
  readonly reactDevelopment: string;
  /** The real toolbar icon, as shipped. */
  readonly toolbarSvg: string;
  /** The shape of shared/framework.js: a legal pointer line, then React's production react-dom minified by the build. */
  readonly framework: string;
  /** framework.js.LICENSE.txt as the page build writes it: React's legal comments, a blank line apart. */
  readonly reactNotice: string;
  /** A real 16 pixel icon, rendered by write-icons.ts. */
  readonly png: Uint8Array;
}

export type Changes = Readonly<Record<string, string | Uint8Array>>;

/** One archive that must fail: the clean archive with `changes` applied. */
export interface FailingArchive {
  /** What the archive holds that the clean one does not. */
  readonly name: string;
  readonly changes: (fixtures: Fixtures) => Changes;
  /** The file that must fail. */
  readonly path: string;
  /** Every other rule that file must fail, besides the row's own. */
  readonly alsoFails?: readonly string[];
}

export interface Rule {
  readonly id: string;
  /** A path rule checks only the archive entry, not the bodies it carries. */
  readonly inspects: "path" | "contents";
  readonly decides: string;
  /** The reason the unit fails the rule, or undefined when it passes. */
  readonly check: (read: Read) => string | undefined;
  /** At least one, so every rule has an archive that fails it. */
  readonly failingArchives: readonly [FailingArchive, ...FailingArchive[]];
}

const PRETTY_FUNCTION = `function collectHeaders(entries) {
  const result = [];
  for (const entry of entries) {
    if (entry.name === undefined) {
      continue;
    }
    result.push({
      name: entry.name,
      value: String(entry.value),
    });
  }
  return result;
}
`;

/** The same function on one line: no line break to find, so only re-minifying can tell it is not minified. */
const ONE_LINE_FUNCTION =
  "function collectHeaders(entries) { const result = []; for (const entry of entries) { if (entry.name === undefined) { continue; } result.push({ name: entry.name, value: String(entry.value) }); } return result; }";

/** The toolbar icon with its style run through the stylesheet step instead of the vector-style step. */
const rangeSyntaxIcon = (fixtures: Fixtures): string =>
  fixtures.toolbarSvg.replace(
    /<style>(.*?)<\/style>/s,
    (_, css: string) => `<style>${MINIFIED.style.run(css)}</style>`,
  );

const inPage = (body: string): string => `<!DOCTYPE html><html><body>${body}</body></html>`;

const padLines = (text: string, width: number): string =>
  text
    .split("\n")
    .map((line) => line.padEnd(width))
    .join("\n");

const SOURCE_MAP = JSON.stringify({
  version: 3,
  file: "parent.js",
  sources: ["../parent.ts"],
  sourcesContent: [PRETTY_FUNCTION],
  mappings: "AAAA;AACA",
});

/** The same map with its version key last, so the first `{` before `"version"` is inside `sourcesContent`. */
const SOURCE_MAP_VERSION_LAST = JSON.stringify({
  file: "parent.js",
  sources: ["../parent.ts"],
  sourcesContent: [`{${PRETTY_FUNCTION}`],
  mappings: "AAAA;AACA",
  version: 3,
});

const SOURCE_MAP_ESCAPED_VERSION = `{"\\u0076ersion":3,"file":"parent.js","sources":["../parent.ts"],"sourcesContent":[${JSON.stringify(PRETTY_FUNCTION)}],"mappings":"AAAA"}`;

const prettySvg = (fixtures: Fixtures): string => fixtures.toolbarSvg.replace(/></g, ">\n  <");

const nested = (open: string, close: string, depth: number): string =>
  `var a=${open.repeat(depth)}1${close.repeat(depth)};`;

/** 50 MB of one-line readable functions: the parser cannot hand an AST that large back to JavaScript. */
const fiftyMegabytes = (): string => {
  const block = `${ONE_LINE_FUNCTION} `;
  return block.repeat(Math.ceil((50 * 1024 * 1024) / block.length));
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

export const RULES: readonly Rule[] = [
  {
    id: CANNOT_CHECK,
    inspects: "contents",
    decides:
      "the check cannot decode, parse or minify the file, a rule throws on it, the child process crashes or times out on it, or it is an empty script or stylesheet",
    check: (read) => ("failure" in read ? read.failure : undefined),
    failingArchives: [
      {
        name: "a script the parser rejects",
        changes: () => ({ "experiment/broken.js": "function ({" }),
        path: "experiment/broken.js",
      },
      {
        name: "a script the parser accepts and the minifier rejects",
        changes: () => ({ "experiment/parent.js": `using x=a();${ONE_LINE_FUNCTION.repeat(10)}` }),
        path: "experiment/parent.js",
      },
      {
        name: "a TypeScript annotation in a script",
        changes: () => ({ "experiment/parent.js": "const x: number = 1;console.log(x);" }),
        path: "experiment/parent.js",
      },
      {
        name: "JSX in a script",
        changes: () => ({
          "experiment/parent.js": 'const el=<div className="app">hi</div>;console.log(el);',
        }),
        path: "experiment/parent.js",
      },
      {
        name: "an unterminated block comment",
        changes: () => ({ "experiment/parent.js": "a();/* never closed" }),
        path: "experiment/parent.js",
      },
      {
        name: "a stylesheet the minifier rejects",
        changes: () => ({ "action/index.css": "a{color:red}}}" }),
        path: "action/index.css",
      },
      {
        name: "an at-rule in a style attribute",
        changes: () => ({
          "action/index.html": inPage('<div style="@media screen{color:red}">x</div>'),
        }),
        path: "action/index.html",
      },
      {
        name: "a module export with a sloppy-mode with statement",
        changes: () => ({ "experiment/parent.js": "export const x=1;with(a)b();" }),
        path: "experiment/parent.js",
      },
      {
        name: "a module import with a legacy octal escape",
        changes: () => ({ "experiment/parent.js": 'import"./a.js";var x="\\101";console.log(x);' }),
        path: "experiment/parent.js",
      },
      {
        name: "a module export with an HTML comment",
        changes: () => ({ "experiment/parent.js": "export const x=1;<!-- comment" }),
        path: "experiment/parent.js",
      },
      {
        name: "a JSON object saved as a script",
        changes: () => ({
          "experiment/parent.js": '{"name":"hark","version":"0.1.0","items":[1,2,3]}',
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a JSON array saved as a script, which minifies to nothing",
        changes: () => ({
          "experiment/parent.js": JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i }))),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "an empty object saved as a script",
        changes: () => ({ "experiment/parent.js": "{}" }),
        path: "experiment/parent.js",
      },
      {
        name: "a small array saved as a script",
        changes: () => ({ "experiment/parent.js": "[1,2,3,4,5]" }),
        path: "experiment/parent.js",
      },
      {
        name: "a script of bytes that are not UTF-8",
        changes: () => ({
          "experiment/parent.js": new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81]),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "bytes that are not UTF-8 inside a script string",
        changes: () => ({
          "experiment/parent.js": new Uint8Array([
            ...encode('var a="'),
            0xff,
            0xfe,
            ...encode('";console.log(a);'),
          ]),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "bytes that are not UTF-8 inside a JSON string",
        changes: () => ({
          "experiment/schema.json": new Uint8Array([
            ...encode('{"a":"'),
            0xff,
            0xfe,
            ...encode('"}'),
          ]),
        }),
        path: "experiment/schema.json",
      },
      {
        name: "an empty script",
        changes: () => ({ "experiment/parent.js": new Uint8Array(0) }),
        path: "experiment/parent.js",
      },
      {
        name: "a script of 20 spaces",
        changes: () => ({ "experiment/parent.js": " ".repeat(20) }),
        path: "experiment/parent.js",
      },
      {
        name: "an empty stylesheet",
        changes: () => ({ "action/index.css": new Uint8Array(0) }),
        path: "action/index.css",
      },
      {
        name: "a 50 MB one-line script",
        changes: () => ({ "experiment/huge.js": fiftyMegabytes() }),
        path: "experiment/huge.js",
      },
      {
        name: "an array nested 257 deep, one past the limit",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 257) }),
        path: "experiment/parent.js",
      },
      {
        name: "an array nested 600 deep",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 600) }),
        path: "experiment/parent.js",
      },
      {
        name: "an array nested 2000 deep, which a smaller native stack cannot read",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 2000) }),
        path: "experiment/parent.js",
      },
      {
        name: "eval of a readable function after an array nested 2000 deep",
        changes: () => ({
          "experiment/parent.js": `${nested("[", "]", 2000)}eval(${JSON.stringify(PRETTY_FUNCTION)});`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "an array nested 4500 deep",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 4500) }),
        path: "experiment/parent.js",
      },
      {
        name: "an array nested 5000 deep, which crashes the minifier on some machines",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 5000) }),
        path: "experiment/parent.js",
      },
      {
        name: "parentheses nested 5000 deep",
        changes: () => ({ "experiment/parent.js": nested("(", ")", 5000) }),
        path: "experiment/parent.js",
      },
      {
        name: "an array nested 20000 deep, which crashes the parser on some machines",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 20_000) }),
        path: "experiment/parent.js",
      },
      {
        name: "braces nested 600 deep inside a string, written as escapes, which a rule reads as JSON",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};console.log("${"\\x7b".repeat(600)}1${"\\x7d".repeat(600)}");`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["not-minified"],
      },
      {
        name: "a JSON file nested 600 deep",
        changes: () => ({ "experiment/notes.json": `${"[".repeat(600)}1${"]".repeat(600)}` }),
        path: "experiment/notes.json",
      },
      {
        name: "a stylesheet nested 600 deep",
        changes: () => ({ "action/index.css": `${"a{".repeat(600)}color:red${"}".repeat(600)}` }),
        path: "action/index.css",
      },
      {
        name: "a source map after a NUL byte on the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\u0000${SOURCE_MAP}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map named like a script",
        changes: () => ({ "experiment/parent.js": SOURCE_MAP }),
        path: "experiment/parent.js",
      },
      {
        name: "pretty JSON with a // comment and a readable function in a string",
        changes: () => ({
          "experiment/config.json": `{\n  // build notes\n  "snippet": ${JSON.stringify(PRETTY_FUNCTION)}\n}\n`,
        }),
        path: "experiment/config.json",
      },
      {
        name: "a JSON file with a trailing comma",
        changes: () => ({ "manifest.json": '{"manifest_version":3,}' }),
        path: "manifest.json",
      },
      {
        name: "a script the parser accepts and the minifier rejects, then 250 readable functions on one line",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};using x=a;${ONE_LINE_FUNCTION.repeat(250)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "an unminified stylesheet laid out with U+2028, which CSS does not read as a line break",
        changes: () => ({
          "action/index.css":
            "body {\u2028  margin: 0;\u2028}\u2028h1 {\u2028  font-size: 15px;\u2028}\u2028",
        }),
        path: "action/index.css",
      },
      {
        name: "a pretty function in the middle of the large bundle",
        changes: ({ framework }) => {
          const middle = Math.floor(framework.length / 2);
          return {
            "shared/framework.js": `${framework.slice(0, middle)};\n${PRETTY_FUNCTION}${framework.slice(middle)}`,
          };
        },
        path: "shared/framework.js",
      },
      {
        name: "the toolbar icon with its style minified as a stylesheet: media ranges put a bare < in XML",
        changes: (fixtures) => ({ "icons/toolbar.svg": rangeSyntaxIcon(fixtures) }),
        path: "icons/toolbar.svg",
      },
      {
        name: "an ampersand outside an entity in a vector",
        changes: (fixtures) => ({
          "icons/toolbar.svg": fixtures.toolbarSvg.replace(
            'aria-label="Hark"',
            'aria-label="One & Two"',
          ),
        }),
        path: "icons/toolbar.svg",
      },
      {
        name: "a notes file",
        changes: () => ({ "NOTES.md": "# notes\n" }),
        path: "NOTES.md",
      },
      {
        name: "an unminified module with an .mjs suffix",
        changes: (fixtures) => ({ "experiment/api.mjs": fixtures.unminifiedParent }),
        path: "experiment/api.mjs",
      },
      {
        name: "an unminified script with a .cjs suffix",
        changes: (fixtures) => ({ "experiment/api.cjs": fixtures.unminifiedParent }),
        path: "experiment/api.cjs",
      },
      {
        name: "one long readable function in an .mjs file",
        changes: () => ({
          "experiment/api.mjs": `export function readHeaders(entries) { const result = []; for (const entry of entries) { if (entry.name !== undefined) { result.push({ name: entry.name, value: String(entry.value) }); } } return result; } export default readHeaders;`,
        }),
        path: "experiment/api.mjs",
      },
      {
        name: "a font the allowlist does not name",
        changes: () => ({ "fonts/icon.woff2": "wOF2" }),
        path: "fonts/icon.woff2",
      },
      {
        name: "a WebAssembly module saved with a .wasm suffix",
        changes: () => ({ "experiment/engine.wasm": WASM_MODULE }),
        path: "experiment/engine.wasm",
        alsoFails: ["foreign-content"],
      },
      {
        name: "a nested XPI saved with an .xpi suffix",
        changes: () => ({ "vendor/inner.xpi": ZIP_ARCHIVE }),
        path: "vendor/inner.xpi",
        alsoFails: ["foreign-content"],
      },
      {
        name: "a script named like an icon",
        changes: (fixtures) => ({ "icons/16.png": fixtures.unminifiedParent }),
        path: "icons/16.png",
      },
      {
        name: "a source map appended after PNG image data",
        changes: (fixtures) => ({
          "icons/16.png": new Uint8Array([...fixtures.png, ...encode(SOURCE_MAP)]),
        }),
        path: "icons/16.png",
      },
      {
        name: "a source map with its version key last, appended after PNG image data",
        changes: (fixtures) => ({
          "icons/16.png": new Uint8Array([...fixtures.png, ...encode(SOURCE_MAP_VERSION_LAST)]),
        }),
        path: "icons/16.png",
      },
      {
        name: "a source map in a PNG text chunk",
        changes: (fixtures) => ({ "icons/16.png": withTextChunk(fixtures.png, SOURCE_MAP) }),
        path: "icons/16.png",
      },
      {
        name: "a script named as a vector image",
        changes: (fixtures) => ({ "icons/icon.svg": fixtures.minifiedParent }),
        path: "icons/icon.svg",
      },
      {
        name: "a script named as a page",
        changes: (fixtures) => ({ "action/index.html": fixtures.minifiedParent }),
        path: "action/index.html",
      },
    ],
  },
  {
    id: "source-map-file",
    inspects: "path",
    decides: "the path ends in .map, a file that ships the original source",
    check: ({ unit }) =>
      unit.kind === "source-map" ? "a source map ships the original source" : undefined,
    failingArchives: [
      {
        name: "a stray source map next to the parent script",
        changes: () => ({ "experiment/parent.js.map": SOURCE_MAP }),
        path: "experiment/parent.js.map",
        alsoFails: ["source-map-signature"],
      },
      {
        name: "a source map in a nested folder",
        changes: () => ({ "experiment/nested/deep/parent.js.map": SOURCE_MAP }),
        path: "experiment/nested/deep/parent.js.map",
        alsoFails: ["source-map-signature"],
      },
    ],
  },
  {
    id: "source-file",
    inspects: "path",
    decides: "the path ends in a source suffix such as .ts, .tsx or .jsx",
    check: ({ unit }) => (unit.kind === "source" ? "source files must not ship" : undefined),
    failingArchives: [
      {
        name: "a TypeScript file",
        changes: () => ({ "experiment/parent.ts": "export const namespace = 1;\n" }),
        path: "experiment/parent.ts",
      },
      {
        name: "a TSX file",
        changes: () => ({ "src/popup/main.tsx": "export const Popup = () => null;\n" }),
        path: "src/popup/main.tsx",
      },
      {
        name: "a JSX file",
        changes: () => ({ "components/Button.jsx": "export const Button = () => null;\n" }),
        path: "components/Button.jsx",
      },
      {
        name: "a TypeScript file in a nested folder",
        changes: () => ({ "experiment/nested/deep/parent.ts": "export const namespace = 1;\n" }),
        path: "experiment/nested/deep/parent.ts",
      },
    ],
  },
  {
    id: "dev-only-file",
    inspects: "path",
    decides:
      "the path is under a test, fixture or tooling folder, or is a package or tsconfig file",
    check: ({ unit }) =>
      DEV_ONLY_PATH.test(unit.path) ? "a test, fixture or tooling file must not ship" : undefined,
    failingArchives: [
      {
        name: "a minified script under tests/",
        changes: (fixtures) => ({ "tests/helper.js": fixtures.minifiedParent }),
        path: "tests/helper.js",
      },
      {
        name: "a tooling script that extension.js bundled from scripts/",
        changes: (fixtures) => ({ "scripts/xpi-rules.js": fixtures.minifiedParent }),
        path: "scripts/xpi-rules.js",
      },
      {
        name: "package.json",
        changes: () => ({ "package.json": '{"name":"extension"}' }),
        path: "package.json",
      },
      {
        name: "a fixture capture",
        changes: () => ({ "fixtures/capture.json": "{}" }),
        path: "fixtures/capture.json",
      },
    ],
  },
  {
    id: "duplicate-entry",
    inspects: "path",
    decides:
      "the archive holds more than one entry with this path, so what Gecko loads is not what was checked",
    check: ({ unit }) =>
      unit.entries > 1 ? `the archive has ${unit.entries} entries with this path` : undefined,
    failingArchives: [
      {
        name: "a second, unminified copy of the parent script under the same path",
        changes: (fixtures) => ({
          [DUPLICATE_OF("experiment/parent.js")]: fixtures.unminifiedParent,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
    ],
  },
  {
    id: "foreign-content",
    inspects: "contents",
    decides:
      "the first bytes are a container the build never emits: an archive, wasm, an executable, or a PNG outside a .png",
    check: ({ unit }) => {
      const foreign = FOREIGN_BYTES.find(([, signature]) => startsWith(unit.bytes, signature))?.[0];
      if (foreign === undefined || (foreign === "PNG image" && unit.kind === "raster"))
        return undefined;
      return `the bytes are a ${foreign}, which the build never emits here`;
    },
    failingArchives: [
      {
        name: "a stored ZIP of source files named as a page",
        changes: () => ({ "vendor/payload.html": ZIP_ARCHIVE }),
        path: "vendor/payload.html",
        alsoFails: [CANNOT_CHECK],
      },
      {
        name: "a WebAssembly module named as a script",
        changes: () => ({ "vendor/engine.js": WASM_MODULE }),
        path: "vendor/engine.js",
        alsoFails: [CANNOT_CHECK],
      },
      {
        name: "a PNG image named as a script",
        changes: (fixtures) => ({ "experiment/parent.js": fixtures.png }),
        path: "experiment/parent.js",
        alsoFails: [CANNOT_CHECK],
      },
    ],
  },
  {
    id: "source-map-signature",
    inspects: "contents",
    decides:
      "a version 3 source map, found by JSON.parse and recognised by its keys in any order, is the file, a value in it, a JSON string in it, a script string or object literal, or a page or vector text or attribute",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      if (read.facts.form === "script") {
        if (read.facts.script.objects.some(isSourceMap))
          return "an object literal is a version 3 source map";
      }
      for (const [place, text] of jsonPlaces(read.facts)) {
        const value = typeof text === "string" ? jsonIn(text) : text;
        const at = sourceMapIn(value);
        if (at !== undefined) return `${place} holds a version 3 source map at ${at}`;
      }
      return undefined;
    },
    failingArchives: [
      {
        name: "a source map named parent.map.json",
        changes: () => ({ "experiment/parent.map.json": SOURCE_MAP }),
        path: "experiment/parent.map.json",
      },
      {
        name: "a source map whose version key is written with a unicode escape",
        changes: () => ({ "experiment/notes.json": SOURCE_MAP_ESCAPED_VERSION }),
        path: "experiment/notes.json",
      },
      {
        name: "a source map in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "a source map held in a JSON string",
        changes: () => ({ "experiment/notes.json": JSON.stringify({ blob: SOURCE_MAP }) }),
        path: "experiment/notes.json",
      },
      {
        name: "a source map with its version key last in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP_VERSION_LAST}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "a source map with its version key last in a JSON string",
        changes: () => ({
          "experiment/notes.json": JSON.stringify({ blob: SOURCE_MAP_VERSION_LAST }),
        }),
        path: "experiment/notes.json",
      },
      {
        name: "a source map with its version key last in a script string",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${minifyScript(`console.log(${JSON.stringify(SOURCE_MAP_VERSION_LAST)})`)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map with an escaped version key in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP_ESCAPED_VERSION}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "a source map with an escaped version key in a script string",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${minifyScript(`console.log(${JSON.stringify(SOURCE_MAP_ESCAPED_VERSION)})`)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map as an object literal in a script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var m={sourcesContent:[],mappings:"AAAA",sources:["a.ts"],version:3};console.log(m);`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map after prose in a license notice",
        changes: () => ({ "shared/framework.js.LICENSE.txt": `MIT License\n\n${SOURCE_MAP}\n` }),
        path: "shared/framework.js.LICENSE.txt",
      },
    ],
  },
  {
    id: "source-map-reference",
    inspects: "contents",
    decides: "a comment the script parser found names a sourceMappingURL",
    check: (read) => {
      if (!("facts" in read) || read.facts.form !== "script") return undefined;
      const { text, script } = read.facts;
      const reference = script.comments.find((span) =>
        SOURCE_MAP_REFERENCE.test(text.slice(span.start, span.end)),
      );
      return reference === undefined
        ? undefined
        : `line ${lineOf(text, reference.start)} has a sourceMappingURL comment`;
    },
    failingArchives: [
      {
        name: "a sourceMappingURL comment on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n//# sourceMappingURL=parent.js.map\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "an inline data: source map on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "a sourceMappingURL hidden after a division-looking comment opener",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}counter++/2;//# sourceMappingURL=parent.js.map`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "an inline data: source map hidden after a division-looking comment opener",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}counter++/2;/*# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ== */0`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
    ],
  },
  {
    id: "development-build",
    inspects: "contents",
    decides: "the text holds a marker that only a development build keeps",
    check: (read) => {
      const text = textOf(read);
      const marker = DEVELOPMENT_MARKERS.find((candidate) => text?.includes(candidate) === true);
      return marker === undefined
        ? undefined
        : `contains \`${marker}\`, which only a development build keeps`;
    },
    failingArchives: [
      {
        name: "a minified script with an unfolded development branch",
        changes: (fixtures) => ({
          "action/index.js": `${fixtures.minifiedParent};"production"!==process.env.NODE_ENV&&console.log(1);`,
        }),
        path: "action/index.js",
      },
      {
        name: "the React DevTools banner in a minified script",
        changes: (fixtures) => ({
          "shared/commons.js": `${fixtures.minifiedParent};console.info("Download the React DevTools");`,
        }),
        path: "shared/commons.js",
      },
      {
        name: "React's development build named like the bundle",
        changes: (fixtures) => ({ "vendor/react.js": fixtures.reactDevelopment }),
        path: "vendor/react.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "React's development build renamed to a .json file",
        changes: (fixtures) => ({
          "vendor/react-dom-client.production.json": fixtures.reactDevelopment,
        }),
        path: "vendor/react-dom-client.production.json",
        alsoFails: [CANNOT_CHECK],
      },
      {
        name: "a development marker in valid JSON",
        changes: () => ({ "experiment/mode.json": '{"mode":"process.env.NODE_ENV"}' }),
        path: "experiment/mode.json",
      },
      {
        name: "a one-line development helper with a bracket environment lookup",
        changes: () => ({
          "experiment/dev.js": `var jsxDEV=(e,t)=>({type:e,props:t});if(process["env"]["NODE_ENV"]!=="production"){console.log("dev")}`,
        }),
        path: "experiment/dev.js",
      },
      {
        name: "a bracket lookup alone on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};"production"!==process["env"]["NODE_ENV"]&&console.log(1);`,
        }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "comment",
    inspects: "contents",
    decides:
      "a page, vector or script holds a comment no build step writes: every one but the page step's own pointer to <chunk>.LICENSE.txt, on the first line",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      const { facts, unit } = read;
      if (facts.form === "markup") {
        const [first] = facts.markup.comments;
        return first === undefined
          ? undefined
          : `${plural(facts.markup.comments.length, "comment")}; the first is <!--${excerpt(first)}-->`;
      }
      if (facts.form !== "script") return undefined;
      const pointer = KINDS[unit.kind ?? "source"].step?.comment?.(unit.path);
      const stray = facts.script.comments.filter(
        ({ start, end }) =>
          !(
            start === 0 &&
            unit.where === undefined &&
            pointer !== undefined &&
            facts.text.slice(start, end) === pointer &&
            facts.text[end] === "\n"
          ),
      );
      const [first] = stray;
      return first === undefined
        ? undefined
        : `${plural(stray.length, "comment")} the build does not write; the first, at line ${lineOf(facts.text, first.start)}, is ${excerpt(facts.text.slice(first.start, first.end))}`;
    },
    failingArchives: [
      {
        name: "a comment in a vector image",
        changes: (fixtures) => ({
          "icons/toolbar.svg": fixtures.toolbarSvg.replace("<path", "<!-- mark --><path"),
        }),
        path: "icons/toolbar.svg",
      },
      {
        name: "a one byte legal comment in a page script",
        changes: (fixtures) => ({ "shared/payload.js": `/*!a*/${fixtures.minifiedParent}` }),
        path: "shared/payload.js",
      },
      {
        name: "a function in a 28 byte legal comment, as rspack keeps it with extractComments off",
        changes: () => ({
          "shared/main.js": '(()=>{"use strict";console.log(/*! function f(){return 1} */"x")})();',
        }),
        path: "shared/main.js",
      },
      {
        name: "the page pointer naming another chunk's notice",
        changes: (fixtures) => ({
          "shared/framework.js": fixtures.framework.replace(
            "framework.js.LICENSE.txt",
            "vendor.js.LICENSE.txt",
          ),
        }),
        path: "shared/framework.js",
      },
      {
        name: "the page pointer below the first line",
        changes: () => ({
          "shared/payload.js": `console.log(1);\n/*! LICENSE: payload.js.LICENSE.txt */\n`,
        }),
        path: "shared/payload.js",
      },
      {
        name: "an HTML comment holding readable source 30 times",
        changes: () => ({ "action/index.html": inPage(`<!--${PRETTY_FUNCTION.repeat(30)}-->`) }),
        path: "action/index.html",
      },
    ],
  },
  {
    id: "not-minified",
    inspects: "contents",
    decides:
      "running the producer's minifier again on a script or style saves more than its margin, or a vector has layout whitespace between elements",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      const { facts, unit } = read;
      if (facts.form === "markup") {
        return unit.kind === "vector" && facts.markup.layoutBreaks > 0
          ? "the vector has line breaks between elements; the build ships its icons on one line"
          : undefined;
      }
      if (facts.form !== "script" && facts.form !== "style") return undefined;
      const margin = KINDS[unit.kind ?? "source"].step?.margin ?? 0;
      return facts.saved > margin
        ? `the build's minifier removes ${facts.saved} more bytes (${((facts.saved / facts.text.length) * 100).toFixed(1)}%); minified output gives up at most ${margin}`
        : undefined;
    },
    failingArchives: [
      {
        name: "a line comment after the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n// tidy this up later\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a readable function in a comment after an increment and a division",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}counter++/2;/* function readHeaders(entries) { return entries.map((entry) => entry.name); } */0`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "an unminified parent script",
        changes: (fixtures) => ({ "experiment/parent.js": fixtures.unminifiedParent }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a readable function inside a one-line /*! comment on the parent, whose step drops every comment",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! function readHeaders(entries) { return entries.map((entry) => entry.name); } */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a /*! comment of prose over 400 characters on the parent",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"This notice is far longer than a pointer to a license file needs to be. ".repeat(8)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a @license comment that assigns a value on the parent",
        changes: (fixtures) => ({
          "experiment/parent.js": `/** @license token = readHeaders(entries) */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a legal comment of calls and comparisons on the parent",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"readHeaders(entries)===entries.length&&check(entries)===true&&".repeat(5)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "the page build's license pointer on the parent, which the parent step never writes",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! LICENSE: parent.js.LICENSE.txt */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a readable function in a legal comment beside the page pointer, which the page step moves to the notice",
        changes: (fixtures) => ({
          "shared/framework.js": fixtures.framework.replace(
            "*/\n",
            `*/\n/*! @license MIT ${ONE_LINE_FUNCTION} */`,
          ),
        }),
        path: "shared/framework.js",
        alsoFails: ["comment"],
      },
      {
        name: "a page script that kept its legal comment, as rspack writes with extractComments off and comments all",
        changes: () => ({
          "shared/main.js": `console.log(/*! @license MIT\n${PRETTY_FUNCTION}${"Permission is hereby granted, free of charge, to any person obtaining a copy. ".repeat(10)}*/"x");`,
        }),
        path: "shared/main.js",
        alsoFails: ["comment"],
      },
      {
        name: "a React @license comment kept in a page script, which the page step moves to the notice",
        changes: (fixtures) => ({
          "shared/payload.js": `/**\n * @license React v19.3.1\n * react.production.js\n *\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n *\n * This source code is licensed under the MIT license found in the\n * LICENSE file in the root directory of this source tree.\n */\n${fixtures.minifiedParent}`,
        }),
        path: "shared/payload.js",
        alsoFails: ["comment"],
      },
      {
        name: "a vector style with spaces between its rules",
        changes: (fixtures) => ({ "icons/toolbar.svg": fixtures.toolbarSvg.replaceAll("}", "} ") }),
        path: "icons/toolbar.svg",
      },
      {
        name: "a pretty stylesheet",
        changes: () => ({
          "action/index.css": "body {\n  margin: 0;\n}\n\nh1 {\n  font-size: 15px;\n}\n",
        }),
        path: "action/index.css",
      },
      {
        name: "a stylesheet one redundant semicolon away from minified",
        changes: () => ({ "action/index.css": "body{margin:0;}h1{font-size:15px}" }),
        path: "action/index.css",
      },
      {
        name: "a block comment before a stylesheet",
        changes: () => ({ "action/index.css": "/* popup styles */body{margin:0}" }),
        path: "action/index.css",
      },
      {
        name: "a sourceMappingURL comment on a stylesheet",
        changes: () => ({
          "action/index.css": "body{margin:0}\n/*# sourceMappingURL=index.css.map */",
        }),
        path: "action/index.css",
      },
      {
        name: "a pretty vector image",
        changes: (fixtures) => ({ "icons/toolbar.svg": prettySvg(fixtures) }),
        path: "icons/toolbar.svg",
      },
      {
        name: "a pretty function repeated 8 times after the large bundle",
        changes: (fixtures) => ({
          "shared/framework.js": `${fixtures.framework}\n${PRETTY_FUNCTION.repeat(8)}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "a pretty function repeated 8 times after the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n${PRETTY_FUNCTION.repeat(8)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a pretty script written inline in a page",
        changes: () => ({
          "action/index.html": inPage(`<div id="root"></div><script>\n${PRETTY_FUNCTION}</script>`),
        }),
        path: "action/index.html",
      },
      {
        name: "readable source padded to 170-character lines",
        changes: () => ({ "experiment/readable.js": padLines(PRETTY_FUNCTION.repeat(6), 170) }),
        path: "experiment/readable.js",
      },
      {
        name: "readable source written with carriage returns",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(8).replaceAll("\n", "\r"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "readable source written with U+2028 line separators",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(8).replaceAll("\n", "\u2028"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "readable source written with U+2029 paragraph separators",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(4).replaceAll("\n", "\u2029"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "an unclosed inline script through the end of the page",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><script>${PRETTY_FUNCTION.repeat(20)}`,
        }),
        path: "action/index.html",
      },
      {
        name: "an inline script carried in a base64 data: URL",
        changes: () => ({
          "action/index.html": inPage(
            `<script src="data:text/javascript;base64,${Buffer.from(PRETTY_FUNCTION).toString("base64")}"></script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable function in an onclick handler",
        changes: () => ({
          "action/index.html": inPage(`<button onclick="${PRETTY_FUNCTION}">go</button>`),
        }),
        path: "action/index.html",
      },
      {
        name: "a closed inline script with a readable function",
        changes: () => ({ "action/index.html": inPage(`<script>${PRETTY_FUNCTION}</script>`) }),
        path: "action/index.html",
      },
      {
        name: "a legal comment in an inline script, which no build step writes or moves to a notice",
        changes: () => ({
          "action/index.html": inPage("<script>/*! @license MIT, see LICENSE */a();</script>"),
        }),
        path: "action/index.html",
        alsoFails: ["comment"],
      },
      {
        name: "spaced stylesheet rules joined by U+2028",
        changes: () => ({ "action/index.css": "body { margin: 0 }\u2028h1 { font-size: 15px }" }),
        path: "action/index.css",
      },
      {
        name: "stylesheet rules padded to 170-character lines",
        changes: () => ({
          "action/index.css": padLines("body{margin:0}\nh1{font-size:15px}", 170),
        }),
        path: "action/index.css",
      },
      {
        name: "a spaced statement repeated 5000 times on one line",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${"var veryReadableName = 1; ".repeat(5000)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "one readable function on one line appended to the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${ONE_LINE_FUNCTION}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "one readable function on one line appended to the large bundle",
        changes: ({ framework }) => ({
          "shared/framework.js": `${framework};${ONE_LINE_FUNCTION}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "two readable functions on one line appended to the large bundle",
        changes: ({ framework }) => ({
          "shared/framework.js": `${framework};${ONE_LINE_FUNCTION.repeat(2)}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "a readable script under a path that climbs out of the archive",
        changes: () => ({ "../../../../escaped.js": PRETTY_FUNCTION }),
        path: "../../../../escaped.js",
      },
      {
        name: "a readable script under an absolute path",
        changes: () => ({ "/absolute.js": PRETTY_FUNCTION }),
        path: "/absolute.js",
      },
      {
        name: "a readable function in a javascript: URL",
        changes: () => ({
          "action/index.html": inPage(`<a href="javascript:${PRETTY_FUNCTION}">go</a>`),
        }),
        path: "action/index.html",
      },
      {
        name: "a percent-encoded readable function in a javascript: URL with a tab in the scheme",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="java&#9;script:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a javascript: URL with a line feed and a carriage return in the scheme",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="jav&#10;asc&#13;ript:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a javascript: URL spelled with &Tab; and &NewLine;, holding &apos; quotes",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="java&Tab;scr&NewLine;ipt:${encodeURIComponent(PRETTY_FUNCTION).replaceAll("'", "&apos;")}&apos;&apos;">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a mixed-case javascript: URL with an encoded tab and line feed",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#x09;JaVaScRiPt&#x0a;:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a multi-line javascript: URL with > inside it",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="javascript:\nif (1 > 0) {\n${PRETTY_FUNCTION.repeat(10)}\n}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a javascript: URL spelled with a zero-padded character reference",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#00000106;avascript:${encodeURIComponent(PRETTY_FUNCTION)}">a</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a javascript: URL spelled with a character reference that has no semicolon",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#106avascript:${encodeURIComponent(PRETTY_FUNCTION)}">b</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable script in an iframe srcdoc",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;script&gt;${PRETTY_FUNCTION}&lt;/script&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable handler in an iframe srcdoc whose markup is entity-encoded twice",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;img onerror=&quot;${PRETTY_FUNCTION.replaceAll("\n", "&amp;#10;")}&quot;&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable script in an iframe srcdoc inside an iframe srcdoc",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;iframe srcdoc=&quot;&amp;lt;script&amp;gt;${PRETTY_FUNCTION.replaceAll('"', "&quot;")}&amp;lt;/script&amp;gt;&quot;&gt;&lt;/iframe&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a srcdoc with a line break and a raw <script> inside the attribute",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="\n<script>\n${PRETTY_FUNCTION.repeat(10)}</script>"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "an inline script with </script_len before readable source",
        changes: () => ({
          "action/index.html": inPage(
            `<script>1</script_len/g;\n${PRETTY_FUNCTION.repeat(20)}</script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable script in a percent-encoded data: URL",
        changes: () => ({
          "action/index.html": inPage(
            `<script src="data:text/javascript,${encodeURIComponent(PRETTY_FUNCTION)}"></script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a pretty stylesheet in a data: URL on a link",
        changes: () => ({
          "action/index.html": inPage(
            `<link rel="stylesheet" href="data:text/css,${encodeURIComponent("body {\n  margin: 0;\n}\n")}">`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a spaced declaration list in a style attribute",
        changes: () => ({
          "action/index.html": inPage(
            `<p style="margin : 0px ;   padding : 0px ;   color : red ;   background : blue ;   border : 1px solid black ;">x</p>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable function in a script of type text/plain",
        changes: () => ({
          "action/index.html": inPage(`<script type="text/plain">${PRETTY_FUNCTION}</script>`),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable script inside a vector image",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<script>${ONE_LINE_FUNCTION}</script></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
    ],
  },
];

/** A change key that adds a second archive entry under `path` instead of replacing the first. */
export const DUPLICATE_OF = (path: string): string => `${path}\u0000duplicate`;

/** The PNG with a tEXt chunk before IEND, checksummed so only the chunk type is wrong. */
const withTextChunk = (png: Uint8Array, text: string): Uint8Array => {
  const body = new Uint8Array([...encode("tEXt"), ...encode("Comment\u0000"), ...encode(text)]);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length - 4);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, NodeZlib.crc32(body));
  const iend = png.length - 12;
  return new Uint8Array([...png.subarray(0, iend), ...chunk, ...png.subarray(iend)]);
};

const WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x66, 0x6f, 0x6f, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04,
  0x00, 0x41, 0x01, 0x0b,
]);

const ZIP_ARCHIVE = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8e,
  0x08, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x70, 0x2e, 0x74, 0x73,
]);
