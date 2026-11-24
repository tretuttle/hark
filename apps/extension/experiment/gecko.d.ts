// The globals Gecko's ExtensionCommon.sys.mjs puts in the sandbox that loads an experiment parent script.
// Only the members this parent script uses are declared.

declare const tabBrand: unique symbol;
/** A browser tab element in the parent process. Passed back to DevTools, and read for its browser. */
interface NativeTab {
  readonly [tabBrand]: true;
  readonly linkedBrowser: {
    readonly browserId: number;
    readonly currentURI: Uri | null;
    readonly browsingContext: { readonly usePrivateBrowsing: boolean } | null;
  };
}

interface ExtensionObject {
  readonly tabManager: {
    /** Throws an `ExtensionError` when no tab has this ID, or for a private tab this add-on may not see. */
    get(tabId: number): { readonly nativeTab: NativeTab };
  };
  readonly version: string;
  readonly manifest: { readonly name: string };
  readonly privateBrowsingAllowed?: boolean;
  /** The add-on's packaged files. */
  readonly rootURI: Uri;
}

interface ExtensionContext {
  readonly extension: ExtensionObject;
}

declare class ExtensionAPI {
  readonly extension: ExtensionObject;
  /** Present only when the manifest's experiment entry lists `"events": ["startup"]`. */
  onStartup?(): void;
  /** true when the browser is closing; false for a disable, uninstall or update of this add-on. */
  onShutdown?(isAppShutdown: boolean): void;
  getAPI(context: ExtensionContext): Record<string, object>;
}

/** An XPCOM interface id. Members are the interface's constants. */
interface XpcomInterface {
  readonly name: string;
}

interface Principal {
  readonly isSystemPrincipal: boolean;
  readonly isContentPrincipal: boolean;
  readonly scheme: string;
  readonly asciiHost: string;
}

interface BrowsingContext {
  readonly browserId: number;
  readonly top: BrowsingContext;
  readonly currentWindowGlobal: { readonly documentURI: Uri | null } | null;
}

interface LoadInfo {
  readonly originAttributes: { readonly privateBrowsingId: number };
  readonly triggeringPrincipal: Principal;
  readonly loadingPrincipal: Principal | null;
  readonly browsingContextID: number;
  readonly browsingContext: BrowsingContext | null;
  readonly externalContentPolicyType: number;
}

interface Uri {
  readonly spec: string;
  QueryInterface(iface: XpcomInterface): { readonly file: LocalFile };
  readonly scheme: string;
  readonly asciiHost: string;
  schemeIs(scheme: string): boolean;
  resolve(relative: string): string;
}

interface HeaderVisitor {
  visitHeader(name: string, value: string): void;
}

/** nsIHttpChannel and the interfaces it is queried for here, flattened. A getter that can throw says so. */
interface HttpChannel {
  readonly channelId: number;
  readonly URI: Uri;
  readonly loadInfo: LoadInfo;
  readonly requestMethod: string;
  /** Throws before a response head arrived. */
  readonly responseStatus: number;
  readonly responseStatusText: string;
  readonly contentType: string;
  readonly contentLength: number;
  /** Throws when the response has no Content-Disposition. */
  readonly contentDisposition: number;
  readonly status: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly remoteAddress: string;
  readonly uploadStream: InputStream | null;
  readonly asyncOpenTime: number;
  readonly domainLookupStartTime: number;
  readonly domainLookupEndTime: number;
  readonly connectStartTime: number;
  readonly connectEndTime: number;
  readonly secureConnectionStartTime: number;
  readonly requestStartTime: number;
  readonly responseStartTime: number;
  readonly responseEndTime: number;
  /** Throws for a header that is absent. */
  getResponseHeader(name: string): string;
  /** Throws for a header that is absent. */
  getRequestHeader(name: string): string;
  visitRequestHeaders(visitor: HeaderVisitor): void;
  visitResponseHeaders(visitor: HeaderVisitor): void;
  getRequestVersion(major: { value?: number }, minor: { value?: number }): void;
  getResponseVersion(major: { value?: number }, minor: { value?: number }): void;
  setNewListener(listener: StreamListener): StreamListener;
  suspend(): void;
  resume(): void;
  QueryInterface(iface: XpcomInterface): HttpChannel;
}

interface RequestObserver {
  onStartRequest(request: unknown): void;
  onStopRequest(request: unknown, status: number): void;
}
interface StreamListener {
  onStartRequest(request: unknown): void;
  onDataAvailable(request: unknown, stream: InputStream, offset: number, count: number): void;
  onStopRequest(request: unknown, status: number): void;
}

interface InputStream {
  readonly __inputStream: true;
  available(): number;
  close(): void;
}
interface SeekableStream extends InputStream {
  tell(): number;
  seek(whence: number, offset: number): void;
}
interface OutputStream {
  readonly __outputStream: true;
  write(data: string, count: number): number;
  close(): void;
}
interface StorageStream {
  readonly length: number;
  init(segmentSize: number, maxSize: number): void;
  getOutputStream(start: number): OutputStream;
  newInputStream(start: number): InputStream;
}
interface StreamListenerTee extends StreamListener {
  init(listener: StreamListener, sink: OutputStream, observer: RequestObserver): void;
}
interface FileOutputStream extends OutputStream {
  init(file: LocalFile, ioFlags: number, perm: number, behaviorFlags: number): void;
}
/** One open file for reading and writing, with one position for both. Each interface is reached by QueryInterface. */
interface FileRandomAccessStream extends InputStream, OutputStream {
  init(file: LocalFile, ioFlags: number, perm: number, behaviorFlags: number): void;
  QueryInterface(iface: XpcomInterface): FileRandomAccessStream;
  /** nsISeekableStream. */
  seek(whence: number, offset: number): void;
  /** nsISeekableStream: the file ends at the current position, shorter or longer. */
  setEOF(): void;
  /** nsIFileMetadata: the open file's own length. */
  readonly size: number;
}
interface LocalFile {
  readonly path: string;
  readonly fileSize: number;
  /** The link's own size, the length of its target. */
  readonly fileSizeOfLink: number;
  readonly lastModifiedTime?: number;
  readonly directoryEntries?: {
    hasMoreElements(): boolean;
    getNext(): LocalFile;
    close?(): void;
  };
  permissions: number;
  initWithPath(path: string): void;
  exists(): boolean;
  isDirectory(): boolean;
  create(type: number, permissions: number): void;
  moveTo(parent: LocalFile | null, name: string): void;
  readonly diskSpaceAvailable: number;
  /** lstat: true for a link, dangling or not. Throws when nothing is at the path. */
  isSymlink(): boolean;
  isFile(): boolean;
  /** Resolves every link (realpath). A path that does not exist is left as it is. */
  normalize(): void;
  /** Throws where the platform's file manager cannot select a file. */
  reveal(): void;
  launch(): void;
  remove(recursive: boolean): void;
}
interface FileInputStream extends InputStream {
  init(file: LocalFile, ioFlags: number, perm: number, behaviorFlags: number): void;
}
interface MultiplexInputStream extends InputStream {
  appendStream(stream: InputStream): void;
}
interface ArrayBufferInputStream extends InputStream {
  setData(buffer: ArrayBuffer, byteOffset: number, length: number): void;
}
interface AsyncStreamCopier {
  init(
    source: InputStream,
    sink: OutputStream,
    target: unknown,
    sourceBuffered: boolean,
    sinkBuffered: boolean,
    chunkSize: number,
    closeSource: boolean,
    closeSink: boolean,
  ): void;
  asyncCopy(observer: RequestObserver, context: null): void;
}
interface Timer {
  initWithCallback(callback: { notify(): void }, delayMs: number, type: number): void;
  cancel(): void;
}

interface XpcomClasses {
  "@mozilla.org/storagestream;1": StorageStream;
  "@mozilla.org/network/stream-listener-tee;1": StreamListenerTee;
  "@mozilla.org/network/file-output-stream;1": FileOutputStream;
  "@mozilla.org/network/file-input-stream;1": FileInputStream;
  "@mozilla.org/network/file-random-access-stream;1": FileRandomAccessStream;
  "@mozilla.org/file/local;1": LocalFile;
  "@mozilla.org/io/multiplex-input-stream;1": MultiplexInputStream;
  "@mozilla.org/io/arraybuffer-input-stream;1": ArrayBufferInputStream;
  "@mozilla.org/network/async-stream-copier;1": AsyncStreamCopier;
  "@mozilla.org/timer;1": Timer;
  "@mozilla.org/binaryinputstream;1": BinaryInputStream;
  "@mozilla.org/intl/converter-output-stream;1": ConverterOutputStream;
  "@mozilla.org/security/hash;1": CryptoHash;
  "@mozilla.org/filepicker;1": FilePicker;
}

/** nsIFilePicker in folder mode. `open` calls back with returnOK, returnCancel or returnReplace. */
interface FilePicker {
  init(parent: unknown, title: string, mode: number): void;
  open(done: (result: number) => void): void;
  readonly file: LocalFile;
}

interface ConverterOutputStream {
  init(stream: OutputStream, charset: string): void;
  /** false when not every character was written. */
  writeString(text: string): boolean;
  flush(): void;
  close(): void;
}

interface CryptoHash {
  init(algorithm: number): void;
  update(bytes: Uint8Array, length: number): void;
  /** The digest, as a string of byte values when `base64` is false. */
  finish(base64: boolean): string;
}

interface BinaryInputStream {
  setInputStream(stream: InputStream): void;
  readArrayBuffer(count: number, buffer: ArrayBuffer): number;
  readByteArray(count: number): number[];
}

/** What `asyncConvertData` returns: a listener that takes the coded bytes. Request arguments may be null. */
interface StreamConverter {
  onStartRequest(request: null): void;
  onDataAvailable(request: null, stream: InputStream, offset: number, count: number): void;
  onStopRequest(request: null, status: number): void;
}

declare const Cc: {
  readonly [Contract in keyof XpcomClasses]: {
    createInstance(iface: XpcomInterface): XpcomClasses[Contract];
  };
} & {
  readonly "@mozilla.org/network/stream-transport-service;1": {
    getService(iface: XpcomInterface): unknown;
  };
  readonly "@mozilla.org/security/random-generator;1": {
    getService(iface: XpcomInterface): { generateRandomBytes(length: number): number[] };
  };
  readonly "@mozilla.org/streamConverters;1": {
    getService(iface: XpcomInterface): {
      asyncConvertData(from: string, to: string, listener: object, context: null): StreamConverter;
    };
  };
  readonly "@mozilla.org/widget/clipboardhelper;1": {
    getService(iface: XpcomInterface): { copyString(text: string): void };
  };
};

declare const Ci: {
  readonly nsIHttpChannel: XpcomInterface;
  readonly nsIHttpChannelInternal: XpcomInterface;
  readonly nsITraceableChannel: XpcomInterface;
  readonly nsITimedChannel: XpcomInterface;
  readonly nsIUploadChannel: XpcomInterface;
  readonly nsIStorageStream: XpcomInterface;
  readonly nsIStreamListenerTee: XpcomInterface;
  readonly nsIFileOutputStream: XpcomInterface;
  readonly nsIFileInputStream: XpcomInterface;
  readonly nsIFileURL: XpcomInterface;
  readonly nsIFile: XpcomInterface;
  readonly nsIMultiplexInputStream: XpcomInterface;
  readonly nsIArrayBufferInputStream: XpcomInterface;
  readonly nsIAsyncStreamCopier: XpcomInterface;
  readonly nsIEventTarget: XpcomInterface;
  readonly nsIInputStream: XpcomInterface;
  readonly nsISeekableStream: XpcomInterface & {
    readonly NS_SEEK_SET: number;
    readonly NS_SEEK_END: number;
  };
  readonly nsIFileRandomAccessStream: XpcomInterface;
  readonly nsIFileMetadata: XpcomInterface;
  readonly nsIOutputStream: XpcomInterface;
  readonly nsISubstitutingProtocolHandler: XpcomInterface;
  readonly nsIRandomGenerator: XpcomInterface;
  readonly nsIBinaryInputStream: XpcomInterface;
  readonly nsIStreamConverterService: XpcomInterface;
  readonly nsIClipboardHelper: XpcomInterface;
  readonly nsIConverterOutputStream: XpcomInterface;
  readonly nsICryptoHash: XpcomInterface & { readonly SHA256: number };
  readonly nsITimer: XpcomInterface & {
    readonly TYPE_ONE_SHOT: number;
    readonly TYPE_REPEATING_SLACK: number;
  };
  readonly nsIChannel: XpcomInterface & { readonly DISPOSITION_ATTACHMENT: number };
  readonly nsIFilePicker: XpcomInterface & {
    readonly modeGetFolder: number;
    readonly returnOK: number;
  };
};

declare const Components: {
  isSuccessCode(status: number): boolean;
};

interface Observer {
  observe(subject: unknown, topic: string, data: string | null): void;
}

interface SubstitutingProtocolHandler {
  hasSubstitution(root: string): boolean;
  /** `null` removes the substitution. */
  setSubstitution(root: string, base: Uri | null): void;
  getSubstitution(root: string): Uri;
  resolveURI(uri: Uri): string;
}

interface FileDirectoryService {
  get(key: string, iface: XpcomInterface): LocalFile;
}

declare const Services: {
  readonly appinfo: {
    readonly name: string;
    readonly version: string;
    readonly appBuildID: string;
    readonly OS: string;
  };
  readonly sysinfo: { getProperty(name: "arch"): string };
  readonly obs: {
    addObserver(observer: Observer, topic: string): void;
    removeObserver(observer: Observer, topic: string): void;
  };
  readonly prefs: {
    getBoolPref(name: string, fallback: boolean): boolean;
    getIntPref(name: string, fallback: number): number;
    getStringPref(name: string, fallback: string): string;
  };
  readonly env: {
    get(name: string): string;
    exists(name: string): boolean;
  };
  readonly dirsvc: FileDirectoryService;
  readonly tm: { dispatchToMainThread(run: () => void): void };
  readonly wm: {
    /** A browser window's own browsing context is what nsIFilePicker.init takes as its parent. */
    getMostRecentWindow(type: "navigator:browser"): { readonly browsingContext: unknown } | null;
  };
  readonly eTLD: {
    getBaseDomainFromHost(host: string): string;
  };
  readonly io: {
    newURI(spec: string): Uri;
    getProtocolHandler(scheme: string): {
      QueryInterface(iface: XpcomInterface): SubstitutingProtocolHandler;
    };
  };
};

interface DevToolsLongStringGrip {
  readonly type: "longString";
  readonly actor: string;
  readonly initial: string;
  readonly length: number;
}

interface DevToolsStackFrame {
  readonly filename?: string;
  readonly functionName?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly asyncCause?: string | null;
}

interface DevToolsWsMessage {
  readonly type: string;
  readonly timeStamp: number;
  readonly opCode: number;
  readonly payload: unknown;
}

interface DevToolsResponseContentPacket {
  readonly content?: {
    readonly mimeType?: string;
    readonly text?: string | DevToolsLongStringGrip;
    readonly size?: number;
    readonly encoding?: string;
  };
  readonly contentDiscarded?: boolean;
}

interface DevToolsRequestItem {
  readonly id: string;
  readonly resourceId?: number | string;
  readonly url: string;
  readonly method: string;
  readonly startedMs: number;
  readonly httpVersion?: string;
  readonly status?: number | string;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly contentSize?: number;
  readonly transferredSize?: number;
  readonly totalTime?: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number | string;
  readonly securityState?: string;
  readonly priority?: number;
  readonly fromCache?: boolean | string;
  readonly fromServiceWorker?: boolean;
  readonly blockedReason?: string | number | boolean | null;
  readonly isNavigationRequest?: boolean;
  readonly isXHR?: boolean;
  readonly truncated?: boolean;
  readonly cause?: {
    readonly type?: string;
    readonly loadingDocumentUri?: string | null;
    readonly stacktraceAvailable?: boolean;
  };
  readonly stacktrace?: readonly DevToolsStackFrame[];
  readonly responseContent?: DevToolsResponseContentPacket;
  readonly responseContentAvailable?: boolean;
  readonly requestPostData?: { readonly postDataDiscarded?: boolean };
  readonly requestPostDataAvailable?: boolean;
  readonly eventTimings?: { readonly timings?: Record<string, unknown> };
  readonly requestHeaders?: {
    readonly headers?: readonly { readonly name: string; readonly value: unknown }[];
    readonly headersSize?: number;
  };
  readonly responseHeaders?: {
    readonly headers?: readonly { readonly name: string; readonly value: unknown }[];
    readonly headersSize?: number;
  };
}

interface DevToolsClient {
  request(packet: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface NetMonitorConnector {
  readonly currentTarget: { readonly url: string } | null | undefined;
  readonly commands?: { readonly client?: DevToolsClient };
  readonly dataProvider?: {
    readonly actionsEnabled?: boolean;
    readonly stackTraceRequestInfoByActorID?: ReadonlyMap<
      string,
      { readonly targetFront?: { isDestroyed?(): boolean } }
    >;
  };
  enableActions(enable: boolean): void;
  requestData(actorId: string, method: string): Promise<unknown>;
  getLongString(grip: unknown): Promise<string>;
  getTimingMarker?(name: string): number;
  getHarData?(): unknown;
}

interface NetMonitorApi {
  readonly store: {
    getState(): {
      readonly requests: { readonly requests: readonly DevToolsRequestItem[] };
      readonly messages?: {
        readonly messages?: ReadonlyMap<unknown, readonly DevToolsWsMessage[]>;
      };
    };
  };
  readonly connector: NetMonitorConnector;
}

interface DevToolsToolbox {
  readonly hostType: string;
  readonly commands?: { readonly descriptorFront?: { readonly localTab?: NativeTab } };
  getNetMonitorAPI(): Promise<NetMonitorApi>;
  getPanel?(
    id: string,
  ): { readonly panelWin?: { readonly Netmonitor?: { readonly api?: NetMonitorApi } } } | undefined;
}

interface HarBuilderModule {
  readonly HarBuilder: new (options: {
    readonly connector: NetMonitorConnector;
    readonly id: number;
    readonly includeResponseBodies: boolean;
    readonly items: readonly DevToolsRequestItem[];
    readonly supportsMultiplePages: boolean;
  }) => {
    build(): Promise<{ readonly log: { readonly entries: readonly Record<string, unknown>[] } }>;
  };
}

interface ShutdownPhase {
  /** Throws when the phase has already begun. */
  addBlocker(name: string, condition: Promise<unknown>): void;
}

interface NetUtilModule {
  readInputStream(stream: InputStream, count: number): ArrayBuffer;
  readInputStreamToString(
    stream: InputStream,
    count: number,
    options?: { readonly charset?: string },
  ): string;
}

interface GeckoModules {
  "chrome://devtools-startup/content/DevToolsShim.sys.mjs": {
    readonly DevToolsShim: {
      isInitialized(): boolean;
      getToolboxes(): readonly DevToolsToolbox[];
      on(event: "toolbox-ready", listener: (toolbox: DevToolsToolbox) => void): void;
      off(event: "toolbox-ready", listener: (toolbox: DevToolsToolbox) => void): void;
    };
  };
  "resource://devtools/shared/loader/Loader.sys.mjs": {
    require(id: "resource://devtools/client/framework/devtools.js"): {
      readonly gDevTools: { getToolboxForTab(tab: NativeTab): DevToolsToolbox | undefined };
    };
    require(id: "resource://devtools/client/netmonitor/src/har/har-builder.js"): HarBuilderModule;
  };
  "resource://gre/modules/NetUtil.sys.mjs": { readonly NetUtil: NetUtilModule };
  "resource://gre/modules/Downloads.sys.mjs": {
    readonly Downloads: { getPreferredDownloadsDirectory(): Promise<string> };
  };
  "resource://gre/modules/ExtensionUtils.sys.mjs": {
    readonly ExtensionUtils: { readonly ExtensionError: new (message: string) => Error };
  };
  "resource://gre/modules/AsyncShutdown.sys.mjs": {
    readonly AsyncShutdown: {
      readonly profileBeforeChange: ShutdownPhase;
      readonly sendTelemetry: ShutdownPhase;
    };
  };
}

declare const ChromeUtils: {
  importESModule<Url extends keyof GeckoModules>(url: Url): GeckoModules[Url];
  getXPCOMErrorName(status: number): string;
  now(): number;
  generateQI(interfaces: readonly string[]): unknown;
};

interface IOUtilsStat {
  readonly type: "regular" | "directory" | "other";
  readonly size: number;
  readonly permissions: number;
  readonly lastModified?: number;
}

declare const IOUtils: {
  read(
    path: string,
    options?: { readonly maxBytes?: number; readonly offset?: number },
  ): Promise<Uint8Array>;
  readUTF8(path: string): Promise<string>;
  write(
    path: string,
    data: Uint8Array,
    options?: {
      readonly mode?: "overwrite" | "append" | "appendOrCreate" | "create";
      readonly tmpPath?: string;
    },
  ): Promise<number>;
  writeUTF8(
    path: string,
    text: string,
    options?: {
      readonly mode?: "overwrite" | "append" | "appendOrCreate" | "create";
      readonly tmpPath?: string;
    },
  ): Promise<number>;
  move(from: string, to: string, options?: { readonly noOverwrite?: boolean }): Promise<void>;
  remove(
    path: string,
    options?: { readonly recursive?: boolean; readonly ignoreAbsent?: boolean },
  ): Promise<void>;
  makeDirectory(
    path: string,
    options?: {
      readonly createAncestors?: boolean;
      readonly ignoreExisting?: boolean;
      readonly permissions?: number;
    },
  ): Promise<void>;
  setPermissions(path: string, permissions: number): Promise<void>;
  stat(path: string): Promise<IOUtilsStat>;
  exists(path: string): Promise<boolean>;
  getChildren(path: string, options?: { readonly ignoreAbsent?: boolean }): Promise<string[]>;
};

declare const PathUtils: {
  join(...segments: string[]): string;
  filename(path: string): string;
  parent(path: string): string | null;
  readonly profileDir: string;
};

/** A worker with js-ctypes, started only from a chrome or resource URL. */
declare class ChromeWorker {
  constructor(url: string);
  onmessage: ((event: { readonly data: never }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  terminate(): void;
}
