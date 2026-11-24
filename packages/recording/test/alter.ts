import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface SourceChange {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

const SRC = NodePath.resolve(import.meta.dirname, "..", "src");

/**
 * Imports a module from a copy of src/ with one text change, so the module's sibling imports resolve to the real
 * code. The change must match exactly once, so a refactor that moves the text fails loudly instead of changing nothing.
 */
export async function importAltered<T>(file: string, change: SourceChange): Promise<T> {
  const source = NodeFS.readFileSync(NodePath.join(SRC, file), "utf8");
  const hits = source.split(change.from).length - 1;
  if (hits !== 1) throw new Error(`${change.id}: matched ${hits} times in ${file}`);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `hark-${change.id}-`));
  NodeFS.cpSync(SRC, dir, { recursive: true });
  const copy = NodePath.join(dir, file);
  NodeFS.writeFileSync(copy, source.replace(change.from, change.to));
  try {
    return (await import(/* @vite-ignore */ NodeURL.pathToFileURL(copy).href)) as T;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
