import { parseSync } from "vite-plus";

// A fixed list of operator mutations, applied one at a time to the top-level declarations a scope
// names. Each mutant is a single text splice, so applying it never needs the AST again.

export type Mutant = {
  readonly key: string;
  readonly file: string;
  readonly scope: string;
  readonly operator: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
};

export type Scope = {
  readonly file: string;
  readonly names: readonly string[] | "all";
  readonly except?: readonly string[];
};

type AstNode = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
};

type Splice = {
  readonly operator: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
};

const OPERATOR_SWAPS: Readonly<Record<string, readonly string[]>> = {
  "===": ["!=="],
  "!==": ["==="],
  "==": ["!="],
  "!=": ["=="],
  "<": ["<="],
  "<=": ["<"],
  ">": [">="],
  ">=": [">"],
  "+": ["-"],
  "-": ["+"],
  "&&": ["||"],
  "||": ["&&"],
};
const METHOD_SWAPS: Readonly<Record<string, string>> = {
  some: "every",
  every: "some",
  startsWith: "endsWith",
  endsWith: "startsWith",
  delete: "has",
};
// Calls whose result only formats a message; passing their argument through changes nothing.
const FORMATTING_CALLS = new Set(["String"]);
const TYPE_ONLY_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);
const EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const STATEMENT_LISTS = new Set(["BlockStatement", "Program", "StaticBlock"]);

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { start?: unknown }).start === "number";

const nodeAt = (node: AstNode, key: string): AstNode | null => {
  const value = node[key];
  return isNode(value) ? value : null;
};

const nodesAt = (node: AstNode, key: string): AstNode[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const isStringish = (node: AstNode | null): boolean =>
  node !== null &&
  (node.type === "TemplateLiteral" || (node.type === "Literal" && typeof node.value === "string"));

// The splices one node offers, given the source and its parent.
function splicesFor(node: AstNode, parent: AstNode | null, source: string): Splice[] {
  const text = (n: AstNode) => source.slice(n.start, n.end);
  const replace = (operator: string, target: AstNode, replacement: string): Splice => ({
    operator,
    start: target.start,
    end: target.end,
    replacement,
  });
  const splices: Splice[] = [];

  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    const left = nodeAt(node, "left");
    const right = nodeAt(node, "right");
    const operator = String(node.operator);
    if (left !== null && right !== null) {
      const between = source.slice(left.end, right.start);
      const offset = between.indexOf(operator);
      const stringJoin = operator === "+" && (isStringish(left) || isStringish(right));
      if (offset !== -1 && !stringJoin) {
        for (const swapped of OPERATOR_SWAPS[operator] ?? []) {
          splices.push({
            operator: "operator",
            start: left.end + offset,
            end: left.end + offset + operator.length,
            replacement: swapped,
          });
        }
      }
      if (node.type === "LogicalExpression" && operator !== "??") {
        splices.push(replace("operand", node, `(${text(left)})`));
        splices.push(replace("operand", node, `(${text(right)})`));
      }
    }
  }

  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    const test = nodeAt(node, "test");
    if (test !== null && test.type !== "Literal") {
      splices.push(replace("condition", test, "true"), replace("condition", test, "false"));
    }
  }

  if (node.type === "UnaryExpression" && (node.operator === "!" || node.operator === "-")) {
    const argument = nodeAt(node, "argument");
    if (argument !== null) splices.push(replace("unary", node, `(${text(argument)})`));
  }

  if (node.type === "Literal" && typeof node.value === "number") {
    splices.push(replace("number", node, String(node.value + 1)));
    splices.push(replace("number", node, String(node.value - 1)));
  }
  if (node.type === "Literal" && typeof node.value === "boolean") {
    splices.push(replace("boolean", node, String(!node.value)));
  }

  if (node.type === "ArrayExpression" || node.type === "ObjectExpression") {
    const items = nodesAt(node, node.type === "ArrayExpression" ? "elements" : "properties");
    items.forEach((item, index) => {
      const next = items[index + 1];
      const previous = items[index - 1];
      const removal =
        next !== undefined
          ? { start: item.start, end: next.start }
          : previous !== undefined
            ? { start: previous.end, end: item.end }
            : { start: item.start, end: item.end };
      splices.push({
        operator: node.type === "ArrayExpression" ? "element" : "property",
        ...removal,
        replacement: "",
      });
    });
  }

  if (
    (node.type === "ExpressionStatement" || node.type === "ThrowStatement") &&
    parent !== null &&
    STATEMENT_LISTS.has(parent.type)
  ) {
    splices.push(replace("statement", node, ""));
  }

  if (node.type === "CallExpression") {
    const callee = nodeAt(node, "callee");
    const args = nodesAt(node, "arguments");
    const only = args[0];
    const calleeName = callee?.type === "Identifier" ? String(callee.name) : null;
    if (
      args.length === 1 &&
      only !== undefined &&
      only.type !== "SpreadElement" &&
      (calleeName === null || !FORMATTING_CALLS.has(calleeName))
    ) {
      splices.push(replace("call", node, `(${text(only)})`));
    }
    const property = callee?.type === "MemberExpression" ? nodeAt(callee, "property") : null;
    const method = property?.type === "Identifier" ? String(property.name) : null;
    const swapped = method === null ? undefined : METHOD_SWAPS[method];
    if (property !== null && swapped !== undefined)
      splices.push(replace("method", property, swapped));
  }

  if (node.type === "NewExpression") {
    const callee = nodeAt(node, "callee");
    const pattern = nodesAt(node, "arguments")[0];
    if (
      callee?.type === "Identifier" &&
      callee.name === "RegExp" &&
      pattern?.type === "TemplateLiteral"
    ) {
      for (const quasi of nodesAt(pattern, "quasis")) {
        const raw = String((quasi.value as { raw?: unknown } | undefined)?.raw ?? "");
        // A quasi's span includes the backtick or `}` before its text.
        if (raw.length > 0) {
          splices.push({
            operator: "regex",
            start: quasi.start + 1,
            end: quasi.start + 1 + raw.length,
            replacement: "",
          });
        }
      }
    }
  }

  return splices;
}

function walk(
  node: AstNode,
  parent: AstNode | null,
  visit: (node: AstNode, parent: AstNode | null) => void,
): void {
  if (node.type.startsWith("TS")) {
    const inner = EXPRESSION_WRAPPERS.has(node.type) ? nodeAt(node, "expression") : null;
    if (inner !== null) walk(inner, parent, visit);
    return;
  }
  if (node.type === "VariableDeclaration" && node.declare === true) return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (TYPE_ONLY_KEYS.has(key)) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) walk(child, node, visit);
    }
  }
}

// Top-level declarations by name: functions, and the initializers of variables.
function topLevelDeclarations(program: AstNode): { name: string; node: AstNode }[] {
  const declarations: { name: string; node: AstNode }[] = [];
  for (const statement of nodesAt(program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? nodeAt(statement, "declaration") : statement;
    if (declaration === null) continue;
    if (declaration.type === "FunctionDeclaration") {
      const id = nodeAt(declaration, "id");
      if (id !== null) declarations.push({ name: String(id.name), node: declaration });
    }
    if (declaration.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of nodesAt(declaration, "declarations")) {
        const id = nodeAt(declarator, "id");
        const init = nodeAt(declarator, "init");
        if (id?.type === "Identifier" && init !== null) {
          declarations.push({ name: String(id.name), node: init });
        }
      }
    }
  }
  return declarations;
}

const collapse = (text: string): string => {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
};

export function generateMutants(scope: Scope, source: string): Mutant[] {
  const parsed = parseSync(scope.file, source);
  if (parsed.errors.length > 0) {
    throw new Error(
      `cannot parse ${scope.file}: ${parsed.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const program = parsed.program as unknown as AstNode;
  const mutants: Mutant[] = [];
  const seenSources = new Set<string>();
  const keyCounts = new Map<string, number>();
  for (const { name, node } of topLevelDeclarations(program)) {
    const included =
      scope.names === "all" ? !(scope.except ?? []).includes(name) : scope.names.includes(name);
    if (!included) continue;
    walk(node, null, (current, parent) => {
      for (const splice of splicesFor(current, parent, source)) {
        const mutated = `${source.slice(0, splice.start)}${splice.replacement}${source.slice(splice.end)}`;
        if (mutated === source || seenSources.has(mutated)) continue;
        seenSources.add(mutated);
        const base = `${scope.file} ${name} ${splice.operator}: ${collapse(source.slice(splice.start, splice.end))} -> ${collapse(splice.replacement) || "(removed)"}`;
        const count = (keyCounts.get(base) ?? 0) + 1;
        keyCounts.set(base, count);
        mutants.push({
          key: count === 1 ? base : `${base} #${String(count)}`,
          file: scope.file,
          scope: name,
          operator: splice.operator,
          line: source.slice(0, splice.start).split("\n").length,
          start: splice.start,
          end: splice.end,
          replacement: splice.replacement,
        });
      }
    });
  }
  return mutants;
}

export function applyMutant(source: string, mutant: Mutant): string {
  return `${source.slice(0, mutant.start)}${mutant.replacement}${source.slice(mutant.end)}`;
}
