// Reads a script with the parser the build runs. Everything here is a pure function of the text, so a whole file,
// an inline <script> and the text of a string are read alike.
import { parseSync } from "oxc-parser";

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface TextValue {
  readonly span: Span;
  /** The value the runtime sees: escapes decoded, quotes and delimiters removed. */
  readonly value: string;
}

/** An object literal whose keys are all written out, reduced to what each value is. */
export type ObjectShape = Readonly<Record<string, number | string | "array" | "other">>;

export interface ScriptFacts {
  /** Comments the parser found. A `/*` inside a string or a regular expression is data, not a comment. */
  readonly comments: readonly Span[];
  /** Strings and template quasis, in source order. */
  readonly strings: readonly TextValue[];
  readonly objects: readonly ObjectShape[];
  readonly errors: readonly string[];
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Visits every node. Iterative, so a deeply nested file cannot overflow the call stack. */
const walk = (root: unknown, visit: (node: AstNode) => void): void => {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) for (const item of node as unknown[]) pending.push(item);
    else if (isAstNode(node)) {
      visit(node);
      for (const [key, child] of Object.entries(node))
        if (key !== "type" && key !== "start" && key !== "end") pending.push(child);
    }
  }
};

const keyOf = (property: AstNode): string | undefined => {
  if (property.type !== "Property" || property.computed === true) return undefined;
  const key = property.key;
  if (!isAstNode(key)) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
};

const shapeOf = (value: unknown): ObjectShape[string] => {
  if (!isAstNode(value)) return "other";
  if (value.type === "ArrayExpression") return "array";
  return value.type === "Literal" &&
    (typeof value.value === "string" || typeof value.value === "number")
    ? value.value
    : "other";
};

const objectShape = (node: AstNode): ObjectShape | undefined => {
  if (!Array.isArray(node.properties)) return undefined;
  const entries: Array<readonly [string, ObjectShape[string]]> = [];
  for (const property of node.properties as unknown[]) {
    const key = isAstNode(property) ? keyOf(property) : undefined;
    if (key === undefined || !isAstNode(property)) return undefined;
    entries.push([key, shapeOf(property.value)]);
  }
  return Object.fromEntries(entries);
};

const cookedValue = (element: AstNode): string | undefined => {
  const value = element.value;
  if (typeof value !== "object" || value === null) return undefined;
  const cooked = (value as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : undefined;
};

/** Parses a script as the build's parser does and keeps what it saw. A text with errors is not a script. */
export const parseScript = (text: string): ScriptFacts => {
  const parsed = parseSync("packed.js", text, { lang: "js" });
  const strings: TextValue[] = [];
  const objects: ObjectShape[] = [];
  walk(parsed.program, (node) => {
    const span = { start: node.start, end: node.end };
    if (node.type === "TemplateElement") {
      const value = cookedValue(node);
      if (value !== undefined) strings.push({ span, value });
    } else if (node.type === "Literal" && typeof node.value === "string") {
      strings.push({ span, value: node.value });
    } else if (node.type === "ObjectExpression") {
      const shape = objectShape(node);
      if (shape !== undefined) objects.push(shape);
    }
  });
  return {
    comments: parsed.comments.map(({ start, end }) => ({ start, end })),
    strings: strings.toSorted((a, b) => a.span.start - b.span.start),
    objects,
    errors: parsed.errors.map(({ message }) => message),
  };
};

export const lineOf = (text: string, offset: number): number =>
  (text.slice(0, offset).match(/\r\n|[\n\r\u2028\u2029]/g)?.length ?? 0) + 1;
