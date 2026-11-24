import * as NodeCrypto from "node:crypto";

export const FIXTURE_SEED = "hark-zen-harness-v1";
export const WEBSOCKET_PATH = "/fixtures/websocket";
export const SMALL_PER_KIND = 50;
export const SMALL_KINDS = ["css", "js", "image", "json"] as const;
export const BINARY_BYTE_LENGTH = 50_000_000;
export const GZIP_BYTE_LENGTH = 20_000_000;

export type SmallKind = (typeof SMALL_KINDS)[number];
export type FixtureMethod = "GET" | "POST";
export type TransferMode = "identity" | "chunked" | "gzip" | "range";

type BodySpec =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "prng"; readonly byteLength: number; readonly prefix: Uint8Array | null };

export type Fixture = {
  readonly id: string;
  readonly method: FixtureMethod;
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string | null;
  readonly transfer: TransferMode;
  readonly body: BodySpec;
};

const NO_STORE = "no-store";

const VIDEO_PREFIX = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
]);

const SMALL_CONTENT_TYPE: Record<SmallKind, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  image: "image/svg+xml",
  json: "application/json",
};

export const PAGE_PATH = "/";
export const FIXTURES_PAGE_PATH = "/fixtures/";

export function listFixtures(): readonly Fixture[] {
  return [...fixedFixtures(), pageFixture(), fixturesPageFixture(), ...smallFixtures()];
}

export function buildBody(fixture: Fixture): Buffer {
  if (fixture.body.kind === "text") return Buffer.from(fixture.body.text, "utf8");
  const buffer = Buffer.allocUnsafe(fixture.body.byteLength);
  const prefix = fixture.body.prefix;
  if (prefix !== null) {
    if (prefix.byteLength > buffer.length) {
      throw new Error(`prefix longer than body for ${fixture.id}`);
    }
    Buffer.from(prefix).copy(buffer);
  }
  fillPrng(buffer, prefix?.byteLength ?? 0, prngKey(fixture.id));
  return buffer;
}

export function expectedResourceCount(): number {
  return SMALL_KINDS.length * SMALL_PER_KIND;
}

export function smallResourcePaths(): readonly string[] {
  return smallFixtures().map((fixture) => fixture.path);
}

export type PageRequest = {
  readonly fixtureId: string;
  readonly method: FixtureMethod;
  readonly path: string;
  readonly range: { readonly start: number; readonly end: number } | null;
};

// What the fixtures page fetches, in order. The range request asks for a slice, so its
// expected response is that 206 slice, not the full body.
export const FIXTURES_PAGE_REQUESTS: readonly PageRequest[] = [
  { fixtureId: "binary", method: "GET", path: "/fixtures/binary", range: null },
  { fixtureId: "chunked", method: "GET", path: "/fixtures/chunked", range: null },
  { fixtureId: "gzip", method: "GET", path: "/fixtures/gzip", range: null },
  { fixtureId: "video", method: "GET", path: "/fixtures/video", range: null },
  { fixtureId: "range", method: "GET", path: "/fixtures/range", range: { start: 1000, end: 1999 } },
  { fixtureId: "post-json", method: "POST", path: "/fixtures/post", range: null },
  { fixtureId: "no-store", method: "GET", path: "/fixtures/no-store", range: null },
];

function fixedFixtures(): readonly Fixture[] {
  return [
    {
      id: "binary",
      method: "GET",
      path: "/fixtures/binary",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "prng", byteLength: BINARY_BYTE_LENGTH, prefix: null },
    },
    {
      id: "chunked",
      method: "GET",
      path: "/fixtures/chunked",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "chunked",
      body: { kind: "prng", byteLength: BINARY_BYTE_LENGTH, prefix: null },
    },
    {
      id: "gzip",
      method: "GET",
      path: "/fixtures/gzip",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "gzip",
      body: { kind: "prng", byteLength: GZIP_BYTE_LENGTH, prefix: null },
    },
    {
      id: "video",
      method: "GET",
      path: "/fixtures/video",
      contentType: "video/mp4",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "prng", byteLength: 65_536, prefix: VIDEO_PREFIX },
    },
    {
      id: "range",
      method: "GET",
      path: "/fixtures/range",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "range",
      body: { kind: "prng", byteLength: 65_536, prefix: null },
    },
    {
      id: "post-json",
      method: "POST",
      path: "/fixtures/post",
      contentType: "application/json",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: {
        kind: "text",
        text: `${JSON.stringify({ fixture: "post-json", seed: FIXTURE_SEED })}\n`,
      },
    },
    {
      id: "no-store",
      method: "GET",
      path: "/fixtures/no-store",
      contentType: "text/plain; charset=utf-8",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "text", text: `no-store ${FIXTURE_SEED}\n` },
    },
  ];
}

function pageFixture(): Fixture {
  return htmlFixture("page", PAGE_PATH, pageHtml());
}

function fixturesPageFixture(): Fixture {
  return htmlFixture("fixtures-page", FIXTURES_PAGE_PATH, fixturesPageHtml());
}

function htmlFixture(id: string, path: string, html: string): Fixture {
  return {
    id,
    method: "GET",
    path,
    contentType: "text/html; charset=utf-8",
    cacheControl: NO_STORE,
    transfer: "identity",
    body: { kind: "text", text: html },
  };
}

function smallFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const kind of SMALL_KINDS) {
    for (let index = 0; index < SMALL_PER_KIND; index += 1) {
      fixtures.push({
        id: `r-${kind}-${String(index)}`,
        method: "GET",
        path: `/r/${kind}/${String(index)}`,
        contentType: SMALL_CONTENT_TYPE[kind],
        cacheControl: NO_STORE,
        transfer: "identity",
        body: { kind: "text", text: smallText(kind, index) },
      });
    }
  }
  return fixtures;
}

// One sample runs from navigation start (performance.now() is 0 there) to the moment the last of
// the 200 resources finished: stylesheet applied, script executed, image loaded, JSON body read.
// The page reports it, so fetches that end after the load event still count.
function pageHtml(): string {
  const total = expectedResourceCount();
  const head = [
    "<script>",
    "const finished = new Map(); const failed = new Set(); let settle;",
    "window.__harnessReady = new Promise((resolve) => { settle = resolve; });",
    "function report() {",
    `  if (finished.size + failed.size < ${String(total)}) return;`,
    "  settle(JSON.stringify({",
    "    lastResourceFinishedMs: Math.max(0, ...finished.values()),",
    "    finished: [...finished.keys()],",
    "    failed: [...failed],",
    "  }));",
    "}",
    "window.__harnessFinish = (path) => { finished.set(path, performance.now()); report(); };",
    "window.__harnessFail = (path) => { failed.add(path); report(); };",
    "</script>",
    '<link rel="icon" href="data:,">',
  ];
  const body: string[] = [];
  const jsonPaths: string[] = [];
  for (let index = 0; index < SMALL_PER_KIND; index += 1) {
    const name = String(index);
    head.push(`<link rel="stylesheet" href="/r/css/${name}"${handlers(`/r/css/${name}`)}>`);
    head.push(`<script src="/r/js/${name}" onerror="__harnessFail('/r/js/${name}')"></script>`);
    body.push(`<img src="/r/image/${name}" alt=""${handlers(`/r/image/${name}`)}>`);
    jsonPaths.push(`/r/json/${name}`);
  }
  body.push(
    [
      "<script>",
      `for (const path of ${JSON.stringify(jsonPaths)}) {`,
      '  fetch(path, { cache: "no-store" })',
      "    .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.arrayBuffer(); })",
      "    .then(() => __harnessFinish(path), () => __harnessFail(path));",
      "}",
      "</script>",
    ].join(""),
  );
  return `<!doctype html><html><head><meta charset="utf-8">${head.join("")}</head><body>${body.join("")}</body></html>`;
}

function handlers(path: string): string {
  return ` onload="__harnessFinish('${path}')" onerror="__harnessFail('${path}')"`;
}

function fixturesPageHtml(): string {
  const requests = FIXTURES_PAGE_REQUESTS.map((request) => ({
    method: request.method,
    path: request.path,
    headers:
      request.range === null
        ? {}
        : { Range: `bytes=${String(request.range.start)}-${String(request.range.end)}` },
  }));
  const script = [
    "window.__harnessReady = (async () => {",
    `  const requests = ${JSON.stringify(requests)};`,
    "  const results = [];",
    "  for (const request of requests) {",
    '    const init = { method: request.method, headers: request.headers, cache: "no-store" };',
    '    if (request.method === "POST") init.body = "{}";',
    "    const response = await fetch(request.path, init);",
    "    const bytes = await response.arrayBuffer();",
    "    results.push({ path: request.path, status: response.status, byteLength: bytes.byteLength });",
    "  }",
    "  return JSON.stringify({ results });",
    "})();",
  ].join("");
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><script>${script}</script></body></html>`;
}

function smallText(kind: SmallKind, index: number): string {
  const name = String(index);
  if (kind === "css") return `.r-${name}{color:#010101}\n`;
  if (kind === "js") return `__harnessFinish("/r/js/${name}");\n`;
  if (kind === "image") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#${name.padStart(6, "0")}"/></svg>`;
  }
  return `${JSON.stringify({ index, seed: FIXTURE_SEED })}\n`;
}

function prngKey(id: string): string {
  return `${FIXTURE_SEED}\0${id}`;
}

function fillPrng(buffer: Buffer, offset: number, key: string): void {
  let state = NodeCrypto.createHash("sha256").update(key).digest().readUInt32LE(0);
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const step = advance(state);
    state = step.state;
    buffer.writeUInt32LE(step.value, cursor);
    cursor += 4;
  }
  if (cursor < buffer.length) {
    const step = advance(state);
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt32LE(step.value, 0);
    tail.copy(buffer, cursor, 0, buffer.length - cursor);
  }
}

function advance(state: number): { state: number; value: number } {
  const next = (state + 0x9e3779b9) >>> 0;
  let value = next;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return { state: next, value };
}
