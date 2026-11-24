import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { connectRemote } from "./remote.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("remote control", () => {
  it("uses BiDi when that protocol is requested, even if Marionette is already open", async () => {
    const bidi = await startBidi();
    await startMarionette();
    const remote = await connectRemote({
      protocol: "bidi",
      port: bidi.port,
      exitStatus: () => null,
      stderr: () => "",
      signal: new AbortController().signal,
    });
    expect(remote.protocol).toBe("bidi");
    expect(remote.browserPid).toBe(77);
    expect(remote.browserName).toBe("zen");
    expect(remote.userAgent).toBe("ZenTest");
    const context = await remote.openTab("http://127.0.0.1/");
    await remote.navigateTab(context, "http://127.0.0.1/next");
    await remote.reloadTab(context);
    expect(await remote.evaluate(context, "window.__harnessReady")).toBe(READY);
    await expect(remote.evaluateChrome("done(1)")).rejects.toThrow(/requires marionette/);
    await expect(remote.takeChromeScreenshot()).rejects.toThrow(/requires marionette/);
    await remote.closeTab(context);
    await remote.quit();
    remote.dispose();
  });

  it("uses Marionette when that protocol is requested and can open a second tab", async () => {
    await startBidi();
    const marionette = await startMarionette();
    const remote = await connectRemote({
      protocol: "marionette",
      port: marionette.port,
      exitStatus: () => null,
      stderr: () => "",
      signal: new AbortController().signal,
    });
    expect(remote.protocol).toBe("marionette");
    expect(remote.browserPid).toBe(88);
    expect(remote.browserName).toBe("zen");
    expect(remote.userAgent).toBe("ZenMarionette");
    const first = await remote.openTab("http://127.0.0.1/");
    await remote.navigateTab(first, "http://127.0.0.1/next");
    await remote.reloadTab(first);
    expect(await remote.evaluate(first, "window.__harnessReady")).toBe(READY);
    expect(await remote.evaluateChrome("done('chrome-ok')")).toBe("chrome-ok");
    const png = await remote.takeChromeScreenshot("#toolbar");
    expect(png.toString("utf8")).toBe("fake-png");
    await remote.closeTab(first);
    const second = await remote.openTab("http://127.0.0.1/again");
    expect(await remote.evaluate(second, "window.__harnessReady")).toBe(READY);
    await remote.closeTab(second);
    await remote.quit();
    remote.dispose();
  });

  it("reports the browser exit instead of waiting for a port", async () => {
    await expect(
      connectRemote({
        protocol: "bidi",
        port: 1,
        exitStatus: () => "code 9",
        stderr: () => "startup failed",
        signal: new AbortController().signal,
        deadlineMs: 0,
      }),
    ).rejects.toThrow(/exited with code 9[\s\S]*startup failed/);
  });
});

async function startBidi(): Promise<{ port: number }> {
  const server = NodeHttp.createServer();
  server.on("clientError", (_error, socket) => socket.destroy());
  const sockets = new Set<NodeStream.Duplex>();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = NodeCrypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer: Buffer<ArrayBufferLike> = Buffer.from(head);
    const page = { loaded: false };
    const consume = (): void => {
      while (true) {
        const frame = readClientFrame(buffer);
        if (frame === null) return;
        buffer = frame.rest;
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8")) as BidiCommand;
        const reply = (): void => {
          socket.write(encodeServerText(Buffer.from(JSON.stringify(bidiResponse(message, page)))));
        };
        if (message.method === "browsingContext.navigate") {
          page.loaded = false;
          if (message.params.wait === "complete") {
            setImmediate(() => {
              page.loaded = true;
              reply();
            });
          } else reply();
          continue;
        }
        reply();
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    consume();
  });
  await listenHttp(server);
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { port: portOf(server) };
}

// The page script is only there once navigation finished, so a caller that evaluates before the
// navigation reply sees no ready value, as a real browser would.
const READY = '{"ok":true}';

type BidiCommand = { id: number; method: string; params: Record<string, unknown> };

function bidiResponse(message: BidiCommand, page: { loaded: boolean }): unknown {
  if (message.method === "script.evaluate" && !page.loaded) {
    return {
      id: message.id,
      type: "success",
      result: { type: "exception", exceptionDetails: { text: "page is still loading" } },
    };
  }
  const result = bidiResult(message.method);
  return { id: message.id, type: "success", result };
}

function bidiResult(method: string): unknown {
  if (method === "session.new") {
    return {
      capabilities: {
        "moz:processID": 77,
        browserName: "zen",
        browserVersion: "160.0",
        "moz:buildID": "20261113100328",
        userAgent: "ZenTest",
      },
    };
  }
  if (method === "browsingContext.create") return { context: "tab-1" };
  if (method === "script.evaluate") {
    return { type: "success", result: { type: "string", value: READY } };
  }
  if (
    method === "browsingContext.navigate" ||
    method === "browsingContext.reload" ||
    method === "browsingContext.close" ||
    method === "browser.close"
  ) {
    return {};
  }
  throw new Error(`unexpected BiDi method ${method}`);
}

async function startMarionette(): Promise<{ port: number }> {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    writeLength(socket, { applicationType: "gecko", marionetteProtocol: 3 });
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const session = {
      loaded: false,
      waitsForLoad: false,
      handles: ["initial"],
      current: "initial" as string | null,
      nextWindow: 1,
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const next = takeLengthMessage(buffer);
        if (next === null) return;
        buffer = next.rest;
        if (!Array.isArray(next.message)) continue;
        const id: unknown = next.message[1];
        const name: unknown = next.message[2];
        const params: unknown = next.message[3];
        if (typeof id !== "number" || typeof name !== "string") continue;
        if (name === "WebDriver:NewSession") {
          session.waitsForLoad = JSON.stringify(params).includes('"pageLoadStrategy":"normal"');
        }
        if (name === "WebDriver:Navigate" || name === "WebDriver:Refresh") {
          session.loaded = false;
          const finish = (): void => {
            session.loaded = true;
          };
          if (session.waitsForLoad) {
            setImmediate(() => {
              finish();
              writeLength(socket, [1, id, null, {}]);
            });
          } else {
            writeLength(socket, [1, id, null, {}]);
          }
          continue;
        }
        const discarded = session.current === null || !session.handles.includes(session.current);
        if (
          (name === "WebDriver:NewWindow" || name === "WebDriver:ExecuteAsyncScript") &&
          discarded
        ) {
          writeLength(socket, [
            1,
            id,
            { error: "unknown error", message: "Browsing context has been discarded" },
            null,
          ]);
          continue;
        }
        if (name === "WebDriver:ExecuteAsyncScript" && !session.loaded) {
          writeLength(socket, [
            1,
            id,
            { error: "javascript error", message: "page is still loading" },
            null,
          ]);
          continue;
        }
        writeLength(socket, [1, id, null, marionetteResult(name, params, session)]);
      }
    });
  });
  await listenNet(server);
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { port: portOf(server) };
}

type MarionetteSession = {
  loaded: boolean;
  waitsForLoad: boolean;
  handles: string[];
  current: string | null;
  nextWindow: number;
};

function marionetteResult(name: string, params: unknown, session: MarionetteSession): unknown {
  if (name === "WebDriver:NewSession") {
    return {
      capabilities: {
        "moz:processID": 88,
        browserName: "zen",
        browserVersion: "160.0",
        "moz:buildID": "20261113100328",
      },
    };
  }
  if (name === "WebDriver:GetWindowHandle") return { value: session.current };
  if (name === "WebDriver:ExecuteScript") return { value: "ZenMarionette" };
  if (name === "WebDriver:NewWindow") {
    const handle = `win-${String(session.nextWindow)}`;
    session.nextWindow += 1;
    session.handles.push(handle);
    session.current = handle;
    return { value: { handle, type: "tab" } };
  }
  if (name === "WebDriver:ExecuteAsyncScript") {
    const script = isRecord(params) && typeof params.script === "string" ? params.script : "";
    if (script.includes("chrome-ok")) return { value: "chrome-ok" };
    return { value: READY };
  }
  if (name === "Marionette:SetContext") return {};
  if (name === "WebDriver:FindElement") return { value: { element: "el-1" } };
  if (name === "WebDriver:TakeScreenshot") {
    return { value: Buffer.from("fake-png", "utf8").toString("base64") };
  }
  if (name === "Marionette:Quit") return {};
  if (name === "WebDriver:SwitchToWindow") {
    const handle = isRecord(params) && typeof params.handle === "string" ? params.handle : "";
    if (!session.handles.includes(handle)) {
      throw new Error(`mock switch to missing window ${handle}`);
    }
    session.current = handle;
    return {};
  }
  if (name === "WebDriver:CloseWindow") {
    session.handles = session.handles.filter((handle) => handle !== session.current);
    session.current = null;
    return {};
  }
  throw new Error(`unexpected Marionette command ${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeLength(socket: NodeNet.Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  socket.write(`${String(payload.length)}:${payload.toString("utf8")}`);
}

function takeLengthMessage(
  buffer: Buffer,
): { message: unknown; rest: Buffer<ArrayBufferLike> } | null {
  const colon = buffer.indexOf(0x3a);
  if (colon <= 0) return null;
  const length = Number(buffer.toString("ascii", 0, colon));
  if (!Number.isInteger(length) || length < 0) return null;
  const start = colon + 1;
  if (buffer.length < start + length) return null;
  return {
    message: JSON.parse(buffer.toString("utf8", start, start + length)) as unknown,
    rest: buffer.subarray(start + length),
  };
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

function encodeServerText(payload: Buffer): Buffer {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function listenNet(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function listenHttp(server: NodeHttp.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function portOf(server: NodeNet.Server | NodeHttp.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}
