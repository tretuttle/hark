import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface SourceChange {
  readonly id: string;
  readonly from: string | RegExp;
  readonly to: string;
}

const SRC = NodePath.resolve(import.meta.dirname, "..", "src");
// Inside the package (and gitignored by `.vitest-*`), so a copy resolves the workspace's packages the way src/ does,
// in Vitest and in plain Node, which strips types only outside node_modules.
const COPIES = NodePath.resolve(import.meta.dirname, "..", ".vitest-altered");

/**
 * Imports a module (`entry`, by default the changed file) from a copy of src/ with one deliberate change in `file`, so
 * sibling imports resolve to the copy.
 */
export async function importAltered<T>(
  file: string,
  change: SourceChange,
  entry: string = file,
): Promise<T> {
  const source = NodeFS.readFileSync(NodePath.join(SRC, file), "utf8");
  const hits =
    typeof change.from === "string"
      ? source.split(change.from).length - 1
      : (source.match(new RegExp(change.from.source, `${change.from.flags}g`)) ?? []).length;
  if (hits !== 1) throw new Error(`${change.id}: matched ${String(hits)} times in ${file}`);
  NodeFS.mkdirSync(COPIES, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(COPIES, `${change.id}-`));
  NodeFS.cpSync(SRC, dir, { recursive: true });
  const copy = NodePath.join(dir, file);
  NodeFS.writeFileSync(copy, source.replace(change.from, change.to));
  try {
    return (await import(
      /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(dir, entry)).href
    )) as T;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
