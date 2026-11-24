import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { FIXTURE_SEED, type FixtureMethod } from "./fixtures.ts";

export const COST_IMAGES_PATH = "/cost/images";
export const COST_HEAVY_PATH = "/cost/heavy";
export const COST_MIXED_PATH = "/cost/mixed";
export const POLL_PATH = "/poll";
export const ID_BIG_PATH = "/id/big";
export const ID_REVAL_PATH = "/id/reval";
export const ID_CACHED_PATH = "/id/cached";
export const ID_REDIRECT_1_PATH = "/id/r1";
export const ID_REDIRECT_2_PATH = "/id/r2";
export const ID_REDIRECT_FINAL_PATH = "/id/rfinal";
export const ID_ENDLESS_PATH = "/id/endless";
export const ID_DOWNLOAD_PATH = "/id/download";
export const ID_DOWNLOAD_PAGE_PATH = "/id/download.html";
export const ID_INDEX_PATH = "/id/index.html";
export const SW_INDEX_PATH = "/sw/index.html";
export const SW_JS_PATH = "/sw/sw.js";
export const SW_PASS_PATH = "/sw/pass";
/** A 204 with no body, and a finite `text/event-stream` body. */
export const ROUTE_NO_CONTENT_PATH = "/route/no-content";
export const ROUTE_EVENTS_PATH = "/route/events";
/** The endless stream repeats this chunk, so any prefix of it is known in advance. */
export const ID_ENDLESS_CHUNK = Buffer.from('{"n":1}\n'.repeat(512), "utf8");
const SW_SYNTH_BODY = `synth-from-sw-${"x".repeat(5000)}`;

export const COST_IMAGES_COUNT = 200;
export const COST_MIXED_COUNT = 2000;
export const ID_BIG_BYTE_LENGTH = 4 * 1024 * 1024;
export const ID_BIG_FIRST_CHUNK_BYTES = 1_572_864;

const CACHE_LONG = "max-age=3600";
const CACHE_SHORT = "max-age=60";
const NO_STORE = "no-store";

// A 70-byte 1x1 transparent PNG.
const SMALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const MIXED_SIZES = [70, 900, 3000, 12000, 40000] as const;

export type StaticRoute = {
  readonly method: FixtureMethod;
  readonly path: string;
  readonly status: 200 | 204 | 302 | 307;
  readonly contentType: string;
  readonly cacheControl: string | null;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly gzip?: boolean;
  readonly wire: Buffer;
  readonly decoded: Buffer;
};

export type CostScenarioSpec = {
  readonly name: "cost-images" | "cost-heavy" | "cost-mixed";
  readonly pagePath: string;
  readonly description: string;
  readonly requests: readonly { readonly method: FixtureMethod; readonly path: string }[];
};

const REVAL_BODY = Buffer.from("r".repeat(20_000), "utf8");
const CACHED_BODY = prng(30_000, "id-cached");
const BIG_BODY = prng(ID_BIG_BYTE_LENGTH, "id-big");
const DOWNLOAD_BODY = prng(65_536, "id-download");

const HEAVY_BLOB_SIZE = 50_000_000;

let cachedRoutes: Map<string, StaticRoute> | null = null;
let cachedHeavyPaths: readonly { readonly method: FixtureMethod; readonly path: string }[] | null =
  null;

export function getExtendedStaticRoutes(): ReadonlyMap<string, StaticRoute> {
  if (cachedRoutes !== null) return cachedRoutes;
  const routes = new Map<string, StaticRoute>();
  const add = (
    method: FixtureMethod,
    path: string,
    body: Buffer,
    contentType: string,
    cacheControl: string | null,
    options: {
      readonly status?: 200 | 204 | 302 | 307;
      readonly gzip?: boolean;
      readonly extraHeaders?: Readonly<Record<string, string>>;
    } = {},
  ): void => {
    const gzip = options.gzip === true;
    const wire = gzip ? NodeZlib.gzipSync(body, { level: 6 }) : body;
    routes.set(`${method} ${path}`, {
      method,
      path,
      status: options.status ?? 200,
      contentType,
      cacheControl,
      ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
      gzip,
      wire,
      decoded: body,
    });
  };

  for (let index = 0; index < COST_IMAGES_COUNT; index += 1) {
    add("GET", `/cost/small/${String(index)}.png`, SMALL_PNG, "image/png", NO_STORE);
  }
  add(
    "GET",
    COST_IMAGES_PATH,
    Buffer.from(costImagesHtml(), "utf8"),
    "text/html; charset=utf-8",
    NO_STORE,
  );

  const heavyRequests: Array<{ method: FixtureMethod; path: string }> = [];
  add(
    "GET",
    "/cost/h/style.css",
    Buffer.from(`/*${hexText(100_000, "h-css")}*/body{margin:0}\n`, "utf8"),
    "text/css; charset=utf-8",
    CACHE_LONG,
  );
  heavyRequests.push({ method: "GET", path: "/cost/h/style.css" });

  for (let index = 0; index < 6; index += 1) {
    const path = `/cost/h/s${String(index)}.js`;
    const body = Buffer.from(
      `/*${hexText(700_000, `h-js-${String(index)}`)}*/window.__s${String(index)}=1;`,
      "utf8",
    );
    add("GET", path, body, "text/javascript; charset=utf-8", CACHE_LONG, { gzip: index < 2 });
    heavyRequests.push({ method: "GET", path });
  }

  for (let index = 0; index < 40; index += 1) {
    const path = `/cost/h/img${String(index)}.svg`;
    const targetBytes = 20_000 + ((index * 37) % 180) * 1000;
    add("GET", path, paddedSvg(targetBytes, `h-img-${String(index)}`), "image/svg+xml", CACHE_LONG);
    heavyRequests.push({ method: "GET", path });
  }

  for (let index = 0; index < 20; index += 1) {
    const path = `/cost/h/api/g${String(index)}.json`;
    const targetBytes = 2000 + ((index * 13) % 48) * 1000;
    add(
      "GET",
      path,
      jsonBody(targetBytes, `h-g-${String(index)}`),
      "application/json",
      index % 2 === 1 ? NO_STORE : CACHE_SHORT,
    );
    heavyRequests.push({ method: "GET", path });
  }

  for (let index = 0; index < 5; index += 1) {
    const path = `/cost/h/api/p${String(index)}.json`;
    add("POST", path, jsonBody(5000, `h-p-${String(index)}`), "application/json", NO_STORE);
    heavyRequests.push({ method: "POST", path });
  }

  add(
    "GET",
    "/cost/h/blob.bin",
    prng(HEAVY_BLOB_SIZE, "h-blob"),
    "application/octet-stream",
    CACHE_LONG,
  );
  heavyRequests.push({ method: "GET", path: "/cost/h/blob.bin" });

  cachedHeavyPaths = heavyRequests;
  add(
    "GET",
    COST_HEAVY_PATH,
    Buffer.from(costHeavyHtml(heavyRequests), "utf8"),
    "text/html; charset=utf-8",
    NO_STORE,
  );

  for (let index = 0; index < COST_MIXED_COUNT; index += 1) {
    const size = MIXED_SIZES[index % MIXED_SIZES.length] ?? 70;
    const path = `/cost/m/${String(index)}`;
    add(
      "GET",
      path,
      prng(size, `m-${String(index)}`),
      "application/octet-stream",
      index % 4 === 0 ? NO_STORE : CACHE_LONG,
    );
  }
  add(
    "GET",
    COST_MIXED_PATH,
    Buffer.from(costMixedHtml(), "utf8"),
    "text/html; charset=utf-8",
    NO_STORE,
  );

  // Identity routes with fixed payloads.
  add("GET", ID_CACHED_PATH, CACHED_BODY, "application/octet-stream", CACHE_LONG);
  add(
    "GET",
    ID_REDIRECT_1_PATH,
    Buffer.from("redirect hop one body", "utf8"),
    "text/plain; charset=utf-8",
    null,
    {
      status: 302,
      extraHeaders: { location: ID_REDIRECT_2_PATH },
    },
  );
  add(
    "GET",
    ID_REDIRECT_2_PATH,
    Buffer.from("hop two", "utf8"),
    "text/plain; charset=utf-8",
    null,
    {
      status: 307,
      extraHeaders: { location: ID_REDIRECT_FINAL_PATH },
    },
  );
  add(
    "GET",
    ID_REDIRECT_FINAL_PATH,
    Buffer.from("final target", "utf8"),
    "text/plain; charset=utf-8",
    NO_STORE,
  );
  add(
    "GET",
    SW_INDEX_PATH,
    Buffer.from(swIndexHtml(), "utf8"),
    "text/html; charset=utf-8",
    NO_STORE,
  );
  add(
    "GET",
    SW_JS_PATH,
    Buffer.from(swScript(), "utf8"),
    "text/javascript; charset=utf-8",
    NO_STORE,
  );
  add(
    "GET",
    SW_PASS_PATH,
    Buffer.from("passed-through-network", "utf8"),
    "text/plain; charset=utf-8",
    CACHE_SHORT,
  );
  add("GET", ID_DOWNLOAD_PATH, DOWNLOAD_BODY, "application/octet-stream", NO_STORE, {
    extraHeaders: { "content-disposition": 'attachment; filename="fixture-download.bin"' },
  });
  add(
    "GET",
    ID_DOWNLOAD_PAGE_PATH,
    Buffer.from(
      `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>download</title></head><body><a id="download-link" href="${ID_DOWNLOAD_PATH}">Download</a></body></html>`,
      "utf8",
    ),
    "text/html; charset=utf-8",
    NO_STORE,
  );

  add("GET", ROUTE_NO_CONTENT_PATH, Buffer.alloc(0), "text/plain; charset=utf-8", NO_STORE, {
    status: 204,
  });
  add(
    "GET",
    ROUTE_EVENTS_PATH,
    Buffer.from("event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\n", "utf8"),
    "text/event-stream",
    NO_STORE,
  );

  cachedRoutes = routes;
  return routes;
}

export function getCostScenarios(): readonly CostScenarioSpec[] {
  getExtendedStaticRoutes();
  const images = Array.from({ length: COST_IMAGES_COUNT }, (_, index) => ({
    method: "GET" as const,
    path: `/cost/small/${String(index)}.png`,
  }));
  const mixed = Array.from({ length: COST_MIXED_COUNT }, (_, index) => ({
    method: "GET" as const,
    path: `/cost/m/${String(index)}`,
  }));
  return [
    {
      name: "cost-images",
      pagePath: COST_IMAGES_PATH,
      description: "200 no-store 70-byte images",
      requests: [{ method: "GET", path: COST_IMAGES_PATH }, ...images],
    },
    {
      name: "cost-heavy",
      pagePath: COST_HEAVY_PATH,
      description: "heavy page with CSS, 6 scripts, 40 images, 25 API calls and a 50 MB blob",
      requests: [{ method: "GET", path: COST_HEAVY_PATH }, ...(cachedHeavyPaths ?? [])],
    },
    {
      name: "cost-mixed",
      pagePath: COST_MIXED_PATH,
      description: "2000 mixed requests (3 of 4 cacheable, 70 B to 40 KB)",
      requests: [{ method: "GET", path: COST_MIXED_PATH }, ...mixed],
    },
  ];
}

export function getRevalBody(): Buffer {
  return REVAL_BODY;
}

export function getBigBody(): Buffer {
  return BIG_BODY;
}

export function identityIndexHtml(refusedOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>identity</title></head><body><a id="download-link" href="${ID_DOWNLOAD_PATH}">Download</a><script>
window.__identityReady = (async () => {
  const out = {};
  out.poll = [];
  for (let i = 0; i < 2; i += 1) {
    const r = await fetch("${POLL_PATH}");
    out.poll.push({ seq: r.headers.get("x-seq"), text: await r.text() });
  }
  const ac = new AbortController();
  let bigGot = 0;
  try {
    const r = await fetch("${ID_BIG_PATH}", { signal: ac.signal });
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bigGot += value.length;
      if (bigGot >= 1048576) { ac.abort(); break; }
    }
  } catch (error) { out.bigErr = String(error); }
  out.bigGot = bigGot;

  const r1 = await fetch("${ID_REVAL_PATH}");
  out.reval1 = { status: r1.status, seq: r1.headers.get("x-seq"), len: (await r1.arrayBuffer()).byteLength };
  const r2 = await fetch("${ID_REVAL_PATH}");
  out.reval2 = { status: r2.status, seq: r2.headers.get("x-seq"), len: (await r2.arrayBuffer()).byteLength };

  const c1 = await fetch("${ID_CACHED_PATH}");
  out.cached1 = { seq: c1.headers.get("x-seq"), len: (await c1.arrayBuffer()).byteLength };
  const c2 = await fetch("${ID_CACHED_PATH}");
  out.cached2 = { seq: c2.headers.get("x-seq"), len: (await c2.arrayBuffer()).byteLength };

  const redir = await fetch("${ID_REDIRECT_1_PATH}");
  out.redir = { url: redir.url, text: await redir.text() };

  const ac2 = new AbortController();
  let endlessBytes = 0;
  try {
    const r = await fetch("${ID_ENDLESS_PATH}", { signal: ac2.signal });
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      endlessBytes += value.length;
      if (endlessBytes >= 65536) { ac2.abort(); break; }
    }
  } catch (error) { out.endlessErr = String(error); }
  out.endlessBytes = endlessBytes;

  try {
    await fetch("${refusedOrigin}/refused");
    out.refusedOk = true;
  } catch (error) {
    out.refusedError = String(error);
  }

  const iframe = document.createElement("iframe");
  iframe.src = "${SW_INDEX_PATH}";
  document.body.append(iframe);
  out.sw = await new Promise((resolve) => window.addEventListener("message", (event) => resolve(event.data), { once: true }));
  return JSON.stringify(out);
})();
</script></body></html>`;
}

function costImagesHtml(): string {
  const imgs: string[] = [];
  for (let index = 0; index < COST_IMAGES_COUNT; index += 1) {
    const path = `/cost/small/${String(index)}.png`;
    imgs.push(
      `<img src="${path}" width="4" height="4" alt="" onload="__harnessFinish('${path}')" onerror="__harnessFail('${path}')">`,
    );
  }
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>cost-images</title><script>
const finished = new Map(); const failed = new Set(); let settle;
window.__harnessReady = new Promise((resolve) => { settle = resolve; });
function report() {
  if (finished.size + failed.size < ${String(COST_IMAGES_COUNT)}) return;
  settle(JSON.stringify({
    lastResourceFinishedMs: Math.max(0, ...finished.values()),
    finished: [...finished.keys()],
    failed: [...failed],
  }));
}
window.__harnessFinish = (path) => { finished.set(path, performance.now()); report(); };
window.__harnessFail = (path) => { failed.add(path); report(); };
</script></head><body>${imgs.join("")}</body></html>`;
}

function costHeavyHtml(
  requests: readonly { readonly method: FixtureMethod; readonly path: string }[],
): string {
  const total = requests.length;
  const head = [
    `<script>
const finished = new Map(); const failed = new Set(); let settle;
window.__harnessReady = new Promise((resolve) => { settle = resolve; });
function report() {
  if (finished.size + failed.size < ${String(total)}) return;
  settle(JSON.stringify({
    lastResourceFinishedMs: Math.max(0, ...finished.values()),
    finished: [...finished.keys()],
    failed: [...failed],
  }));
}
window.__harnessFinish = (path) => { finished.set(path, performance.now()); report(); };
window.__harnessFail = (path) => { failed.add(path); report(); };
</script>`,
    '<link rel="icon" href="data:,">',
    `<link rel="stylesheet" href="/cost/h/style.css" onload="__harnessFinish('/cost/h/style.css')" onerror="__harnessFail('/cost/h/style.css')">`,
  ];
  for (let index = 0; index < 6; index += 1) {
    const path = `/cost/h/s${String(index)}.js`;
    head.push(
      `<script src="${path}" onload="__harnessFinish('${path}')" onerror="__harnessFail('${path}')"></script>`,
    );
  }
  const body: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const path = `/cost/h/img${String(index)}.svg`;
    body.push(
      `<img src="${path}" width="4" height="4" alt="" onload="__harnessFinish('${path}')" onerror="__harnessFail('${path}')">`,
    );
  }
  const getApis = requests.filter((r) => r.path.startsWith("/cost/h/api/g"));
  const postApis = requests.filter((r) => r.path.startsWith("/cost/h/api/p"));
  body.push(`<script>
const runFetch = (path, init) =>
  fetch(path, init)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
    .then(() => __harnessFinish(path), () => __harnessFail(path));
for (const path of ${JSON.stringify(getApis.map((r) => r.path))}) runFetch(path);
for (const path of ${JSON.stringify(postApis.map((r) => r.path))}) {
  runFetch(path, { method: "POST", body: JSON.stringify({ path }) });
}
runFetch("/cost/h/blob.bin");
</script>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>cost-heavy</title>${head.join("")}</head><body>${body.join("")}</body></html>`;
}

function costMixedHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>cost-mixed</title></head><body><script>
window.__harnessReady = (async () => {
  const finished = [];
  const failed = [];
  const jobs = [];
  for (let i = 0; i < ${String(COST_MIXED_COUNT)}; i += 1) {
    const path = "/cost/m/" + i;
    jobs.push(
      fetch(path)
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
        .then(() => finished.push([path, performance.now()]), () => failed.push(path))
    );
  }
  await Promise.all(jobs);
  return JSON.stringify({
    lastResourceFinishedMs: finished.reduce((max, [, t]) => Math.max(max, t), 0),
    finished: finished.map(([path]) => path),
    failed,
  });
})();
</script></body></html>`;
}

function swIndexHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>sw</title></head><body><script>
(async () => {
  await navigator.serviceWorker.register("${SW_JS_PATH}", { scope: "/sw/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) { location.reload(); return; }
  const synth = await fetch("/sw/synth").then((r) => r.text());
  const pass = await fetch("${SW_PASS_PATH}").then((r) => r.text());
  parent.postMessage({ synth, pass }, "*");
})().catch((error) => parent.postMessage({ error: String(error) }, "*"));
</script></body></html>`;
}

function swScript(): string {
  return `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const pathname = new URL(event.request.url).pathname;
  if (pathname === "/sw/synth") {
    event.respondWith(new Response(${JSON.stringify(SW_SYNTH_BODY)}, { headers: { "content-type": "text/plain" } }));
  } else if (pathname === "${SW_PASS_PATH}") {
    event.respondWith(fetch(event.request));
  }
});`;
}

function prng(byteLength: number, id: string): Buffer {
  const buffer = Buffer.allocUnsafe(byteLength);
  let state = NodeCrypto.createHash("sha256")
    .update(`${FIXTURE_SEED}\0${id}`)
    .digest()
    .readUInt32LE(0);
  let cursor = 0;
  while (cursor + 4 <= buffer.length) {
    state = (state + 0x9e3779b9) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0;
    buffer.writeUInt32LE(value, cursor);
    cursor += 4;
  }
  if (cursor < buffer.length) {
    state = (state + 0x9e3779b9) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0;
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt32LE(value, 0);
    tail.copy(buffer, cursor, 0, buffer.length - cursor);
  }
  return buffer;
}

function hexText(length: number, id: string): string {
  return prng(Math.ceil(length / 2), id)
    .toString("hex")
    .slice(0, length);
}

function jsonBody(targetLength: number, id: string): Buffer {
  const padLen = Math.max(0, targetLength - 32);
  return Buffer.from(JSON.stringify({ id, pad: hexText(padLen, id) }), "utf8");
}

function paddedSvg(targetLength: number, id: string): Buffer {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--';
  const tail = "--></svg>";
  const padLen = Math.max(0, targetLength - head.length - tail.length);
  return Buffer.from(`${head}${hexText(padLen, id)}${tail}`, "utf8");
}
