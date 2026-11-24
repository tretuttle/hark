import * as NodeNet from "node:net";

const CONNECT_MS = 30_000;
const SOCKET_MS = 15_000;
const COMMAND_MS = 60_000;

export type RemoteProtocol = "bidi" | "marionette";

export type RemoteControl = {
  readonly protocol: RemoteProtocol;
  readonly browserPid: number;
  readonly browserName: string;
  readonly version: string;
  readonly buildId: string;
  readonly userAgent: string;
  readonly openTab: (url: string) => Promise<string>;
  readonly navigateTab: (context: string, url: string) => Promise<void>;
  readonly reloadTab: (context: string) => Promise<void>;
  readonly evaluate: (context: string, expression: string) => Promise<string>;
  readonly evaluateChrome: (script: string, args?: readonly unknown[]) => Promise<unknown>;
  readonly takeChromeScreenshot: (selector?: string) => Promise<Buffer>;
  readonly closeTab: (context: string) => Promise<void>;
  readonly quit: () => Promise<void>;
  readonly dispose: () => void;
};

type ExitInfo = {
  readonly exitStatus: () => string | null;
  readonly waitForExit?: () => Promise<string>;
  readonly stderr: () => string;
};

const EXIT_STATUS_WAIT_MS = 500;

export async function connectRemote(options: {
  readonly protocol: RemoteProtocol;
  readonly port: number;
  readonly exitStatus: () => string | null;
  readonly waitForExit?: () => Promise<string>;
  readonly stderr: () => string;
  readonly signal: AbortSignal;
  readonly deadlineMs?: number;
}): Promise<RemoteControl> {
  const deadline = Date.now() + (options.deadlineMs ?? CONNECT_MS);
  let detail = `${options.protocol} port did not open`;
  const throwIfExited = (): void => {
    options.signal.throwIfAborted();
    const status = options.exitStatus();
    if (status !== null) {
      throw new Error(
        `browser exited with ${status} before remote control opened\n${options.stderr()}`,
      );
    }
  };
  throwIfExited();
  const exitInfo: ExitInfo = {
    exitStatus: options.exitStatus,
    ...(options.waitForExit === undefined ? {} : { waitForExit: options.waitForExit }),
    stderr: options.stderr,
  };
  const open = options.protocol === "bidi" ? openBidi : openMarionette;
  while (Date.now() < deadline) {
    throwIfExited();
    if (await tcpOpen(options.port)) {
      try {
        return await open(options.port, exitInfo);
      } catch (error) {
        detail = errorMessage(error);
      }
    }
    await delay(100);
  }
  throwIfExited();
  throw new Error(`timed out waiting for ${options.protocol}\n${detail}\n${options.stderr()}`);
}

async function openBidi(port: number, exitInfo: ExitInfo): Promise<RemoteControl> {
  const bidi = await connectBidi(port, exitInfo);
  try {
    const identity = readBidiSession(
      await bidi.call("session.new", { capabilities: { alwaysMatch: {} } }, SOCKET_MS),
    );
    return {
      protocol: "bidi",
      ...identity,
      openTab: async (url) => {
        const created = await bidi.call("browsingContext.create", { type: "tab" });
        const context = readStringField(created, "context", "browsingContext");
        await bidi.call("browsingContext.navigate", { context, url, wait: "complete" });
        return context;
      },
      navigateTab: async (context, url) => {
        await bidi.call("browsingContext.navigate", { context, url, wait: "complete" });
      },
      reloadTab: async (context) => {
        await bidi.call("browsingContext.reload", { context, wait: "complete" });
      },
      evaluate: async (context, expression) =>
        readBidiString(
          await bidi.call("script.evaluate", {
            expression,
            awaitPromise: true,
            target: { context },
          }),
        ),
      evaluateChrome: () => Promise.reject(new Error("chrome evaluation requires marionette")),
      takeChromeScreenshot: () =>
        Promise.reject(new Error("chrome screenshot requires marionette")),
      closeTab: async (context) => {
        await bidi.call("browsingContext.close", { context });
      },
      quit: async () => {
        await bidi.call("browser.close", {}).catch(() => undefined);
      },
      dispose: () => bidi.close(),
    };
  } catch (error) {
    bidi.close();
    throw error;
  }
}

async function openMarionette(port: number, exitInfo: ExitInfo): Promise<RemoteControl> {
  const marionette = await connectMarionette(port, exitInfo);
  try {
    const created = await marionette.call(
      "WebDriver:NewSession",
      {
        capabilities: {
          alwaysMatch: {
            pageLoadStrategy: "normal",
            timeouts: { script: COMMAND_MS, pageLoad: COMMAND_MS },
          },
        },
      },
      SOCKET_MS,
    );
    const identity = readMarionetteSession(created);
    const userAgent = await readMarionetteUserAgent(marionette, identity.userAgent);
    const initialWindow = readMarionetteHandle(
      await marionette.call("WebDriver:GetWindowHandle", {}),
    );
    return {
      protocol: "marionette",
      browserPid: identity.browserPid,
      browserName: identity.browserName,
      version: identity.version,
      buildId: identity.buildId,
      userAgent,
      openTab: async (url) => {
        const createdWindow = await marionette.call("WebDriver:NewWindow", {
          type: "tab",
          focus: true,
        });
        const handle = readStringField(
          unwrapMarionette(createdWindow),
          "handle",
          "WebDriver:NewWindow",
        );
        await marionette.call("WebDriver:SwitchToWindow", { handle, focus: true });
        await marionette.call("WebDriver:Navigate", { url });
        return handle;
      },
      navigateTab: async (context, url) => {
        await marionette.call("WebDriver:SwitchToWindow", { handle: context, focus: true });
        await marionette.call("WebDriver:Navigate", { url });
      },
      reloadTab: async (context) => {
        await marionette.call("WebDriver:SwitchToWindow", { handle: context, focus: true });
        await marionette.call("WebDriver:Refresh", {});
      },
      evaluate: async (context, expression) => {
        await marionette.call("WebDriver:SwitchToWindow", { handle: context, focus: true });
        const value = await marionette.call("WebDriver:ExecuteAsyncScript", {
          script: MARIONETTE_ASYNC,
          args: [expression],
        });
        return readMarionetteString(value);
      },
      evaluateChrome: async (script, args = []) => {
        await marionette.call("Marionette:SetContext", { value: "chrome" });
        try {
          const result = await marionette.call("WebDriver:ExecuteAsyncScript", {
            script,
            args: [...args],
          });
          return unwrapMarionette(result);
        } finally {
          await marionette
            .call("Marionette:SetContext", { value: "content" })
            .catch(() => undefined);
        }
      },
      takeChromeScreenshot: async (selector) => {
        await marionette.call("Marionette:SetContext", { value: "chrome" });
        try {
          const params: Record<string, unknown> =
            selector === undefined
              ? { full: false, hash: false }
              : {
                  id: readMarionetteElementId(
                    await marionette.call("WebDriver:FindElement", {
                      using: "css selector",
                      value: selector,
                    }),
                  ),
                  hash: false,
                };
          const result = unwrapMarionette(
            await marionette.call("WebDriver:TakeScreenshot", params),
          );
          if (typeof result !== "string") {
            throw new Error(`WebDriver:TakeScreenshot returned ${JSON.stringify(result)}`);
          }
          return Buffer.from(result, "base64");
        } finally {
          await marionette
            .call("Marionette:SetContext", { value: "content" })
            .catch(() => undefined);
        }
      },
      closeTab: async (context) => {
        await marionette.call("WebDriver:SwitchToWindow", { handle: context, focus: true });
        await marionette.call("WebDriver:CloseWindow", {});
        await marionette.call("WebDriver:SwitchToWindow", { handle: initialWindow, focus: true });
      },
      quit: async () => {
        await marionette
          .call("Marionette:Quit", { flags: ["eAttemptQuit"] })
          .catch(() => undefined);
      },
      dispose: () => marionette.close(),
    };
  } catch (error) {
    marionette.close();
    throw error;
  }
}

const MARIONETTE_ASYNC = [
  "const done = arguments[arguments.length - 1];",
  "const expression = arguments[0];",
  "Promise.resolve(eval(expression)).then(",
  "(value) => done(value),",
  "(error) => done({ __harnessError: error instanceof Error ? error.message : String(error) }),",
  ");",
].join("");

type CommandSocket = {
  call: (name: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  close: () => void;
};

function connectBidi(port: number, exitInfo: ExitInfo): Promise<CommandSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/session`);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let failed: Error | null = null;
  let closingPromise: Promise<Error> | null = null;
  let closedIntentionally = false;
  const socket: CommandSocket = {
    call(method, params, timeoutMs = COMMAND_MS) {
      if (failed !== null) return Promise.reject(failed);
      if (closingPromise !== null) return closingPromise.then((error) => Promise.reject(error));
      const id = nextId;
      nextId += 1;
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      closedIntentionally = true;
      ws.close();
    },
  };
  ws.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(frameText(event.data));
    if (!isRecord(message) || typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.type === "error") {
      const text = typeof message.message === "string" ? message.message : JSON.stringify(message);
      waiter.reject(new Error(text));
      return;
    }
    waiter.resolve(message.result);
  });
  ws.addEventListener("close", () => {
    if (closingPromise !== null || failed !== null) return;
    if (closedIntentionally) {
      failed = new Error("BiDi socket closed");
      for (const waiter of pending.values()) waiter.reject(failed);
      pending.clear();
      return;
    }
    closingPromise = buildSocketClosedError("BiDi socket closed", exitInfo).then((error) => {
      failed = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      return error;
    });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("BiDi websocket timed out"));
    }, SOCKET_MS);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("BiDi websocket failed"));
      },
      { once: true },
    );
  });
}

function connectMarionette(port: number, exitInfo: ExitInfo): Promise<CommandSocket> {
  const socket = NodeNet.connect(port, "127.0.0.1");
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let failed: Error | null = null;
  let closingPromise: Promise<Error> | null = null;
  let closedIntentionally = false;
  let opened = false;

  function send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    socket.write(`${String(payload.length)}:${payload.toString("utf8")}`);
  }

  const commands: CommandSocket = {
    call(name, params, timeoutMs = COMMAND_MS) {
      if (failed !== null) return Promise.reject(failed);
      if (closingPromise !== null) return closingPromise.then((error) => Promise.reject(error));
      const id = nextId;
      nextId += 1;
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      send([0, id, name, params]);
      return result;
    },
    close() {
      closedIntentionally = true;
      socket.destroy();
    },
  };

  function fail(error: Error): void {
    if (failed !== null) return;
    failed = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    socket.destroy();
  }

  function failAfterClose(label: string): void {
    if (closingPromise !== null || failed !== null) return;
    if (closedIntentionally) {
      fail(new Error(label));
      return;
    }
    closingPromise = buildSocketClosedError(label, exitInfo).then((error) => {
      fail(error);
      return error;
    });
  }

  function onMessage(message: unknown, ready: (value: CommandSocket) => void): void {
    if (!opened) {
      opened = true;
      if (!isRecord(message) || message.applicationType !== "gecko") {
        const error = new Error(`Marionette hello was ${JSON.stringify(message)}`);
        fail(error);
        return;
      }
      send({ marionetteProtocol: 3 });
      ready(commands);
      return;
    }
    if (!Array.isArray(message) || message[0] !== 1 || typeof message[1] !== "number") return;
    const waiter = pending.get(message[1]);
    if (waiter === undefined) return;
    pending.delete(message[1]);
    const error = message[2];
    if (error !== null && error !== undefined) {
      const text = isRecord(error)
        ? (stringField(error, "message") ?? stringField(error, "error") ?? JSON.stringify(error))
        : String(error);
      waiter.reject(new Error(text));
      return;
    }
    waiter.resolve(message[3]);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fail(new Error("Marionette handshake timed out"));
      reject(new Error("Marionette handshake timed out"));
    }, SOCKET_MS);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const next = takeLengthMessage(buffer);
        if (next === null) return;
        buffer = next.rest;
        onMessage(next.message, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      if (opened) {
        failAfterClose("Marionette socket failed");
        return;
      }
      const error = new Error("Marionette socket failed");
      fail(error);
      reject(error);
    });
    socket.on("close", () => {
      if (opened) failAfterClose("Marionette socket closed");
    });
  });
}

async function buildSocketClosedError(label: string, exitInfo: ExitInfo): Promise<Error> {
  let status = exitInfo.exitStatus();
  if (status === null && exitInfo.waitForExit !== undefined) {
    await Promise.race([exitInfo.waitForExit(), delay(EXIT_STATUS_WAIT_MS)]);
    status = exitInfo.exitStatus();
  }
  const tail = exitInfo.stderr().trim();
  if (status === null) {
    return new Error(tail.length > 0 ? `${label}\n${tail}` : label);
  }
  return new Error(`${label} (browser exited with ${status})${tail.length > 0 ? `\n${tail}` : ""}`);
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
  const message: unknown = JSON.parse(buffer.toString("utf8", start, start + length));
  return { message, rest: buffer.subarray(start + length) };
}

type BrowserIdentity = {
  browserPid: number;
  browserName: string;
  version: string;
  buildId: string;
  userAgent: string;
};

function readBidiSession(result: unknown): BrowserIdentity {
  const capabilities = recordField(result, "capabilities");
  if (!isRecord(capabilities)) throw new Error("session.new returned no capabilities");
  return {
    browserPid: readPid(capabilities["moz:processID"], "session.new"),
    browserName: readText(capabilities.browserName, "browser name"),
    version: readText(capabilities.browserVersion, "browser version"),
    buildId: readText(capabilities["moz:buildID"], "build id"),
    userAgent: readText(capabilities.userAgent, "user agent"),
  };
}

function readMarionetteSession(result: unknown): BrowserIdentity {
  const capabilities = recordField(result, "capabilities");
  if (!isRecord(capabilities)) throw new Error("WebDriver:NewSession returned no capabilities");
  const userAgent = capabilities.userAgent;
  return {
    browserPid: readPid(capabilities["moz:processID"], "WebDriver:NewSession"),
    browserName: readText(capabilities.browserName, "browser name"),
    version: readText(capabilities.browserVersion, "browser version"),
    buildId: readText(capabilities["moz:buildID"], "build id"),
    userAgent: typeof userAgent === "string" ? userAgent : "",
  };
}

async function readMarionetteUserAgent(
  marionette: CommandSocket,
  current: string,
): Promise<string> {
  if (current.length > 0) return current;
  const value = await marionette.call("WebDriver:ExecuteScript", {
    script: "return navigator.userAgent",
    args: [],
  });
  return readText(unwrapMarionette(value), "user agent");
}

function readMarionetteHandle(value: unknown): string {
  const handle = unwrapMarionette(value);
  if (typeof handle !== "string" || handle.length === 0) {
    throw new Error(`WebDriver:GetWindowHandle returned ${JSON.stringify(value)}`);
  }
  return handle;
}

function readMarionetteElementId(value: unknown): string {
  const unwrapped = unwrapMarionette(value);
  if (isRecord(unwrapped)) {
    const first = Object.values(unwrapped)[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  throw new Error(`WebDriver:FindElement returned ${JSON.stringify(value)}`);
}

function unwrapMarionette(value: unknown): unknown {
  if (isRecord(value) && "value" in value) return value.value;
  return value;
}

function readBidiString(result: unknown): string {
  if (!isRecord(result)) throw new Error("script.evaluate returned no result");
  if (result.type === "exception") {
    throw new Error(
      `script.evaluate failed: ${JSON.stringify(result.exceptionDetails ?? result.exception)}`,
    );
  }
  const remote = result.result;
  if (!isRecord(remote) || remote.type !== "string" || typeof remote.value !== "string") {
    throw new Error(`script.evaluate returned ${JSON.stringify(result)}`);
  }
  return remote.value;
}

function readMarionetteString(value: unknown): string {
  const unwrapped = unwrapMarionette(value);
  if (isRecord(unwrapped) && typeof unwrapped.__harnessError === "string") {
    throw new Error(unwrapped.__harnessError);
  }
  if (typeof unwrapped !== "string") {
    throw new Error(`Marionette evaluate returned ${JSON.stringify(value)}`);
  }
  return unwrapped;
}

function readPid(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${source} returned no moz:processID`);
  }
  return value;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`remote control returned no ${label}`);
  return value;
}

function readStringField(value: unknown, key: string, source: string): string {
  const field = recordField(value, key);
  if (typeof field !== "string" || field.length === 0)
    throw new Error(`${source} returned no ${key}`);
  return field;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
