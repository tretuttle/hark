import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FIXTURES_PAGE_REQUESTS } from "./fixtures.ts";
import { checkEntries, checkHarFile, formatHarCheck, parseHarEntries } from "./har.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";

type Entry = {
  request: { method: string; url: string };
  response: { status: number; content: { size?: number; text?: string; encoding?: string } };
};

let server: FixtureServer;
const received = new Map<string, readonly Entry[]>();

beforeAll(async () => {
  server = await startFixtureServer();
  for (const scenario of Object.values(SCENARIOS))
    received.set(scenario.name, await receive(scenario));
});

afterAll(async () => {
  await server[Symbol.asyncDispose]();
});

describe("har-check", () => {
  it.each(Object.values(SCENARIOS))(
    "passes a HAR of the bytes the $name scenario receives over HTTP",
    (scenario) => {
      const result = checkEntries(parseHarEntries(document(entries(scenario.name))), scenario);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.entryCount).toBe(scenario.responses.length);
    },
  );

  it.each([
    {
      label: "a dropped entry as missing",
      edit: (list: Entry[]) => list.filter((entry) => !entry.request.url.endsWith("/r/js/7")),
      expected: () => [{ kind: "missing", id: "r-js-7", method: "GET", path: "/r/js/7" }],
    },
    {
      label: "a repeated entry as extra",
      edit: (list: Entry[]) => [...list, at(list, 3)],
      expected: () => [{ kind: "extra", method: "GET", url: urlAt(3) }],
    },
    {
      label: "an entry with an empty body as empty",
      edit: (list: Entry[]) =>
        replace(list, 5, (entry) => ({ ...entry.response.content, text: "" })),
      expected: () => [{ kind: "empty", id: idAt(5), url: urlAt(5) }],
    },
    {
      label: "an entry with no body text as empty",
      edit: (list: Entry[]) =>
        replace(list, 6, (entry) => {
          const { text: _text, ...content } = entry.response.content;
          return content;
        }),
      expected: () => [{ kind: "empty", id: idAt(6), url: urlAt(6) }],
    },
    {
      label: "a wrong content.size alone as mismatched",
      edit: (list: Entry[]) =>
        replace(list, 8, (entry) => ({
          ...entry.response.content,
          size: (entry.response.content.size ?? 0) + 1,
        })),
      expected: () => [mismatch(8, ["content.size"])],
    },
    {
      label: "a truncated body as mismatched in length and digest",
      edit: (list: Entry[]) =>
        replace(list, 9, (entry) => ({
          ...entry.response.content,
          text: Buffer.from(entry.response.content.text ?? "", "base64")
            .subarray(1)
            .toString("base64"),
        })),
      expected: () => [mismatch(9, ["decoded length", "sha256"])],
    },
    {
      label: "a flipped byte as mismatched in digest only",
      edit: (list: Entry[]) =>
        replace(list, 10, (entry) => {
          const bytes = Buffer.from(entry.response.content.text ?? "", "base64");
          bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          return { ...entry.response.content, text: bytes.toString("base64") };
        }),
      expected: () => [mismatch(10, ["sha256"])],
    },
  ])("reports $label", ({ edit, expected }) => {
    const result = checkEntries(
      parseHarEntries(document(edit([...entries("page")]))),
      SCENARIOS.page,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toMatchObject(expected());
  });

  it("expects the 206 slice for the range request, not the full body", async () => {
    const full = await fetch(`${server.origin}/fixtures/range`);
    const bytes = Buffer.from(await full.arrayBuffer());
    const list = entries("fixtures").map((entry) =>
      entry.request.url.endsWith("/fixtures/range")
        ? harEntry("GET", "/fixtures/range", 200, bytes)
        : entry,
    );
    const result = checkEntries(parseHarEntries(document(list)), SCENARIOS.fixtures);
    expect(result.problems).toMatchObject([
      {
        kind: "mismatched",
        id: "range@1000-1999",
        differences: [
          { field: "status", expected: "206", observed: "200" },
          { field: "content.size", expected: "1000", observed: "65536" },
          { field: "decoded length", expected: "1000", observed: "65536" },
          { field: "sha256" },
        ],
      },
    ]);
  });

  it("reads a HAR file and groups its problems by kind", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-har-"));
    const file = NodePath.join(directory, "capture.har");
    const list = entries("page").filter((entry) => !entry.request.url.endsWith("/r/json/0"));
    await NodeFSP.writeFile(file, JSON.stringify(document([...list, at(list, 1)])), "utf8");
    const result = await checkHarFile(file, SCENARIOS.page);
    await NodeFSP.rm(directory, { recursive: true, force: true });
    expect(formatHarCheck(result).split("\n").slice(0, 5)).toEqual([
      "har-check failed, scenario page, 201 entries, 201 expected",
      "missing: 1",
      "  r-json-0 GET /r/json/0",
      "extra: 1",
      `  GET ${at(list, 1).request.url}`,
    ]);
  });
});

async function receive(scenario: Scenario): Promise<readonly Entry[]> {
  const list: Entry[] = [];
  for (const response of scenario.responses) {
    const request = FIXTURES_PAGE_REQUESTS.find((item) => item.path === response.path);
    const range = request?.range ?? null;
    const reply = await fetch(`${server.origin}${response.path}`, {
      method: response.method,
      headers: range === null ? {} : { Range: `bytes=${String(range.start)}-${String(range.end)}` },
      ...(response.method === "POST" ? { body: "{}" } : {}),
    });
    list.push(
      harEntry(
        response.method,
        response.path,
        reply.status,
        Buffer.from(await reply.arrayBuffer()),
      ),
    );
  }
  return list;
}

function harEntry(method: string, path: string, status: number, bytes: Buffer): Entry {
  return {
    request: { method, url: `${server.origin}${path}` },
    response: {
      status,
      content: { size: bytes.length, text: bytes.toString("base64"), encoding: "base64" },
    },
  };
}

function entries(name: string): readonly Entry[] {
  const list = received.get(name);
  if (list === undefined) throw new Error(`no entries for ${name}`);
  return list;
}

function at(list: readonly Entry[], index: number): Entry {
  const entry = list[index];
  if (entry === undefined) throw new Error(`no entry ${String(index)}`);
  return entry;
}

function urlAt(index: number): string {
  return at(entries("page"), index).request.url;
}

function idAt(index: number): string {
  return SCENARIOS.page.responses[index]?.id ?? "";
}

function mismatch(index: number, fields: readonly string[]) {
  return {
    kind: "mismatched",
    id: idAt(index),
    differences: fields.map((field) => ({ field })),
  };
}

function replace(
  list: Entry[],
  index: number,
  content: (entry: Entry) => Entry["response"]["content"],
): Entry[] {
  const entry = at(list, index);
  return list.map((item, position) =>
    position === index
      ? { ...entry, response: { ...entry.response, content: content(entry) } }
      : item,
  );
}

function document(list: readonly Entry[]): unknown {
  return { log: { version: "1.2", entries: list } };
}
