import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  COST_HEAVY_PATH,
  COST_IMAGES_COUNT,
  COST_IMAGES_PATH,
  COST_MIXED_COUNT,
  COST_MIXED_PATH,
  getCostScenarios,
  ID_BIG_BYTE_LENGTH,
  ID_BIG_PATH,
  ID_CACHED_PATH,
  ID_DOWNLOAD_PAGE_PATH,
  ID_DOWNLOAD_PATH,
  ID_ENDLESS_PATH,
  ID_REDIRECT_1_PATH,
  ID_REDIRECT_2_PATH,
  ID_REDIRECT_FINAL_PATH,
  ID_REVAL_PATH,
  POLL_PATH,
  SW_INDEX_PATH,
  SW_JS_PATH,
  SW_PASS_PATH,
} from "./extended-fixtures.ts";
import {
  BINARY_BYTE_LENGTH,
  buildBody,
  expectedResourceCount,
  GZIP_BYTE_LENGTH,
  listFixtures,
  WEBSOCKET_PATH,
} from "./fixtures.ts";
import { PINNED_RESPONSES } from "./pinned-responses.ts";
import {
  COST_SCENARIO_NAMES,
  getCostScenario,
  parseCostScenarioName,
  SCENARIOS,
} from "./scenarios.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server[Symbol.asyncDispose]();
});

describe("fixture generator", () => {
  it("builds every fixture body with the pinned digest and length", () => {
    const fixtures = listFixtures();
    expect(fixtures.map((fixture) => fixture.id).sort()).toEqual(
      Object.keys(PINNED_RESPONSES)
        .filter((id) => !id.includes("@"))
        .sort(),
    );
    for (const fixture of fixtures) {
      const body = buildBody(fixture);
      expect({ id: fixture.id, sha256: hashBuffer(body), byteLength: body.length }).toEqual({
        id: fixture.id,
        ...pin(fixture.id),
      });
    }
  });
});

describe("fixture server", () => {
  it("binds only loopback", () => {
    expect(server.origin.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("serves the 50 MB fixture with Content-Length and the digest of those bytes", async () => {
    const response = await readHttp(server.port, "/fixtures/binary");
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(String(BINARY_BYTE_LENGTH));
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(response.body.length).toBe(BINARY_BYTE_LENGTH);
    expectPinned("binary", response.body);
  });

  it("serves the chunked fixture with no Content-Length and the digest of the decoded bytes", async () => {
    const raw = await readRaw(server.port, "/fixtures/chunked");
    expect(raw.status).toBe(200);
    expect(raw.headerText).not.toMatch(/^content-length:/imu);
    expect(raw.headerText).toMatch(/^transfer-encoding:\s*chunked/imu);
    const body = decodeChunked(raw.body);
    expect(body.length).toBe(BINARY_BYTE_LENGTH);
    expectPinned("chunked", body);
  });

  it("serves gzip that decodes to the digest", async () => {
    const response = await readHttp(server.port, "/fixtures/gzip");
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    const decoded = NodeZlib.gunzipSync(response.body);
    expect(decoded.length).toBeGreaterThanOrEqual(GZIP_BYTE_LENGTH);
    expectPinned("gzip", decoded);
  });

  it("returns 206 with the requested bytes", async () => {
    const full = await readHttp(server.port, "/fixtures/range");
    expectPinned("range", full.body);
    const partial = await readHttp(server.port, "/fixtures/range", {
      headers: { Range: "bytes=1000-1999" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toBe(`bytes 1000-1999/${String(full.body.length)}`);
    expect(Buffer.compare(partial.body, full.body.subarray(1000, 2000))).toBe(0);
    expectPinned("range@1000-1999", partial.body);
  });

  it("returns JSON from POST", async () => {
    const response = await readHttp(server.port, "/fixtures/post", {
      method: "POST",
      body: Buffer.from("{}"),
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ fixture: "post-json" });
    expectPinned("post-json", response.body);
  });

  it("sends Cache-Control no-store", async () => {
    const response = await readHttp(server.port, "/fixtures/no-store");
    expect(response.headers["cache-control"]).toBe("no-store");
    expectPinned("no-store", response.body);
  });

  it("serves video bytes that match the digest", async () => {
    const response = await readHttp(server.port, "/fixtures/video");
    expect(response.headers["content-type"]).toBe("video/mp4");
    expectPinned("video", response.body);
  });

  it("echoes a websocket payload", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}${WEBSOCKET_PATH}`);
    const text = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("open", () => socket.send("echo-me"));
      socket.addEventListener("message", (event) => resolve(String(event.data)));
      socket.addEventListener("error", () => reject(new Error("websocket failed")));
    });
    expect(text).toBe("echo-me");
    const binary = Uint8Array.from([1, 2, 3, 255]);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) resolve(Buffer.from(new Uint8Array(data)));
        else resolve(Buffer.from(String(data)));
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed")));
      socket.send(binary);
    });
    expect(Buffer.compare(echoed, Buffer.from(binary))).toBe(0);
    socket.close();
  });

  it("serves a page that references 200 small resources with matching digests", async () => {
    const page = await readHttp(server.port, "/");
    expect(page.headers["content-type"]).toContain("text/html");
    const urls = page.body.toString("utf8").match(/\/r\/(?:css|js|image|json)\/\d+/gu);
    expect(new Set(urls).size).toBe(expectedResourceCount());
    expect([...new Set(urls)].sort()).toEqual(
      SCENARIOS.page.responses
        .map((response) => response.path)
        .filter((path) => path !== "/")
        .sort(),
    );
    for (const kind of ["css", "js", "image", "json"]) {
      for (let index = 0; index < 50; index += 1) {
        const id = `r-${kind}-${String(index)}`;
        const response = await readHttp(server.port, `/r/${kind}/${String(index)}`);
        expect(response.status).toBe(200);
        expectPinned(id, response.body);
      }
    }
  });
});

describe("extended cost and identity fixtures", () => {
  it("tags every response with X-Seq, logs requests, and matches per-sequence SHA-256 (catching a flipped byte)", async () => {
    const beforeCount = server.getRequestLog().length;
    const first = await readHttp(server.port, POLL_PATH);
    const second = await readHttp(server.port, POLL_PATH);
    const seq1 = Number(first.headers["x-seq"]);
    const seq2 = Number(second.headers["x-seq"]);
    expect(seq2).toBeGreaterThan(seq1);
    expect(first.body.toString("utf8")).not.toBe(second.body.toString("utf8"));

    const truth1 = server.getSequenceTruth(seq1);
    const truth2 = server.getSequenceTruth(seq2);
    expect(truth1?.wireSha256).toBe(hashBuffer(first.body));
    expect(truth2?.wireSha256).toBe(hashBuffer(second.body));

    // One flipped byte breaks the match with the digest the server recorded.
    const flipped = Buffer.from(first.body);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(hashBuffer(flipped)).not.toBe(truth1?.wireSha256);

    // Control endpoints do not pollute the request log.
    const truthHttp = await readHttp(server.port, `/__harness/truth?seq=${String(seq1)}`);
    expect(truthHttp.status).toBe(200);
    expect(JSON.parse(truthHttp.body.toString("utf8"))).toMatchObject({ seq: seq1 });

    const logged = server.getRequestLog().slice(beforeCount);
    expect(logged).toEqual([
      { seq: seq1, method: "GET", path: POLL_PATH, url: POLL_PATH, status: 200 },
      { seq: seq2, method: "GET", path: POLL_PATH, url: POLL_PATH, status: 200 },
    ]);
  });

  it("serves all three cost pages with exact counts and per-sequence SHA-256", async () => {
    const scenarios = getCostScenarios();
    expect(scenarios.map((s) => s.name)).toEqual([...COST_SCENARIO_NAMES]);
    expect(getCostScenario(parseCostScenarioName("cost-images")).pagePath).toBe(COST_IMAGES_PATH);
    expect(() => parseCostScenarioName("no-such")).toThrow(/unknown cost scenario/);

    const imagesPage = await readHttp(server.port, COST_IMAGES_PATH);
    expect(imagesPage.status).toBe(200);
    expect(imagesPage.body.toString("utf8").match(/\/cost\/small\/\d+\.png/gu)?.length).toBe(
      COST_IMAGES_COUNT * 3,
    );
    const small0 = await readHttp(server.port, "/cost/small/0.png");
    expect(small0.headers["cache-control"]).toBe("no-store");
    expect(server.getSequenceTruth(Number(small0.headers["x-seq"]))?.wireSha256).toBe(
      hashBuffer(small0.body),
    );

    const heavyPage = await readHttp(server.port, COST_HEAVY_PATH);
    expect(heavyPage.status).toBe(200);
    const blob = await readHttp(server.port, "/cost/h/blob.bin");
    expect(blob.body.length).toBe(50_000_000);
    expect(server.getSequenceTruth(Number(blob.headers["x-seq"]))?.wireSha256).toBe(
      hashBuffer(blob.body),
    );

    const mixedPage = await readHttp(server.port, COST_MIXED_PATH);
    expect(mixedPage.status).toBe(200);
    expect(scenarios.find((s) => s.name === "cost-mixed")?.requests.length).toBe(
      COST_MIXED_COUNT + 1,
    );
    const mixed0 = await readHttp(server.port, "/cost/m/0");
    expect(mixed0.headers["cache-control"]).toBe("no-store");
    const mixed1 = await readHttp(server.port, "/cost/m/1");
    expect(mixed1.headers["cache-control"]).toBe("max-age=3600");
  });

  it("serves every identity fixture with an X-Seq and the digest of what it sent", async () => {
    // 4 MiB download (full fetch with tiny delay, and aborted midway)
    const bigFull = await readHttp(server.port, `${ID_BIG_PATH}?delayMs=1`);
    expect(bigFull.body.length).toBe(ID_BIG_BYTE_LENGTH);
    expect(server.getSequenceTruth(Number(bigFull.headers["x-seq"]))?.wireSha256).toBe(
      hashBuffer(bigFull.body),
    );

    const abortedBig = await readAborted(server.port, ID_BIG_PATH, 1_048_576);
    expect(abortedBig.bytes.length).toBeGreaterThanOrEqual(1_048_576);
    expect(abortedBig.bytes.length).toBeLessThan(ID_BIG_BYTE_LENGTH);
    await waitForCondition(() => server.getSequenceTruth(abortedBig.seq)?.aborted === true);
    expect(server.getSequenceTruth(abortedBig.seq)?.expectedLength).toBe(ID_BIG_BYTE_LENGTH);

    // 304 revalidation
    const reval200 = await readHttp(server.port, ID_REVAL_PATH);
    expect(reval200.status).toBe(200);
    expect(reval200.body.length).toBe(20_000);
    const reval304 = await readHttp(server.port, ID_REVAL_PATH, {
      headers: { "If-None-Match": String(reval200.headers.etag) },
    });
    expect(reval304.status).toBe(304);
    expect(reval304.body.length).toBe(0);
    expect(server.getSequenceTruth(Number(reval304.headers["x-seq"]))?.status).toBe(304);

    // Cache hit fixture
    const cached = await readHttp(server.port, ID_CACHED_PATH);
    expect(cached.headers["cache-control"]).toBe("max-age=3600");
    expect(cached.body.length).toBe(30_000);

    // 302 -> 307 -> 200 redirect chain
    const r1 = await readHttp(server.port, ID_REDIRECT_1_PATH);
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe(ID_REDIRECT_2_PATH);
    const r2 = await readHttp(server.port, ID_REDIRECT_2_PATH);
    expect(r2.status).toBe(307);
    expect(r2.headers.location).toBe(ID_REDIRECT_FINAL_PATH);
    const rFinal = await readHttp(server.port, ID_REDIRECT_FINAL_PATH);
    expect(rFinal.status).toBe(200);
    expect(rFinal.body.toString("utf8")).toBe("final target");

    // Service worker fixtures
    const swHtml = await readHttp(server.port, SW_INDEX_PATH);
    expect(swHtml.status).toBe(200);
    const swJs = await readHttp(server.port, SW_JS_PATH);
    expect(swJs.body.toString("utf8")).toContain("/sw/synth");
    const swPass = await readHttp(server.port, SW_PASS_PATH);
    expect(swPass.body.toString("utf8")).toBe("passed-through-network");

    // Endless stream
    const endless = await readAborted(server.port, ID_ENDLESS_PATH, 4096);
    expect(endless.bytes.toString("utf8")).toContain('{"n":1}\n');
    await waitForCondition(() => server.getSequenceTruth(endless.seq)?.aborted === true);

    // Refused port
    await expect(connectPort(server.refusedOrigin)).rejects.toThrow(/ECONNREFUSED/);

    // Download link
    const dlPage = await readHttp(server.port, ID_DOWNLOAD_PAGE_PATH);
    expect(dlPage.body.toString("utf8")).toContain(`href="${ID_DOWNLOAD_PATH}"`);
    const dl = await readHttp(server.port, ID_DOWNLOAD_PATH);
    expect(dl.headers["content-disposition"]).toContain("attachment");
    expect(server.getSequenceTruth(Number(dl.headers["x-seq"]))?.wireSha256).toBe(
      hashBuffer(dl.body),
    );
  });

  it("serves deterministic retention blobs and pauses/releases binary stream on demand", async () => {
    const page = await readHttp(server.port, "/retention/page");
    expect(page.status).toBe(200);
    const blob = await readHttp(server.port, "/retention/blob?bytes=12345&tag=s01-0");
    expect(blob.status).toBe(200);
    expect(blob.body.length).toBe(12_345);
    expect(server.getSequenceTruth(Number(blob.headers["x-seq"]))?.wireSha256).toBe(
      hashBuffer(blob.body),
    );

    const paused = await readPaused(server.port, "/fixtures/binary?pauseAfterBytes=1024", 1024);
    expect(paused.initial.length).toBeGreaterThanOrEqual(1024);
    expect(paused.initial.length).toBeLessThan(BINARY_BYTE_LENGTH);
    server.releasePaused();
    const rest = await paused.finished;
    expect(rest.length).toBe(BINARY_BYTE_LENGTH);
    expectPinned("binary", rest);
  });
});

function readAborted(
  port: number,
  path: string,
  minBytes: number,
): Promise<{ seq: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request({ host: "127.0.0.1", port, path }, (response) => {
      const seq = Number(response.headers["x-seq"]);
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= minBytes) {
          request.destroy();
          resolve({ seq, bytes: Buffer.concat(chunks) });
        }
      });
    });
    request.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    request.end();
  });
}

function readPaused(
  port: number,
  path: string,
  minBytes: number,
): Promise<{ readonly initial: Buffer; readonly finished: Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let resolved = false;
      let finishResolve: ((buf: Buffer) => void) | undefined;
      const finished = new Promise<Buffer>((res) => {
        finishResolve = res;
      });
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (!resolved && total >= minBytes) {
          resolved = true;
          resolve({ initial: Buffer.concat(chunks), finished });
        }
      });
      response.on("end", () => {
        finishResolve?.(Buffer.concat(chunks));
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function connectPort(origin: string): Promise<void> {
  const parsed = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(Number(parsed.port), parsed.hostname, () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function waitForCondition(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}

function pin(id: string): { sha256: string; byteLength: number } {
  const pinned = PINNED_RESPONSES[id];
  if (pinned === undefined) throw new Error(`no pin for ${id}`);
  return { sha256: pinned.sha256, byteLength: pinned.byteLength };
}

function expectPinned(id: string, body: Buffer): void {
  expect({ sha256: hashBuffer(body), byteLength: body.length }).toEqual(pin(id));
}

function hashBuffer(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function readHttp(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function readRaw(
  port: number,
  path: string,
): Promise<{ status: number; headerText: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const splitAt = raw.indexOf("\r\n\r\n");
      if (splitAt === -1) {
        reject(new Error("response headers did not end"));
        return;
      }
      const headerText = raw.toString("latin1", 0, splitAt);
      const status = Number(/^HTTP\/1\.[01] (\d+)/u.exec(headerText)?.[1]);
      resolve({ status, headerText, body: raw.subarray(splitAt + 4) });
    });
  });
}

function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) throw new Error("chunk size line missing");
    const size = Number.parseInt(body.toString("ascii", offset, lineEnd).split(";")[0] ?? "", 16);
    if (!Number.isInteger(size)) throw new Error("bad chunk size");
    offset = lineEnd + 2;
    if (size === 0) break;
    parts.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(parts);
}
