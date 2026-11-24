import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DATA_IMAGE_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FAVICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function prng(length: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i + 4 <= length; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf.writeUInt32LE(x, i);
  }
  const rem = length & 3;
  if (rem > 0) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt32LE(x, 0);
    tail.copy(buf, length - rem, 0, rem);
  }
  return buf;
}

export function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

const sizeOfSmall = (index: number): number => 100 + ((index * 7919) % 20_000);

const BIG = prng(50_000_000, 7);
const MID = prng(800_000, 23);
const TXT = Buffer.from(prng(300_000, 29).toString("hex"), "utf8");
const SMALL = prng(20_100, 31);

export const DEVTOOLS_GROUND_TRUTH = {
  "big.bin": { size: BIG.length, sha256: sha256(BIG) },
  "mid.bin": { size: MID.length, sha256: sha256(MID) },
  "text.txt": { size: TXT.length, sha256: sha256(TXT) },
  "favicon.ico": { size: FAVICON_PNG.length, sha256: sha256(FAVICON_PNG) },
} as const;

export function smallSlice(index: number): Buffer {
  return SMALL.subarray(0, sizeOfSmall(index));
}

export const DEVTOOLS_STACK_FRAMES = [
  "stackFrameFour",
  "stackFrameThree",
  "stackFrameTwo",
  "stackFrameOne",
] as const;

export type DevtoolsServedRequest = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number;
};

export type DevtoolsSequenceTruth = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number;
  readonly decodedLength: number;
  readonly decodedSha256: string;
};

export type DevtoolsFixtureServer = AsyncDisposable & {
  readonly port: number;
  readonly origin: string;
  readonly getRequestLog: () => readonly DevtoolsServedRequest[];
  readonly takeRequests: () => readonly DevtoolsServedRequest[];
  readonly getSequenceTruth: (seq: number) => DevtoolsSequenceTruth | undefined;
  readonly waitForPath: (substring: string) => Promise<void>;
};

function wsAccept(key: string): string {
  return NodeCrypto.createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
}

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

const PAGE_SCRIPT = `
function stackFrameFour(url) { return fetch(url, { cache: "no-store" }).then((r) => r.text()); }
function stackFrameThree(url) { return stackFrameFour(url); }
function stackFrameTwo(url) { return stackFrameThree(url); }
function stackFrameOne(url) { return stackFrameTwo(url); }
window.__devtoolsPageReady = (async () => {
  const q = new URLSearchParams(location.search);
  const key = q.get("key") || "k";
  const n = +(q.get("n") || 0);
  const big = q.get("big") === "1";
  const ws = q.get("ws") === "1";
  const data = q.get("data") === "1";
  const stack = q.get("stack") === "1";
  const slow = +(q.get("slow") || 0);
  const slowms = +(q.get("slowms") || 3000);
  const out = { key, ok: true };
  if (data) {
    await new Promise((resolve) => {
      const img = document.createElement("img");
      img.alt = "inline";
      img.onload = resolve;
      img.onerror = resolve;
      img.src = ${JSON.stringify(DATA_IMAGE_URI)};
      document.body.append(img);
    });
  }
  if (stack) {
    await stackFrameOne("/text.txt?stack=" + encodeURIComponent(key));
  } else {
    await fetch("/text.txt?k=" + encodeURIComponent(key), { cache: "no-store" }).then((r) => r.text());
  }
  await fetch("/mid.bin?k=" + encodeURIComponent(key), { cache: "no-store" }).then((r) => r.arrayBuffer());
  await fetch("/echo?k=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hello: "world", n: 42 }),
  }).then((r) => r.text());
  await fetch("/form?k=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "a=1&b=two",
  }).then((r) => r.text());
  if (big) await fetch("/big.bin?k=" + encodeURIComponent(key), { cache: "no-store" }).then((r) => r.arrayBuffer());
  for (let i = 0; i < n; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, (_, j) =>
        fetch("/s/" + (i + j) + "?k=" + encodeURIComponent(key), { cache: "no-store" }).then((r) => r.arrayBuffer()),
      ),
    );
  }
  if (ws) {
    await new Promise((res, rej) => {
      const s = new WebSocket("ws://" + location.host + "/ws");
      s.onopen = () => s.send("ping-from-page");
      s.onmessage = (e) => { out.wsReply = e.data; s.close(); res(); };
      s.onerror = rej;
    });
  }
  if (slow > 0) {
    window.__slowPromise = fetch("/slow/" + slow + "?ms=" + slowms + "&k=" + encodeURIComponent(key), { cache: "no-store" })
      .then((r) => r.arrayBuffer())
      .then((b) => String(b.byteLength))
      .catch(() => "aborted");
  }
  return JSON.stringify(out);
})();
`;

export async function startDevtoolsFixtureServer(): Promise<DevtoolsFixtureServer> {
  const requestLog: DevtoolsServedRequest[] = [];
  let taken: DevtoolsServedRequest[] = [];
  const truthBySeq = new Map<number, DevtoolsSequenceTruth>();
  let nextSeq = 0;
  const waiters: { readonly pred: () => boolean; readonly resolve: () => void }[] = [];

  const notifyWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i]!;
      if (w.pred()) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  };

  const record = (req: NodeHttp.IncomingMessage, buf: Buffer): number => {
    const seq = ++nextSeq;
    const url = req.url ?? "/";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    const entry: DevtoolsServedRequest = {
      seq,
      method: req.method ?? "GET",
      path: pathname,
      url,
      status: 200,
    };
    requestLog.push(entry);
    taken.push(entry);
    truthBySeq.set(seq, {
      seq,
      method: entry.method,
      path: pathname,
      url,
      status: 200,
      decodedLength: buf.length,
      decodedSha256: sha256(buf),
    });
    notifyWaiters();
    return seq;
  };

  const send = (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    buf: Buffer,
    type: string,
  ): void => {
    const seq = record(req, buf);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
      "X-Seq": String(seq),
    });
    res.end(buf);
  };

  const server = NodeHttp.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = u.pathname;
    if (p === "/echo" || p === "/form") {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => send(req, res, Buffer.concat(chunks), "text/plain; charset=utf-8"));
      return;
    }
    if (p === "/big.bin") {
      send(req, res, BIG, "application/octet-stream");
      return;
    }
    if (p === "/mid.bin") {
      send(req, res, MID, "application/octet-stream");
      return;
    }
    if (p === "/text.txt") {
      send(req, res, TXT, "text/plain; charset=utf-8");
      return;
    }
    if (p === "/favicon.ico") {
      send(req, res, FAVICON_PNG, "image/png");
      return;
    }
    if (p.startsWith("/s/")) {
      const index = Number(p.slice(3));
      if (Number.isInteger(index) && index >= 0) {
        send(req, res, smallSlice(index), "application/octet-stream");
        return;
      }
    }
    if (p.startsWith("/slow/")) {
      const size = Math.min(BIG.length, Math.max(1, Number(p.slice(6)) || 0));
      const ms = Math.max(100, Number(u.searchParams.get("ms") ?? "3000"));
      const buf = BIG.subarray(0, size);
      const seq = record(req, buf);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "X-Seq": String(seq),
      });
      const parts = 40;
      const step = Math.ceil(buf.length / parts);
      let chunk = 0;
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const tick = () => {
        if (closed) return;
        const start = chunk * step;
        if (start >= buf.length) {
          res.end();
          return;
        }
        res.write(buf.subarray(start, Math.min(buf.length, start + step)));
        chunk += 1;
        setTimeout(tick, Math.max(10, Math.floor(ms / parts)));
      };
      tick();
      return;
    }
    if (p === "/blank.html") {
      send(
        req,
        res,
        Buffer.from("<!doctype html><title>blank</title>blank", "utf8"),
        "text/html; charset=utf-8",
      );
      return;
    }
    if (p === "/page.html") {
      const html = `<!doctype html><title>har page</title><body><script>${PAGE_SCRIPT}</script></body>`;
      send(req, res, Buffer.from(html, "utf8"), "text/html; charset=utf-8");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, sock: NodeNet.Socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      sock.destroy();
      return;
    }
    sock.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    sock.on("data", (d: Buffer) => {
      if (d.length < 2) return;
      const op = (d[0] ?? 0) & 0x0f;
      if (op === 8) {
        sock.end(Buffer.from([0x88, 0]));
        return;
      }
      const len = (d[1] ?? 0) & 0x7f;
      const mask = d.subarray(2, 6);
      const payload = Buffer.from(d.subarray(6, 6 + len));
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      }
      sock.write(wsFrame(`pong:${payload.toString("utf8")}`));
    });
    sock.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server failed to bind port");

  return {
    port: addr.port,
    origin: `http://127.0.0.1:${String(addr.port)}`,
    getRequestLog: () => [...requestLog],
    takeRequests: () => {
      const out = taken;
      taken = [];
      return out;
    },
    getSequenceTruth: (seq) => truthBySeq.get(seq),
    waitForPath: (substring) =>
      new Promise<void>((resolve) => {
        if (taken.some((e) => e.url.includes(substring))) {
          resolve();
          return;
        }
        waiters.push({
          pred: () => taken.some((e) => e.url.includes(substring)),
          resolve,
        });
      }),
    [Symbol.asyncDispose]: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
