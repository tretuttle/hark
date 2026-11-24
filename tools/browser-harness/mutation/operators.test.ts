import { describe, expect, it } from "vite-plus/test";
import { applyMutant, generateMutants } from "./operators.ts";

const SOURCE = `type Kind = "a" | "b";
declare const BRAND: unique symbol;
export const RULES = [(c: number) => (c > 1 ? null : "low"), (c: number) => (c === 7 ? "seven" : null)];
export function guard(id: number, ok: boolean, path: string): boolean {
  if (!ok && id > 1) throw new Error(\`refusing \${String(id)}\`);
  record(id);
  const boundary = new RegExp(\`(?:^|[\\\\s])\${path}(?:$)\`, "u");
  return Object.freeze({ id, ok: true }) !== null && boundary.test(path) && [1, "x"].some(Boolean);
}
function untouched(a: number) {
  return a + 1;
}
`;

describe("guard mutation operators", () => {
  const mutants = generateMutants(
    { file: "src/x.ts", names: "all", except: ["untouched"] },
    SOURCE,
  );
  const keyed = new Map(mutants.map((mutant) => [mutant.key, applyMutant(SOURCE, mutant)]));

  it("applies each mutant as one splice of the named declarations, and never touches types or other declarations", () => {
    expect(
      [...keyed.keys()].every(
        (key) => key.startsWith("src/x.ts RULES ") || key.startsWith("src/x.ts guard "),
      ),
    ).toBe(true);
    for (const mutated of keyed.values()) {
      expect(mutated).not.toBe(SOURCE);
      expect(mutated).toContain('type Kind = "a" | "b";');
      expect(mutated).toContain("declare const BRAND: unique symbol;");
      expect(mutated).toContain("return a + 1;");
    }
  });

  it.each([
    ["src/x.ts RULES operator: > -> >=", "(c >= 1 ? null"],
    ["src/x.ts RULES number: 1 -> 2", "(c > 2 ? null"],
    ["src/x.ts RULES condition: c === 7 -> false", '(false ? "seven"'],
    [
      'src/x.ts RULES element: (c: number) => (c > 1 ? null : "low"), -> (removed)',
      "RULES = [(c: number) => (c === 7",
    ],
    ["src/x.ts guard operand: !ok && id > 1 -> (id > 1)", "if ((id > 1)) throw"],
    ["src/x.ts guard unary: !ok -> (ok)", "if ((ok) && id > 1)"],
    [
      "src/x.ts guard statement: record(id); -> (removed)",
      "throw new Error(`refusing ${String(id)}`);\n  \n  const boundary",
    ],
    [
      "src/x.ts guard call: Object.freeze({ id, ok: true }) -> ({ id, ok: true })",
      "return ({ id, ok: true }) !== null",
    ],
    ["src/x.ts guard property: , ok: true -> (removed)", "Object.freeze({ id }) !== null"],
    ["src/x.ts guard boolean: true -> false", "{ id, ok: false }"],
    ["src/x.ts guard method: some -> every", '[1, "x"].every(Boolean)'],
    ["src/x.ts guard regex: (?:^|[\\\\s]) -> (removed)", "new RegExp(`${path}(?:$)`"],
    ["src/x.ts guard regex: (?:$) -> (removed)", "new RegExp(`(?:^|[\\\\s])${path}`"],
  ])("%s", (key, expected) => {
    expect(keyed.get(key)).toContain(expected);
  });

  it("does not pass a formatting call's argument through, since the message text stays the same", () => {
    expect([...keyed.keys()].some((key) => key.includes("call: String(id)"))).toBe(false);
  });
});
