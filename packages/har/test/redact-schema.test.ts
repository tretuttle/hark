import Ajv from "ajv";
import draft06 from "ajv/lib/refs/json-schema-draft-06.json" with { type: "json" };
import harSchemas from "har-schema";
import harValidator from "har-validator";
import { describe, expect, it } from "vite-plus/test";

import {
  HAR_REDACTION_PLACES,
  REDACTION_LEVELS,
  type HarDocument,
  type HarRedactionPlace,
  type HarValueKind,
} from "../src/model.ts";
import {
  HAR_MODEL_FIELD_TABLE,
  HAR_PLACE_TABLE,
  redactHar,
  type HarModelFieldRow,
  type HarPlaceRule,
} from "../src/redact.ts";

// Two checks of HAR 1.2 validity: `har-validator` 5.1.5 as published, and the published HAR 1.2
// JSON schema (`har-schema`) compiled with ajv's strict `full` formats.
const ajv = new Ajv({ allErrors: true, format: "full" });
ajv.addMetaSchema(draft06);
ajv.addSchema(harSchemas);
const strict = ajv.getSchema("har.json")!;

async function invalidity(document: unknown): Promise<string | null> {
  const problems: string[] = [];
  try {
    await harValidator.har(document);
  } catch (error) {
    const errors = (error as { errors?: unknown }).errors;
    problems.push(`har-validator: ${JSON.stringify(errors ?? String(error)).slice(0, 300)}`);
  }
  if (!strict(document)) {
    problems.push(`har-schema: ${ajv.errorsText(strict.errors).slice(0, 300)}`);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const frame = (url: string) => ({
  functionName: "load",
  scriptId: "42",
  url,
  lineNumber: 3,
  columnNumber: 7,
  _frameNote: "n",
});

const cacheEntry = {
  expires: "2026-12-01T00:00:00.000Z",
  lastAccess: "2026-11-16T09:00:00.000Z",
  lastFetched: "2026-11-16T09:00:00.000Z",
  eTag: '"abc"',
  hitCount: 3,
  fetchCount: 4,
  comment: "cache note",
  _dataSize: "120",
  _lastModified: "2026-11-15T09:00:00.000Z",
  _device: "disk",
  _note: "c",
};

// A valid HAR 1.2 document with a value in every field the model has.
const FULL = {
  log: {
    version: "1.2",
    creator: { name: "WebInspector", version: "537.36", comment: "c", _note: "c" },
    browser: { name: "Zen", version: "1.0", comment: "b", _note: "b" },
    pages: [
      {
        startedDateTime: "2026-11-16T09:00:00.000Z",
        id: "page_1",
        title: "https://user:secret@app.example/?access_token=t",
        pageTimings: { onContentLoad: 10, onLoad: 20, comment: "t", _note: "t" },
        comment: "p",
        _note: "p",
      },
    ],
    entries: [
      {
        pageref: "page_1",
        startedDateTime: "2026-11-16T09:00:01.000Z",
        time: 12.5,
        request: {
          method: "POST",
          url: "https://user:secret@app.example/api/items?access_token=t&page=2#frag",
          httpVersion: "HTTP/1.1",
          cookies: [
            {
              name: "sid",
              value: "s",
              path: "/",
              domain: "app.example",
              expires: "2026-12-01T00:00:00.000Z",
              httpOnly: true,
              secure: true,
              comment: "k",
              _note: "k",
            },
          ],
          headers: [
            { name: "Authorization", value: "Bearer t", comment: "h", _note: "h" },
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
            { name: "Referer", value: "https://app.example/" },
            { name: "X-Trace", value: "1" },
          ],
          queryString: [
            { name: "access_token", value: "t", comment: "q", _note: "q" },
            { name: "page", value: "2" },
          ],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [
              {
                name: "password",
                value: "p",
                fileName: "a.txt",
                contentType: "text/plain",
                comment: "pp",
                _note: "pp",
              },
            ],
            text: "password=p",
            comment: "pd",
            _note: "pd",
          },
          headersSize: 120,
          bodySize: 10,
          comment: "rq",
          _note: "rq",
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/1.1",
          cookies: [
            {
              name: "sid",
              value: "s2",
              path: "/",
              domain: "app.example",
              expires: null,
              httpOnly: false,
              secure: false,
              comment: "k2",
              _note: "k2",
            },
          ],
          headers: [
            { name: "Set-Cookie", value: "sid=s2", comment: "h2", _note: "h2" },
            { name: "Location", value: "https://app.example/next" },
          ],
          content: {
            size: 2,
            compression: 0,
            mimeType: "application/json",
            text: "e30=",
            encoding: "base64",
            comment: "ct",
            _note: "ct",
          },
          redirectURL: "https://app.example/next",
          headersSize: 80,
          bodySize: 2,
          comment: "rs",
          _transferSize: 82,
          _error: "none",
          _note: "rs",
        },
        cache: {
          beforeRequest: cacheEntry,
          afterRequest: cacheEntry,
          comment: "ca",
          _note: "ca",
        },
        timings: {
          blocked: 1,
          dns: 1,
          connect: 1,
          send: 1,
          wait: 5,
          receive: 2,
          ssl: 1,
          comment: "tm",
          _blocked_queueing: 0.5,
          _blocked_proxy: 0.1,
          _workerStart: 0.2,
          _workerReady: 0.3,
          _workerFetchStart: 0.4,
          _workerRespondWithSettled: 0.6,
          _note: "tm",
        },
        serverIPAddress: "10.0.0.1",
        connection: "443",
        comment: "en",
        _securityState: "secure",
        _priority: "High",
        _initiator: {
          type: "script",
          url: "https://app.example/app.js",
          lineNumber: 1,
          columnNumber: 2,
          requestId: "r1",
          stack: {
            callFrames: [frame("https://app.example/app.js")],
            parent: { callFrames: [frame("https://app.example/lib.js")], description: "await" },
            description: "stack",
          },
          _note: "i",
        },
        _resourceType: "fetch",
        _fromCache: "disk",
        _connectionId: "7",
        _webSocketMessages: [{ type: "send", time: 1, opcode: 1, data: "hi", _note: "w" }],
        _harExport: {
          source: "both",
          bodyState: "present",
          bodyMissing: "evicted",
          bodyIncomplete: false,
          bodyCheck: "sha256",
          lossyText: 0,
          inProgress: false,
          redactedFields: ["request.url"],
          _note: "x",
        },
        _note: "en",
      },
    ],
    comment: "lg",
    _harExport: { redaction: { applied: true }, _note: "lx" },
    _harExportId: "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e",
    _note: "lg",
  },
};

const ROOTS: Readonly<Record<string, (document: typeof FULL) => unknown>> = {
  log: (document) => document.log,
  entry: (document) => document.log.entries[0],
  request: (document) => document.log.entries[0]!.request,
  response: (document) => document.log.entries[0]!.response,
  cache: (document) => document.log.entries[0]!.cache,
  timings: (document) => document.log.entries[0]!.timings,
};

const rows = Object.values(HAR_MODEL_FIELD_TABLE) as HarModelFieldRow[];
const rowByField = new Map<string, HarModelFieldRow>(rows.map((row) => [row.field, row]));

// Every model field FULL holds, found by walking it with the table's own paths.
function fieldsIn(value: unknown, prefix: string, found: Set<string>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const field = rowByField.has(`${prefix}.${key}`) ? `${prefix}.${key}` : `${prefix}.<custom>`;
    const row = rowByField.get(field);
    if (row === undefined) {
      continue;
    }
    found.add(field);
    const childPrefix = row.children ?? field;
    if (Array.isArray(child)) {
      for (const item of child) {
        fieldsIn(item, row.children ?? `${field}[]`, found);
      }
    } else if (!row.kinds.includes("unknown")) {
      fieldsIn(child, childPrefix, found);
    }
  }
}

// The first place in FULL where `field` sits, as its parent object and key.
function slotOf(
  document: typeof FULL,
  field: string,
): { parent: Record<string, unknown>; key: string } {
  const root = Object.keys(ROOTS).find((name) => field.startsWith(`${name}.`))!;
  const steps = field.slice(root.length + 1).split(".");
  let node = ROOTS[root]!(document) as Record<string, unknown>;
  for (const step of steps.slice(0, -1)) {
    const name = step.endsWith("[]") ? step.slice(0, -2) : step;
    const next = node[name];
    node = (Array.isArray(next) ? next[0] : next) as Record<string, unknown>;
  }
  return { parent: node, key: steps.at(-1)!.replace(/\[\]$/u, "") };
}

// A value of the first JSON type the row does not allow.
function wrongValueFor(kinds: readonly HarValueKind[]): unknown {
  const values: ReadonlyArray<readonly [HarValueKind, unknown]> = [
    ["string", "not this type"],
    ["number", 12345],
    ["array", ["not this type"]],
    ["object", { note: "not this type" }],
  ];
  return values.find(([kind]) => !kinds.includes(kind))![1];
}

function tableRemoving(place: HarRedactionPlace): Record<HarRedactionPlace, HarPlaceRule> {
  return Object.fromEntries(
    HAR_REDACTION_PLACES.map((name) => [
      name,
      { ...HAR_PLACE_TABLE[name], standard: name === place ? "removed" : "kept-not-examined" },
    ]),
  ) as Record<HarRedactionPlace, HarPlaceRule>;
}

describe("redaction always writes a valid HAR 1.2 document", () => {
  it("starts from a valid document that holds every field of the model", async () => {
    expect(await invalidity(FULL)).toBeNull();
    const found = new Set<string>();
    for (const [root, get] of Object.entries(ROOTS)) {
      fieldsIn(get(FULL), root, found);
    }
    found.add("log.entries");
    found.add("entry.request");
    found.add("entry.response");
    found.add("entry.cache");
    found.add("entry.timings");
    expect(rows.map((row) => row.field).filter((field) => !found.has(field))).toEqual([]);
  });

  it("keeps log._harExportId, a random id and nothing else, at every level, and counts it in no place", () => {
    const { _harExportId: _id, ...withoutId } = FULL.log;
    for (const level of REDACTION_LEVELS) {
      const { document, report } = redactHar(FULL as unknown as HarDocument, { level });
      expect(document.log._harExportId).toBe(FULL.log._harExportId);
      expect(report).toEqual(
        redactHar({ log: withoutId } as unknown as HarDocument, { level }).report,
      );
    }
  });

  it("removes members of a whole place only with the place itself", () => {
    for (const container of rows.filter((row) => row.wholePlace === true)) {
      const members = rows.filter(
        (row) =>
          row.field.startsWith(`${container.field}.`) ||
          row.field.startsWith(`${container.field}[].`),
      );
      for (const member of members) {
        expect(
          member.places.filter((place) => place !== "wrong-type"),
          member.field,
        ).toEqual(container.places.filter((place) => place !== "wrong-type"));
      }
    }
  });

  it("stays valid when any one place is removed, the form the table gives every removed field", async () => {
    const failures: string[] = [];
    for (const place of HAR_REDACTION_PLACES) {
      const { document } = redactHar(clone(FULL) as unknown as HarDocument, {
        level: "standard",
        placeTable: tableRemoving(place),
      });
      const problem = await invalidity(document);
      if (problem !== null) {
        failures.push(`${place} removed: ${problem}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("stays valid when any field holds a value of the wrong type, at both levels", async () => {
    const failures: string[] = [];
    for (const row of rows.filter((item) => !item.kinds.includes("unknown"))) {
      for (const level of REDACTION_LEVELS) {
        const input = clone(FULL);
        const { parent, key } = slotOf(input, row.field);
        parent[key] = wrongValueFor(row.kinds);
        const { document } = redactHar(input as unknown as HarDocument, { level });
        const problem = await invalidity(document);
        if (problem !== null) {
          failures.push(`${row.field} (${level}): ${problem}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const URLS = [
  "https://app.example/",
  "https://user:secret@app.example/a?access_token=t#f",
  "http://[::1]:8080/x",
  "data:text/plain,hello",
  "mailto:someone@mail.example?subject=x",
  "blob:https://app.example/0d1f",
  "about:blank",
  "wss://socket.example/feed",
  "ftp://files.example/f.txt",
];

// HAR 1.2 requires these in a cache entry, though Firefox writes other names and the model allows that.
const CACHE_ENTRY_REQUIRED = new Set(["lastAccess", "eTag", "hitCount"]);

// Removes optional fields at random, and varies URLs and the number of entries and pages.
function randomDocument(random: () => number): unknown {
  const document = clone(FULL);
  const prune = (value: unknown, prefix: string): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const field = rowByField.get(`${prefix}.${key}`) ?? rowByField.get(`${prefix}.<custom>`);
      if (field === undefined) {
        continue;
      }
      const schemaRequires = prefix.startsWith("cache.") && CACHE_ENTRY_REQUIRED.has(key);
      if (field.whenRemoved === undefined && !schemaRequires && random() < 0.35) {
        delete record[key];
        continue;
      }
      const child = record[key];
      const childPrefix = field.children ?? field.field;
      if (Array.isArray(child)) {
        child.forEach((item) => prune(item, field.children ?? `${field.field}[]`));
      } else if (!field.kinds.includes("unknown")) {
        prune(child, childPrefix);
      }
    }
  };
  const entry = document.log.entries[0]!;
  document.log.entries = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
    const copy = clone(entry);
    copy.request.url = URLS[Math.floor(random() * URLS.length)]!;
    if (random() < 0.3) {
      (copy.cache as Record<string, unknown>).beforeRequest = null;
    }
    if (random() < 0.3) {
      delete (copy.cache as Record<string, unknown>).afterRequest;
    }
    prune(copy, "entry");
    prune(copy.request, "request");
    prune(copy.response, "response");
    prune(copy.cache, "cache");
    prune(copy.timings, "timings");
    return copy;
  });
  if (random() < 0.5) {
    delete (document.log as Record<string, unknown>).pages;
    for (const item of document.log.entries) {
      delete (item as Record<string, unknown>).pageref;
    }
  }
  prune(document.log, "log");
  return document;
}

describe("redaction of arbitrary valid HAR documents", () => {
  it("writes a document that har-validator and the HAR 1.2 schema accept, at both levels", async () => {
    const random = seededRandom(20261116);
    const failures: string[] = [];
    let validInputs = 0;
    const rejections: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const input = randomDocument(random);
      const rejected = await invalidity(input);
      if (rejected !== null) {
        rejections.push(rejected);
        continue;
      }
      validInputs += 1;
      for (const level of REDACTION_LEVELS) {
        const { document } = redactHar(clone(input) as HarDocument, { level });
        const problem = await invalidity(document);
        if (problem !== null) {
          failures.push(`document ${String(index)} (${level}): ${problem}`);
        }
      }
    }
    expect(validInputs, rejections.slice(0, 3).join("\n")).toBeGreaterThan(200);
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
