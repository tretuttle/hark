import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type { ExpectedResponse, Scenario } from "./scenarios.ts";

export type HarEntry = {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number | null;
  readonly contentSize: number | null;
  readonly body: Buffer | null;
};

export type Difference = {
  readonly field: "status" | "content.size" | "decoded length" | "sha256";
  readonly expected: string;
  readonly observed: string;
};

export type HarProblem =
  | {
      readonly kind: "missing";
      readonly id: string;
      readonly method: string;
      readonly path: string;
    }
  | { readonly kind: "extra"; readonly method: string; readonly url: string }
  | { readonly kind: "empty"; readonly id: string; readonly url: string }
  | {
      readonly kind: "mismatched";
      readonly id: string;
      readonly url: string;
      readonly differences: readonly Difference[];
    };

export type HarCheckResult = {
  readonly ok: boolean;
  readonly scenario: string;
  readonly entryCount: number;
  readonly expectedCount: number;
  readonly problems: readonly HarProblem[];
};

export function parseHarEntries(value: unknown): readonly HarEntry[] {
  if (!isRecord(value) || !isRecord(value.log) || !Array.isArray(value.log.entries)) {
    throw new Error("HAR is missing log.entries");
  }
  return value.log.entries.map((entry) => parseEntry(entry));
}

export function checkEntries(entries: readonly HarEntry[], scenario: Scenario): HarCheckResult {
  const problems: HarProblem[] = [];
  const used = new Set<number>();
  for (const item of scenario.responses) {
    const index = entries.findIndex(
      (entry, entryIndex) =>
        !used.has(entryIndex) && entry.method === item.method && entry.path === item.path,
    );
    const entry = entries[index];
    if (entry === undefined) {
      problems.push({ kind: "missing", id: item.id, method: item.method, path: item.path });
      continue;
    }
    used.add(index);
    if (entry.body === null || entry.body.length === 0) {
      problems.push({ kind: "empty", id: item.id, url: entry.url });
      continue;
    }
    const differences = compare(entry, entry.body, item);
    if (differences.length > 0) {
      problems.push({ kind: "mismatched", id: item.id, url: entry.url, differences });
    }
  }
  entries.forEach((entry, index) => {
    if (!used.has(index)) problems.push({ kind: "extra", method: entry.method, url: entry.url });
  });
  return {
    ok: problems.length === 0,
    scenario: scenario.name,
    entryCount: entries.length,
    expectedCount: scenario.responses.length,
    problems,
  };
}

export async function checkHarFile(file: string, scenario: Scenario): Promise<HarCheckResult> {
  const text = await NodeFSP.readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`HAR is not JSON: ${file}`);
  }
  return checkEntries(parseHarEntries(parsed), scenario);
}

export function formatHarCheck(result: HarCheckResult): string {
  const counts = `scenario ${result.scenario}, ${String(result.entryCount)} entries, ${String(result.expectedCount)} expected`;
  if (result.ok) return `har-check passed, ${counts}`;
  const lines = [`har-check failed, ${counts}`];
  for (const kind of ["missing", "extra", "empty", "mismatched"] as const) {
    const matching = result.problems.filter((problem) => problem.kind === kind);
    if (matching.length === 0) continue;
    lines.push(`${kind}: ${String(matching.length)}`);
    for (const problem of matching) lines.push(`  ${describe(problem)}`);
  }
  return lines.join("\n");
}

function compare(entry: HarEntry, body: Buffer, item: ExpectedResponse): Difference[] {
  const differences: Difference[] = [];
  const check = (field: Difference["field"], expected: string, observed: string): void => {
    if (expected !== observed) differences.push({ field, expected, observed });
  };
  check("status", String(item.status), String(entry.status));
  check("content.size", String(item.byteLength), String(entry.contentSize));
  check("decoded length", String(item.byteLength), String(body.length));
  check("sha256", item.sha256, NodeCrypto.createHash("sha256").update(body).digest("hex"));
  return differences;
}

function describe(problem: HarProblem): string {
  if (problem.kind === "missing") return `${problem.id} ${problem.method} ${problem.path}`;
  if (problem.kind === "extra") return `${problem.method} ${problem.url}`;
  if (problem.kind === "empty") return `${problem.id} ${problem.url}`;
  const fields = problem.differences
    .map(
      (difference) =>
        `${difference.field} expected ${difference.expected} observed ${difference.observed}`,
    )
    .join("; ");
  return `${problem.id} ${problem.url}: ${fields}`;
}

function parseEntry(value: unknown): HarEntry {
  if (!isRecord(value) || !isRecord(value.request)) {
    throw new Error("HAR entry is missing a request");
  }
  const method = value.request.method;
  const url = value.request.url;
  if (typeof method !== "string" || method.length === 0) {
    throw new Error("HAR entry is missing a request method");
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("HAR entry is missing a request url");
  }
  const response = isRecord(value.response) ? value.response : {};
  const content = isRecord(response.content) ? response.content : {};
  return {
    method: method.toUpperCase(),
    url,
    path: pathname(url),
    status: typeof response.status === "number" ? response.status : null,
    contentSize: typeof content.size === "number" ? content.size : null,
    body: contentBytes(content),
  };
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function contentBytes(content: Record<string, unknown>): Buffer | null {
  if (typeof content.text !== "string") return null;
  if (content.encoding === "base64") return Buffer.from(content.text, "base64");
  return Buffer.from(content.text, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
