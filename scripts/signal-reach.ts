import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseSync } from "vite-plus";

// Finds every function that can reach a real signal (`process.kill`, `<child>.kill()` or a spawned
// kill command), following static imports across the repository. A dynamic import the scan cannot follow
// is assumed to load any module of its own package. A test may reach a signal only from a
// `*.namespace.test.ts` file, and every such file must prove its isolation before it defines a test.

export type Violation = { readonly file: string; readonly line: number; readonly message: string };

const KILL_COMMANDS = new Set(["kill", "pkill", "killall", "taskkill", "taskkill.exe"]);
const TYPE_ONLY_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);
const ISOLATION_PROOF = "requireIsolatedPidNamespace";
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/u;
const NAMESPACE_SUITE = /\.namespace\.test\.[cm]?tsx?$/u;

type AstNode = { readonly type: string; readonly start: number; readonly [key: string]: unknown };

type Reach = {
  readonly refs: Set<string>;
  readonly memberRefs: { readonly namespace: string; readonly name: string }[];
  readonly sinks: { readonly start: number; readonly what: string }[];
  readonly dynamicImports: string[];
  unfollowedImport: number | null;
};

type Binding = { readonly source: string; readonly imported: string } | { readonly external: true };

type Declaration = { readonly name: string; readonly start: number; readonly reach: Reach };

type ModuleInfo = {
  readonly file: string;
  readonly packageRoot: string;
  readonly text: string;
  readonly imports: Map<string, Binding>;
  readonly declarations: Map<string, Declaration>;
  readonly exports: Map<
    string,
    { readonly local: string } | { readonly source: string; readonly imported: string }
  >;
  readonly firstStatement: AstNode | null;
};

function emptyReach(): Reach {
  return { refs: new Set(), memberRefs: [], sinks: [], dynamicImports: [], unfollowedImport: null };
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function collect(node: unknown, reach: Reach): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, reach);
    return;
  }
  if (!isNode(node)) return;
  if (node.type.startsWith("TS") && !TS_VALUE_NODES.has(node.type)) return;
  switch (node.type) {
    case "Identifier":
      reach.refs.add(node.name as string);
      return;
    case "Literal":
      return;
    case "MemberExpression": {
      const object = node.object;
      const property = node.property;
      if (node.computed !== true && isNode(property) && property.type === "Identifier") {
        if (isNode(object) && object.type === "Identifier") {
          if (object.name === "process" && property.name === "kill") {
            reach.sinks.push({ start: node.start, what: "process.kill" });
          }
          reach.memberRefs.push({
            namespace: object.name as string,
            name: property.name as string,
          });
        }
        collect(object, reach);
        return;
      }
      break;
    }
    case "CallExpression": {
      const callee = node.callee;
      const command = spawnedCommand(node);
      if (command !== null && KILL_COMMANDS.has(command)) {
        reach.sinks.push({ start: node.start, what: `the "${command}" command` });
      }
      if (
        isNode(callee) &&
        callee.type === "MemberExpression" &&
        callee.computed !== true &&
        isNode(callee.property) &&
        callee.property.name === "kill"
      ) {
        const object = callee.object;
        const onProcess =
          isNode(object) && object.type === "Identifier" && object.name === "process";
        reach.sinks.push({ start: node.start, what: onProcess ? "process.kill" : ".kill()" });
      }
      break;
    }
    case "ImportExpression": {
      const source = node.source;
      if (isNode(source) && source.type === "Literal" && typeof source.value === "string") {
        reach.dynamicImports.push(source.value);
      } else {
        reach.unfollowedImport ??= node.start;
      }
      break;
    }
    case "Property":
      if (node.computed !== true && node.shorthand !== true) {
        collect(node.value, reach);
        return;
      }
      break;
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed !== true) {
        collect(node.value, reach);
        return;
      }
      break;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || TYPE_ONLY_KEYS.has(key)) continue;
    collect(value, reach);
  }
}

const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

// The program a child_process call starts, when it is written as a string literal.
function spawnedCommand(call: AstNode): string | null {
  const callee = call.callee;
  const name = !isNode(callee)
    ? null
    : callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && isNode(callee.property)
        ? callee.property.name
        : null;
  const first = (call.arguments as unknown[])[0];
  if (typeof name !== "string" || !SPAWNERS.has(name) || !isNode(first)) return null;
  if (first.type !== "Literal" || typeof first.value !== "string") return null;
  const program = first.value.trim().split(/\s+/u)[0] ?? "";
  return NodePath.basename(program);
}

// TypeScript nodes that wrap a value expression; every other `TS*` node is type-only.
const TS_VALUE_NODES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

function bindingNames(pattern: unknown): string[] {
  if (!isNode(pattern)) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name as string];
    case "ObjectPattern":
      return (pattern.properties as unknown[]).flatMap((p) =>
        isNode(p) ? bindingNames(p.type === "RestElement" ? p.argument : p.value) : [],
      );
    case "ArrayPattern":
      return (pattern.elements as unknown[]).flatMap(bindingNames);
    case "RestElement":
      return bindingNames(pattern.argument);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    default:
      return [];
  }
}

function packageRootOf(file: string): string {
  let current = NodePath.dirname(file);
  while (!NodeFS.existsSync(NodePath.join(current, "package.json"))) {
    const parent = NodePath.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function resolveSource(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return NodePath.resolve(NodePath.dirname(fromFile), specifier);
}

const BODY = "<module body>";

function parseModule(file: string): ModuleInfo {
  const text = NodeFS.readFileSync(file, "utf8");
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) {
    throw new Error(`${file}: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  const info: ModuleInfo = {
    file,
    packageRoot: packageRootOf(file),
    text,
    imports: new Map(),
    declarations: new Map(),
    exports: new Map(),
    firstStatement: null,
  };
  const body = emptyReach();
  const declare = (name: string, start: number, node: unknown): void => {
    const reach = emptyReach();
    collect(node, reach);
    info.declarations.set(name, { name, start, reach });
  };
  const declareStatement = (statement: AstNode): string[] => {
    if (statement.declare === true) return [];
    switch (statement.type) {
      case "FunctionDeclaration":
      case "ClassDeclaration": {
        const id = statement.id;
        const name = isNode(id) ? (id.name as string) : "default";
        declare(name, statement.start, statement);
        return [name];
      }
      case "VariableDeclaration":
        return (statement.declarations as AstNode[]).flatMap((declarator) => {
          const names = bindingNames(declarator.id);
          for (const name of names) declare(name, declarator.start, declarator.init);
          return names;
        });
      default:
        return [];
    }
  };
  let firstStatement: AstNode | null = null;
  for (const statement of parsed.program.body as unknown as AstNode[]) {
    if (statement.type !== "ImportDeclaration") firstStatement ??= statement;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      const source = (statement.source as AstNode).value as string;
      const resolved = resolveSource(file, source);
      for (const specifier of statement.specifiers as AstNode[]) {
        if (specifier.importKind === "type") continue;
        const local = (specifier.local as AstNode).name as string;
        const imported =
          specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : ((specifier.imported as AstNode).name as string);
        info.imports.set(
          local,
          resolved === null ? { external: true } : { source: resolved, imported },
        );
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      if (statement.exportKind === "type") continue;
      if (isNode(statement.declaration)) {
        for (const name of declareStatement(statement.declaration)) {
          info.exports.set(name, { local: name });
        }
      }
      const source = isNode(statement.source) ? (statement.source.value as string) : null;
      for (const specifier of statement.specifiers as AstNode[]) {
        if (specifier.exportKind === "type") continue;
        const local = (specifier.local as AstNode).name as string;
        const exported = (specifier.exported as AstNode).name as string;
        const resolved = source === null ? null : resolveSource(file, source);
        info.exports.set(
          exported,
          resolved === null ? { local } : { source: resolved, imported: local },
        );
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      declare("default", statement.start, statement.declaration);
      info.exports.set("default", { local: "default" });
    } else if (declareStatement(statement).length === 0 && !statement.type.startsWith("TS")) {
      collect(statement, body);
    }
  }
  info.declarations.set(BODY, { name: BODY, start: firstStatement?.start ?? 0, reach: body });
  return { ...info, firstStatement };
}

type Taint = { readonly via: string };

function key(file: string, name: string): string {
  return `${file}#${name}`;
}

function analyze(modules: ReadonlyMap<string, ModuleInfo>): Map<string, Taint> {
  const tainted = new Map<string, Taint>();
  const resolveExport = (file: string, name: string, depth = 0): string | null => {
    const module = modules.get(file);
    const entry = module?.exports.get(name);
    if (module === undefined || entry === undefined || depth > 20) return null;
    return "local" in entry
      ? key(file, entry.local)
      : resolveExport(entry.source, entry.imported, depth + 1);
  };
  const anyExportTainted = (file: string): string | null => {
    const module = modules.get(file);
    if (module === undefined) return null;
    for (const name of module.exports.keys()) {
      const target = resolveExport(file, name);
      if (target !== null && tainted.has(target)) return target;
    }
    return null;
  };
  const moduleFile = (file: string): string | null => {
    for (const candidate of [file, `${file}.ts`, `${file}.tsx`]) {
      if (modules.has(candidate)) return candidate;
    }
    return null;
  };
  for (const module of modules.values()) {
    for (const declaration of module.declarations.values()) {
      const sink = declaration.reach.sinks[0];
      if (sink !== undefined) tainted.set(key(module.file, declaration.name), { via: sink.what });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules.values()) {
      for (const declaration of module.declarations.values()) {
        const self = key(module.file, declaration.name);
        if (tainted.has(self)) continue;
        const via = taintedReference(module, declaration.reach);
        if (via !== null) {
          tainted.set(self, { via });
          changed = true;
        }
      }
    }
  }
  return tainted;

  function taintedReference(module: ModuleInfo, reach: Reach): string | null {
    for (const name of reach.refs) {
      if (module.declarations.has(name) && tainted.has(key(module.file, name))) {
        return key(module.file, name);
      }
      const binding = module.imports.get(name);
      if (binding === undefined || "external" in binding) continue;
      const source = moduleFile(binding.source);
      if (source === null) continue;
      const target =
        binding.imported === "*"
          ? anyExportTainted(source)
          : resolveExport(source, binding.imported);
      if (target !== null && tainted.has(target)) return target;
    }
    for (const { namespace, name } of reach.memberRefs) {
      const binding = module.imports.get(namespace);
      if (binding === undefined || "external" in binding || binding.imported !== "*") continue;
      const source = moduleFile(binding.source);
      const target = source === null ? null : resolveExport(source, name);
      if (target !== null && tainted.has(target)) return target;
    }
    if (reach.unfollowedImport !== null) {
      for (const other of modules.values()) {
        if (other.packageRoot !== module.packageRoot || TEST_FILE.test(other.file)) continue;
        for (const name of other.declarations.keys()) {
          if (tainted.has(key(other.file, name))) return key(other.file, name);
        }
      }
    }
    for (const specifier of reach.dynamicImports) {
      const resolved = resolveSource(module.file, specifier);
      const source = resolved === null ? null : moduleFile(resolved);
      const target = source === null ? null : anyExportTainted(source);
      if (target !== null) return target;
    }
    return null;
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function chain(start: string, tainted: ReadonlyMap<string, Taint>, root: string): string {
  const steps: string[] = [];
  let current: string | undefined = start;
  for (let hops = 0; current !== undefined && hops < 30; hops += 1) {
    const via: string | undefined = tainted.get(current)?.via;
    if (via === undefined) break;
    if (!via.includes("#")) {
      steps.push(via);
      break;
    }
    const [file, name] = via.split("#");
    steps.push(`${name ?? ""} (${NodePath.relative(root, file ?? "")})`);
    current = via;
  }
  return steps.join(" -> ");
}

export function findSignalViolations(root: string, files: readonly string[]): Violation[] {
  const modules = new Map<string, ModuleInfo>();
  for (const file of files) modules.set(file, parseModule(file));
  const tainted = analyze(modules);
  const violations: Violation[] = [];
  for (const module of modules.values()) {
    const relative = NodePath.relative(root, module.file);
    if (!TEST_FILE.test(module.file)) continue;
    if (NAMESPACE_SUITE.test(module.file)) {
      if (!provesIsolationFirst(module)) {
        violations.push({
          file: relative,
          line: lineOf(module.text, module.firstStatement?.start ?? 0),
          message: `a namespaced suite must call ${ISOLATION_PROOF}() as its first statement`,
        });
      }
      continue;
    }
    for (const declaration of module.declarations.values()) {
      const self = key(module.file, declaration.name);
      if (!tainted.has(self)) continue;
      const sink = declaration.reach.sinks[0];
      violations.push({
        file: relative,
        line: lineOf(module.text, sink?.start ?? declaration.start),
        message: `reaches a real signal outside a *.namespace.test.ts suite: ${chain(self, tainted, root)}`,
      });
    }
  }
  return violations;
}

function provesIsolationFirst(module: ModuleInfo): boolean {
  const statement = module.firstStatement;
  if (statement?.type !== "ExpressionStatement") return false;
  const call = statement.expression;
  if (!isNode(call) || call.type !== "CallExpression" || !isNode(call.callee)) return false;
  const binding = module.imports.get(ISOLATION_PROOF);
  return (
    call.callee.type === "Identifier" &&
    call.callee.name === ISOLATION_PROOF &&
    binding !== undefined &&
    !("external" in binding) &&
    binding.imported === ISOLATION_PROOF
  );
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          walk(NodePath.join(directory, entry.name));
        }
      } else if (/\.[cm]?tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(NodePath.join(directory, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

if (import.meta.main) {
  const root = NodePath.resolve(process.argv[2] ?? NodePath.join(import.meta.dirname, ".."));
  const violations = findSignalViolations(root, listSourceFiles(root));
  for (const violation of violations) {
    process.stdout.write(`${violation.file}:${String(violation.line)} ${violation.message}\n`);
  }
  process.stdout.write(`${String(violations.length)} signal-reach violation(s)\n`);
  process.exitCode = violations.length === 0 ? 0 : 1;
}
