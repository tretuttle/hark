// Reads a page with parse5, which implements the HTML standard's tokenizer and tree builder, and a vector with saxes,
// a conforming XML 1.0 parser, because a browser loads an SVG file as XML. Either way the check sees the elements,
// attributes and decoded references the browser does, and a vector that is not well-formed XML cannot be read.
import { defaultTreeAdapter as tree, parse, type DefaultTreeAdapterTypes, type html } from "parse5";
import { SaxesParser } from "saxes";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export type BodyKind =
  | "script"
  | "style"
  | "vector-style"
  | "style-attribute"
  | "markup"
  | "vector"
  | "data"
  | "raster";

/** A script, style or document that markup carries inline, which a browser runs or renders like a file. */
export interface Body {
  readonly where: string;
  readonly kind: BodyKind;
  readonly bytes: Uint8Array;
}

export interface Markup {
  /** A page has a doctype or an `<html>` tag, a vector an `<svg>` element. */
  readonly hasRoot: boolean;
  readonly comments: readonly string[];
  /** Text nodes and attribute values, where JSON could sit. */
  readonly texts: readonly string[];
  /** Whitespace-only text with a line break inside an element: layout a one-line vector does not have. */
  readonly layoutBreaks: number;
  readonly bodies: readonly Body[];
}

// Attributes whose value the HTML and SVG standards parse as a URL, so a `javascript:` or `data:` value runs.
const URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "codebase",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "src",
  "usemap",
]);

// What a `data:` URL outside a <script src> holds, by its media type. Anything else is not read.
const KIND_BY_MEDIA_TYPE: ReadonlyArray<readonly [RegExp, BodyKind]> = [
  [/^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/, "script"],
  [/^text\/css$/, "style"],
  [/^image\/svg\+xml$/, "vector"],
  [/^text\/html$/, "markup"],
  [/^application\/(?:[\w.+-]+\+)?json$/, "data"],
  [/^image\/png$/, "raster"],
];

const encoder = new TextEncoder();

/** URL percent-decoding as the URL standard defines it: a `%` without two hex digits stays as written. */
const percentDecode = (text: string): Buffer =>
  Buffer.concat(
    text
      .split(/(%[\dA-Fa-f]{2})/)
      .map((part) =>
        /^%[\dA-Fa-f]{2}$/.test(part)
          ? Buffer.from([Number.parseInt(part.slice(1), 16)])
          : Buffer.from(part),
      ),
  );

/** The file a `data:` URL carries, with its bytes decoded the way a fetch of it decodes them. */
const dataUrlBody = (url: URL): { readonly mediaType: string; readonly bytes: Uint8Array } => {
  const href = url.href.slice("data:".length, url.hash === "" ? undefined : -url.hash.length);
  const comma = href.indexOf(",");
  const meta = comma < 0 ? href : href.slice(0, comma);
  const payload = percentDecode(comma < 0 ? "" : href.slice(comma + 1));
  const base64 = /;\s*base64\s*$/i.test(meta);
  return {
    mediaType: (meta.split(";")[0] ?? "").trim().toLowerCase(),
    bytes: base64 ? Buffer.from(payload.toString("latin1"), "base64") : payload,
  };
};

const textOf = (element: Element): string =>
  element.childNodes.map((child) => (tree.isTextNode(child) ? child.value : "")).join("");

/** Parses XML into the tree parse5 builds, so one walk reads pages and vectors. Throws where it is not well-formed. */
const parseXml = (text: string): DefaultTreeAdapterTypes.DocumentFragment => {
  const root = tree.createDocumentFragment();
  const open: ParentNode[] = [root];
  const parent = (): ParentNode => open.at(-1) ?? root;
  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on("opentag", (tag) => {
    const element = tree.createElement(
      tag.local,
      tag.uri as html.NS,
      Object.values(tag.attributes).map(({ local, value }) => ({ name: local, value })),
    );
    tree.appendChild(parent(), element);
    open.push(element);
  });
  parser.on("closetag", () => open.pop());
  parser.on("text", (data) => tree.insertText(parent(), data));
  parser.on("cdata", (data) => tree.insertText(parent(), data));
  parser.on("comment", (data) => tree.appendChild(parent(), tree.createCommentNode(data)));
  parser.write(text).close();
  return root;
};

export const readMarkup = (text: string, form: "page" | "vector"): Markup => {
  const comments: string[] = [];
  const texts: string[] = [];
  const bodies: Body[] = [];
  let layoutBreaks = 0;
  let sawSvg = false;
  const carry = (where: string, kind: BodyKind, body: string | Uint8Array): void => {
    bodies.push({ where, kind, bytes: typeof body === "string" ? encoder.encode(body) : body });
  };

  const readElement = (element: Element): void => {
    const tag = element.tagName;
    if (tag === "svg") sawSvg = true;
    const hasSrc = element.attrs.some(({ name }) => name === "src");
    for (const { name, value } of element.attrs) {
      texts.push(value);
      if (name.startsWith("on")) carry(`<${tag} ${name}>`, "script", value);
      if (name === "style") carry(`<${tag} style>`, "style-attribute", value);
      if (name === "srcdoc") carry(`<${tag} srcdoc>`, "markup", value);
      const url = URL_ATTRIBUTES.has(name) ? URL.parse(value) : null;
      if (url?.protocol === "javascript:") {
        carry(
          `<${tag} ${name}> javascript: URL`,
          "script",
          percentDecode(url.href.slice("javascript:".length)),
        );
      } else if (url?.protocol === "data:") {
        const { mediaType, bytes } = dataUrlBody(url);
        const kind =
          tag === "script" && name === "src"
            ? "script"
            : KIND_BY_MEDIA_TYPE.find(([pattern]) => pattern.test(mediaType))?.[1];
        if (kind !== undefined) carry(`<${tag} ${name}> data: URL`, kind, bytes);
      }
    }
    if (tag === "script" && !hasSrc) carry("<script>", "script", textOf(element));
    if (tag === "style")
      carry("<style>", form === "vector" ? "vector-style" : "style", textOf(element));
  };

  const root = form === "page" ? parse(text, { sourceCodeLocationInfo: true }) : parseXml(text);
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (tree.isCommentNode(node)) comments.push(node.data);
    else if (tree.isTextNode(node)) {
      texts.push(node.value);
      const insideElement = node.parentNode !== null && tree.isElementNode(node.parentNode);
      if (insideElement && /^\s*$/.test(node.value) && /[\n\r]/.test(node.value)) layoutBreaks++;
    } else if (tree.isElementNode(node)) readElement(node);
    if ("childNodes" in node) for (const child of node.childNodes) pending.push(child);
    if ("content" in node) pending.push(node.content);
  }

  const hasRoot =
    form === "vector"
      ? sawSvg
      : "mode" in root &&
        root.childNodes.some(
          (child) =>
            child.nodeName === "#documentType" ||
            (child.nodeName === "html" && child.sourceCodeLocation?.startTag !== undefined),
        );
  return { hasRoot, comments, texts, layoutBreaks, bodies };
};
