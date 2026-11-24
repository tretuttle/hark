import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import {
  getBigBody,
  getExtendedStaticRoutes,
  getRevalBody,
  ID_BIG_FIRST_CHUNK_BYTES,
  ID_BIG_PATH,
  ID_ENDLESS_CHUNK,
  ID_ENDLESS_PATH,
  ID_INDEX_PATH,
  ID_REVAL_PATH,
  identityIndexHtml,
  POLL_PATH,
  type StaticRoute,
} from "./extended-fixtures.ts";
import { buildBody, listFixtures, WEBSOCKET_PATH, type Fixture } from "./fixtures.ts";

const CHUNK_BYTES = 64 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HARNESS_PREFIX = "/__harness/";
const BIG_DELAY_MS = 1500;

export type ServedRequest = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number;
};

export type SequenceTruth = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number;
  readonly expectedLength: number | null;
  readonly wireBytesSent: number;
  readonly wireSha256: string;
  readonly decodedLength: number | null;
  readonly decodedSha256: string | null;
  readonly aborted: boolean;
};

export type FixtureServer = AsyncDisposable & {
  readonly origin: string;
  readonly port: number;
  readonly refusedOrigin: string;
  readonly takeRequests: () => readonly ServedRequest[];
  readonly getRequestLog: () => readonly ServedRequest[];
  readonly getSequenceTruth: (seq: number) => SequenceTruth | undefined;
  readonly getAllSequenceTruth: () => ReadonlyMap<number, SequenceTruth>;
  readonly releasePaused: () => void;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, Fixture>();
  for (const fixture of listFixtures()) {
    routes.set(routeKey(fixture.method, fixture.path), fixture);
  }
  const extendedRoutes = getExtendedStaticRoutes();
  const refusedPort = await allocateClosedPort();
  const refusedOrigin = `http://127.0.0.1:${String(refusedPort)}`;
  let served: ServedRequest[] = [];
  const requestLog: ServedRequest[] = [];
  const seqTruth = new Map<number, SequenceTruth>();
  let nextSeq = 0;
  let pollCount = 0;
  const pausedWaiters = new Set<() => void>();
  const releasePaused = (): void => {
    for (const wake of pausedWaiters) wake();
    pausedWaiters.clear();
  };

  const state: ServerState = {
    routes,
    extendedRoutes,
    refusedOrigin,
    nextSequence: () => {
      nextSeq += 1;
      return nextSeq;
    },
    nextPollCount: () => {
      pollCount += 1;
      return pollCount;
    },
    recordRequest: (entry) => {
      served.push(entry);
      requestLog.push(entry);
    },
    setTruth: (truth) => {
      seqTruth.set(truth.seq, truth);
    },
    getTruth: (seq) => seqTruth.get(seq),
    allTruth: () => seqTruth,
    allRequests: () => requestLog,
    waitForRelease: () =>
      new Promise<void>((resolve) => {
        pausedWaiters.add(resolve);
      }),
    releasePaused,
  };

  const server = NodeHttp.createServer((request, response) => {
    void handle(state, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    acceptWebSocket(request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    port: address.port,
    refusedOrigin,
    takeRequests: () => {
      const taken = served;
      served = [];
      return taken;
    },
    getRequestLog: () => [...requestLog],
    getSequenceTruth: (seq) => seqTruth.get(seq),
    getAllSequenceTruth: () => new Map(seqTruth),
    releasePaused,
    [Symbol.asyncDispose]: () => {
      releasePaused();
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

type ServerState = {
  readonly routes: ReadonlyMap<string, Fixture>;
  readonly extendedRoutes: ReadonlyMap<string, StaticRoute>;
  readonly refusedOrigin: string;
  readonly nextSequence: () => number;
  readonly nextPollCount: () => number;
  readonly recordRequest: (entry: ServedRequest) => void;
  readonly setTruth: (truth: SequenceTruth) => void;
  readonly getTruth: (seq: number) => SequenceTruth | undefined;
  readonly allTruth: () => ReadonlyMap<number, SequenceTruth>;
  readonly allRequests: () => readonly ServedRequest[];
  readonly waitForRelease: () => Promise<void>;
  readonly releasePaused: () => void;
};

async function handle(
  state: ServerState,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const rawUrl = request.url ?? "/";
  const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
  const path = parsedUrl.pathname;

  if (path.startsWith(HARNESS_PREFIX)) {
    await drainRequest(request);
    handleHarnessControl(state, parsedUrl, response);
    return;
  }

  await drainRequest(request);
  const seq = state.nextSequence();
  const meta: RequestMeta = { seq, method, path, url: rawUrl };

  if (method === "GET" && path === POLL_PATH) {
    const count = 1000 + state.nextPollCount();
    const body = Buffer.from(`${JSON.stringify({ count })}\n`, "utf8");
    sendBuffered(
      state,
      response,
      meta,
      200,
      { "content-type": "application/json", "cache-control": "no-store" },
      body,
      body,
    );
    return;
  }

  if (method === "GET" && path === ID_REVAL_PATH) {
    const etag = '"r1"';
    if (request.headers["if-none-match"] === etag) {
      sendBuffered(
        state,
        response,
        meta,
        304,
        { etag, "cache-control": "no-cache" },
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
      return;
    }
    const body = getRevalBody();
    sendBuffered(
      state,
      response,
      meta,
      200,
      { "content-type": "text/plain; charset=utf-8", etag, "cache-control": "no-cache" },
      body,
      body,
    );
    return;
  }

  if (method === "GET" && path === ID_BIG_PATH) {
    const delayParam = parsedUrl.searchParams.get("delayMs");
    const delayMs =
      delayParam !== null && /^\d+$/u.test(delayParam) ? Number(delayParam) : BIG_DELAY_MS;
    await writeBigDownload(state, request, response, meta, delayMs);
    return;
  }

  if (method === "GET" && path === ID_ENDLESS_PATH) {
    writeEndlessStream(
      state,
      request,
      response,
      meta,
      parsedUrl.searchParams.get("rate") === "fast",
    );
    return;
  }

  if (method === "GET" && path === ID_INDEX_PATH) {
    const body = Buffer.from(identityIndexHtml(state.refusedOrigin), "utf8");
    sendBuffered(
      state,
      response,
      meta,
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body,
      body,
    );
    return;
  }

  if (method === "GET" && path === "/retention/page") {
    const body = Buffer.from(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>retention</title></head><body>ok</body></html>',
      "utf8",
    );
    sendBuffered(
      state,
      response,
      meta,
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body,
      body,
    );
    return;
  }

  if (method === "GET" && path === "/retention/blob") {
    const rawBytes = Number(parsedUrl.searchParams.get("bytes") ?? "0");
    if (!Number.isInteger(rawBytes) || rawBytes < 1 || rawBytes > 50_000_000) {
      const err = Buffer.from("invalid bytes\n", "utf8");
      sendBuffered(state, response, meta, 400, { "content-type": "text/plain" }, err, err);
      return;
    }
    const tag = parsedUrl.searchParams.get("tag") ?? "default";
    const body = deterministicBytes(rawBytes, `${String(rawBytes)}:${tag}`);
    if (parsedUrl.searchParams.get("chunked") === "1") {
      await writeChunked(
        state,
        response,
        meta,
        { "content-type": "application/octet-stream", "cache-control": "no-store" },
        body,
      );
      return;
    }
    sendBuffered(
      state,
      response,
      meta,
      200,
      { "content-type": "application/octet-stream", "cache-control": "no-store" },
      body,
      body,
    );
    return;
  }

  const extended = state.extendedRoutes.get(routeKey(method, path));
  if (extended !== undefined) {
    const headers: Record<string, string> = {
      "content-type": extended.contentType,
      ...(extended.cacheControl === null ? {} : { "cache-control": extended.cacheControl }),
      ...extended.extraHeaders,
      ...(extended.gzip === true ? { "content-encoding": "gzip" } : {}),
    };
    sendBuffered(state, response, meta, extended.status, headers, extended.wire, extended.decoded);
    return;
  }

  const fixture = state.routes.get(routeKey(method, path));
  if (fixture === undefined) {
    const otherMethod = method === "GET" ? "POST" : "GET";
    const hasOther =
      state.routes.has(routeKey(otherMethod, path)) ||
      state.extendedRoutes.has(routeKey(otherMethod, path));
    const status = hasOther ? 405 : 404;
    const body = Buffer.from(status === 405 ? "method not allowed\n" : "not found\n", "utf8");
    sendBuffered(
      state,
      response,
      meta,
      status,
      { "content-type": "text/plain; charset=utf-8" },
      body,
      body,
    );
    return;
  }

  const bytes = buildBody(fixture);
  const headers: Record<string, string> = { "content-type": fixture.contentType };
  if (fixture.cacheControl !== null) headers["cache-control"] = fixture.cacheControl;
  if (fixture.transfer === "chunked") {
    await writeChunked(state, response, meta, headers, bytes);
    return;
  }
  if (fixture.transfer === "gzip") {
    const compressed = NodeZlib.gzipSync(bytes);
    sendBuffered(
      state,
      response,
      meta,
      200,
      { ...headers, "content-encoding": "gzip" },
      compressed,
      bytes,
    );
    return;
  }
  if (fixture.transfer === "range") {
    writeRange(state, response, meta, headers, bytes, request.headers.range);
    return;
  }
  const pauseParam = parsedUrl.searchParams.get("pauseAfterBytes");
  if (pauseParam !== null && /^\d+$/u.test(pauseParam)) {
    const pauseAfter = Number(pauseParam);
    if (pauseAfter > 0 && pauseAfter < bytes.length) {
      await writePaused(state, request, response, meta, headers, bytes, pauseAfter);
      return;
    }
  }
  sendBuffered(state, response, meta, 200, headers, bytes, bytes);
}

function handleHarnessControl(
  state: ServerState,
  parsedUrl: URL,
  response: NodeHttp.ServerResponse,
): void {
  if (parsedUrl.pathname === "/__harness/info") {
    sendJsonControl(response, 200, { refusedOrigin: state.refusedOrigin });
    return;
  }
  if (parsedUrl.pathname === "/__harness/truth") {
    const seqParam = parsedUrl.searchParams.get("seq");
    if (seqParam !== null) {
      const seq = Number(seqParam);
      const truth = Number.isInteger(seq) ? state.getTruth(seq) : undefined;
      if (truth === undefined) {
        sendJsonControl(response, 404, { error: "unknown seq" });
        return;
      }
      sendJsonControl(response, 200, truth);
      return;
    }
    sendJsonControl(response, 200, {
      seqTruth: Object.fromEntries(state.allTruth()),
      requests: state.allRequests(),
    });
    return;
  }
  sendJsonControl(response, 404, { error: "unknown control path" });
}

function sendJsonControl(response: NodeHttp.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(body.length),
  });
  response.end(body);
}

type RequestMeta = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly url: string;
};

function writePaused(
  state: ServerState,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  headers: Record<string, string>,
  bytes: Buffer,
  pauseAfter: number,
): Promise<void> {
  const fullHash = sha256(bytes);
  state.setTruth({
    seq: meta.seq,
    method: meta.method,
    path: meta.path,
    url: meta.url,
    status: 200,
    expectedLength: bytes.length,
    wireBytesSent: bytes.length,
    wireSha256: fullHash,
    decodedLength: bytes.length,
    decodedSha256: fullHash,
    aborted: false,
  });
  state.recordRequest({ ...meta, status: 200 });
  response.writeHead(200, {
    ...headers,
    "content-length": String(bytes.length),
    "x-seq": String(meta.seq),
  });
  response.write(bytes.subarray(0, pauseAfter));
  return new Promise((resolve) => {
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      resolve();
    };
    request.once("close", finish);
    response.once("close", finish);
    void state.waitForRelease().then(() => {
      if (closed) return;
      response.end(bytes.subarray(pauseAfter), finish);
    });
  });
}

export function deterministicBytes(length: number, seed: string): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let state = NodeCrypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
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

function sendBuffered(
  state: ServerState,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  status: number,
  headers: Record<string, string>,
  wire: Buffer,
  decoded: Buffer,
): void {
  const finalHeaders: Record<string, string> = {
    ...headers,
    "x-seq": String(meta.seq),
  };
  if (status !== 304 && status !== 204) finalHeaders["content-length"] = String(wire.length);
  const truth: SequenceTruth = {
    seq: meta.seq,
    method: meta.method,
    path: meta.path,
    url: meta.url,
    status,
    expectedLength: wire.length,
    wireBytesSent: wire.length,
    wireSha256: sha256(wire),
    decodedLength: decoded.length,
    decodedSha256: sha256(decoded),
    aborted: false,
  };
  state.setTruth(truth);
  state.recordRequest({ ...meta, status });
  response.writeHead(status, finalHeaders);
  response.end(status === 304 || status === 204 ? undefined : wire);
}

async function writeChunked(
  state: ServerState,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  headers: Record<string, string>,
  bytes: Buffer,
): Promise<void> {
  const hash = sha256(bytes);
  state.setTruth({
    seq: meta.seq,
    method: meta.method,
    path: meta.path,
    url: meta.url,
    status: 200,
    expectedLength: bytes.length,
    wireBytesSent: bytes.length,
    wireSha256: hash,
    decodedLength: bytes.length,
    decodedSha256: hash,
    aborted: false,
  });
  state.recordRequest({ ...meta, status: 200 });
  response.writeHead(200, { ...headers, "x-seq": String(meta.seq) });
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
    if (!response.write(chunk)) await waitForDrain(response);
  }
  response.end();
}

function writeBigDownload(
  state: ServerState,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  delayMs: number,
): Promise<void> {
  const full = getBigBody();
  const fullHash = sha256(full);
  const streamHash = NodeCrypto.createHash("sha256");
  const first = full.subarray(0, ID_BIG_FIRST_CHUNK_BYTES);
  const rest = full.subarray(ID_BIG_FIRST_CHUNK_BYTES);
  let sent = 0;

  const updateTruth = (aborted: boolean, wireSha: string): void => {
    state.setTruth({
      seq: meta.seq,
      method: meta.method,
      path: meta.path,
      url: meta.url,
      status: 200,
      expectedLength: full.length,
      wireBytesSent: sent,
      wireSha256: wireSha,
      decodedLength: aborted ? null : full.length,
      decodedSha256: aborted ? null : fullHash,
      aborted,
    });
  };

  state.recordRequest({ ...meta, status: 200 });
  updateTruth(false, fullHash);
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(full.length),
    etag: '"big1"',
    "accept-ranges": "bytes",
    "cache-control": "max-age=3600",
    "x-seq": String(meta.seq),
  });
  streamHash.update(first);
  sent += first.length;
  response.write(first);

  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      streamHash.update(rest);
      sent += rest.length;
      updateTruth(false, fullHash);
      response.end(rest, () => resolve());
    }, delayMs);

    const onClose = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      updateTruth(true, streamHash.digest("hex"));
      resolve();
    };
    request.once("close", onClose);
    response.once("close", onClose);
  });
}

function writeEndlessStream(
  state: ServerState,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  fast: boolean,
): void {
  const hash = NodeCrypto.createHash("sha256");
  let sent = 0;
  let closed = false;
  const update = (aborted: boolean, digest: string): void => {
    state.setTruth({
      seq: meta.seq,
      method: meta.method,
      path: meta.path,
      url: meta.url,
      status: 200,
      expectedLength: null,
      wireBytesSent: sent,
      wireSha256: digest,
      decodedLength: null,
      decodedSha256: null,
      aborted,
    });
  };
  state.recordRequest({ ...meta, status: 200 });
  update(false, sha256(Buffer.alloc(0)));
  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    "x-seq": String(meta.seq),
  });
  const pushChunk = (): void => {
    if (closed) return;
    hash.update(ID_ENDLESS_CHUNK);
    sent += ID_ENDLESS_CHUNK.length;
    response.write(ID_ENDLESS_CHUNK);
  };
  pushChunk();
  // `rate=fast` writes as fast as the client reads, so a check reaches the recorder's body cap in seconds.
  const pump = (): void => {
    let flowing = true;
    while (flowing) {
      hash.update(ID_ENDLESS_CHUNK);
      sent += ID_ENDLESS_CHUNK.length;
      flowing = response.write(ID_ENDLESS_CHUNK);
    }
    if (!closed) response.once("drain", pump);
  };
  if (fast) pump();
  const interval = fast ? undefined : setInterval(pushChunk, 5);
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    update(true, hash.digest("hex"));
  };
  request.once("close", stop);
  response.once("close", stop);
}

function waitForDrain(response: NodeHttp.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    response.once("drain", () => resolve());
  });
}

function writeRange(
  state: ServerState,
  response: NodeHttp.ServerResponse,
  meta: RequestMeta,
  headers: Record<string, string>,
  bytes: Buffer,
  header: string | undefined,
): void {
  const range = header === undefined ? null : parseByteRange(header, bytes.length);
  if (header !== undefined && range === null) {
    sendBuffered(
      state,
      response,
      meta,
      416,
      { ...headers, "content-range": `bytes */${String(bytes.length)}` },
      Buffer.alloc(0),
      Buffer.alloc(0),
    );
    return;
  }
  if (range === null) {
    sendBuffered(state, response, meta, 200, headers, bytes, bytes);
    return;
  }
  const slice = bytes.subarray(range.start, range.end + 1);
  sendBuffered(
    state,
    response,
    meta,
    206,
    {
      ...headers,
      "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(bytes.length)}`,
    },
    slice,
    slice,
  );
}

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function sha256(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

async function allocateClosedPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no refused port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function drainRequest(request: NodeHttp.IncomingMessage): Promise<void> {
  if (request.readableEnded) return;
  request.resume();
  await new Promise<void>((resolve, reject) => {
    request.on("end", () => resolve());
    request.on("error", reject);
  });
}

function acceptWebSocket(
  request: NodeHttp.IncomingMessage,
  socket: NodeStream.Duplex,
  head: Buffer,
): void {
  socket.on("error", () => undefined);
  const path = request.url?.split("?")[0] ?? "/";
  const key = request.headers["sec-websocket-key"];
  if (path !== WEBSOCKET_PATH || typeof key !== "string" || key.length === 0) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = NodeCrypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer: Buffer<ArrayBufferLike> = Buffer.from(head);
  const consume = (): void => {
    while (true) {
      const parsed = readClientFrame(buffer);
      if (parsed === null) return;
      buffer = parsed.rest;
      if (parsed.opcode === 0x8) {
        socket.end(encodeServerFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (parsed.opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
        socket.write(encodeServerFrame(parsed.opcode, parsed.payload));
      }
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    consume();
  });
  consume();
}

function readClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  if (first === undefined || second === undefined) return null;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(wide);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const dataStart = offset + maskLength;
  const payload = Buffer.from(buffer.subarray(dataStart, dataStart + length));
  if (masked) {
    const mask = buffer.subarray(offset, dataStart);
    for (let index = 0; index < payload.length; index += 1) {
      const maskByte = mask[index % 4];
      const dataByte = payload[index];
      if (maskByte === undefined || dataByte === undefined) break;
      payload[index] = dataByte ^ maskByte;
    }
  }
  return { opcode, payload, rest: buffer.subarray(dataStart + length) };
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.alloc(4);
  if (payload.length >= 126) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, payload]);
}
