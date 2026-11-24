import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import {
  buildHarEntry,
  type BuildHarEntryInput,
  type BuildHarRequestInput,
  type BuildHarResponseInput,
} from "@hark/har/build";
import { isoDateTimeFromEpochMs, toHarUrl, type HarEntry } from "@hark/har/model";
import {
  exchangeId,
  parsePositiveMinutes,
  toMinute,
  type ByteCount,
  type ChannelKey,
  type EpochMs,
  type RunId,
  type Site,
} from "@hark/recording/ids";
import type { MissingReason } from "../src/missing.ts";
import type { RedactionChoice } from "../src/redaction.ts";
import { WriteRefused, runExport, type ExportPorts } from "../src/run.ts";
import { resolveSelection } from "../src/selection.ts";
import type {
  BodyCandidates,
  BodySource,
  ExchangeSource,
  Material,
  SourceItem,
  SourceName,
  SourceRef,
} from "../src/source.ts";
import type { ExportReport } from "../src/report.ts";

const FAKE_RUN = "run01" as RunId;
const FAKE_T0 = 1_794_800_040_000;

/** How a fake reader serves one body. */
export type BodySpec =
  | {
      readonly kind: "bytes";
      readonly data: Uint8Array;
      readonly coding?: "gzip" | "deflate" | "br" | null;
      readonly chunk?: number;
      readonly failAt?: number;
      readonly check?: "length-matched" | "sink-only" | "first-part" | "scan-timeout";
    }
  | { readonly kind: "text"; readonly slices: readonly string[]; readonly failAt?: number }
  | { readonly kind: "base64"; readonly slices: readonly string[] }
  | {
      readonly kind: "generated";
      readonly total: number;
      readonly chunk: number;
      readonly seed: number;
    }
  | { readonly kind: "open-fails"; readonly reason: MissingReason }
  | { readonly kind: "open-throws" };

/** One spec, several candidates tried in order, a listed reason, or no body. */
export type BodyField =
  | BodySpec
  | readonly [BodySpec, ...BodySpec[]]
  | { readonly none: MissingReason }
  | "empty";

/** Everything one source knows about a request except its bodies. Unset fields take the fake's defaults. */
export type SideEntry = {
  readonly request?: Partial<BuildHarRequestInput>;
  readonly response?: Partial<BuildHarResponseInput>;
  readonly timings?: BuildHarEntryInput["timings"];
  readonly [field: string]: unknown;
};

export interface SideRow {
  readonly entry?: SideEntry;
  readonly body?: BodyField;
  readonly upload?: BodyField;
  readonly inProgress?: boolean;
  readonly loadThrows?: boolean;
}

export interface FakeRow {
  readonly id: number;
  readonly url: string;
  readonly method?: string;
  readonly startedAt?: number;
  readonly navigation?: boolean;
  readonly tab?: number | null;
  /** null: the row has no key and cannot pair. */
  readonly key?: string | null;
  readonly run?: RunId;
  readonly recording?: SideRow;
  readonly devtools?: SideRow;
  /** A live copy of this row listed before it under the same key, to test the duplicate rule. */
  readonly listedTwice?: SourceName;
}

function fakeSelection() {
  const m0 = toMinute(FAKE_T0 as EpochMs);
  return resolveSelection(
    {
      scope: "everything",
      range: { kind: "last", minutes: parsePositiveMinutes(15)! },
      include: "all",
    },
    { now: m0, localMidnight: m0, tab: null, tabFirstSeen: null, devtoolsFirst: null },
  );
}

function wire(data: Uint8Array, coding: "gzip" | "deflate" | "br" | null | undefined): Uint8Array {
  if (coding === "gzip") return new Uint8Array(NodeZlib.gzipSync(data));
  if (coding === "deflate") return new Uint8Array(NodeZlib.deflateSync(data));
  if (coding === "br") return new Uint8Array(NodeZlib.brotliCompressSync(data));
  return data;
}

function nodeDecode(coding: string, chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const make =
    coding === "gzip"
      ? NodeZlib.createGunzip
      : coding === "deflate"
        ? NodeZlib.createInflate
        : coding === "br"
          ? NodeZlib.createBrotliDecompress
          : null;
  if (make === null) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw new Error(`unknown coding ${coding}`);
      },
    };
  }
  return {
    async *[Symbol.asyncIterator]() {
      for await (const out of NodeStream.Readable.from(chunks).pipe(make())) {
        yield new Uint8Array(out as Buffer);
      }
    },
  };
}

/** Deterministic bytes that are not one repeated buffer, so an encoder cannot take a shortcut on them. */
export function generatedChunk(seed: number, index: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed * 2_654_435_761 + index * 40_503 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

function baseEntry(row: FakeRow, side: SideRow): HarEntry {
  const e = side.entry ?? {};
  return buildHarEntry({
    ...e,
    startedDateTime: isoDateTimeFromEpochMs(row.startedAt ?? FAKE_T0 + row.id),
    request: {
      method: row.method ?? "GET",
      url: toHarUrl(row.url) ?? (row.url as never),
      httpVersion: "HTTP/1.1",
      ...e.request,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      content: { size: -1, mimeType: "text/plain" },
      ...e.response,
    },
    timings: { send: 1, wait: 2, receive: 3, ...e.timings },
  });
}

/** The fake export's random file id. */
export const FAKE_FILE_ID = "5f0e6c1d9a8b47e2b3c4d5e6f7a8b9c0";

export interface FakeEnv {
  readonly rows: readonly FakeRow[];
  readonly redaction?: RedactionChoice;
  readonly bodies?: "include" | "omit";
  readonly listThrows?: SourceName;
  readonly notNetwork?: { readonly [S in SourceName]?: Record<string, number> };
  readonly sinkFailsAt?: { readonly write: number; readonly kind: "refused" | "error" };
  /** Called at every await point the fakes control: each chunk read, sink write, progress and yield. */
  readonly onPoint?: (point: number) => void;
  readonly signal?: { aborted: boolean; reason?: unknown };
  readonly portsThrow?: { readonly onProgress?: boolean; readonly yieldNow?: boolean };
  readonly keepText?: boolean;
  readonly onWrite?: (text: string) => void;
  /** The sources offer bodies even when load is asked for none, as a source may. */
  readonly ignoreBodyOption?: boolean;
  /** An altered copy of runExport, from importAltered. */
  readonly runExport?: typeof runExport;
}

export interface FakeResult {
  readonly report: ExportReport | null;
  readonly error: unknown;
  readonly text: string;
  readonly bytes: number;
  readonly writes: number;
  readonly digest: string;
  readonly points: number;
}

export async function runFake(env: FakeEnv): Promise<FakeResult> {
  const specs = new Map<object, BodySpec>();
  const parts: string[] = [];
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let writes = 0;
  let points = 0;
  const point = (): void => {
    points += 1;
    env.onPoint?.(points);
  };
  const signal = env.signal ?? { aborted: false };

  const candidates = (
    field: BodyField | undefined,
    side: SourceName,
    id: number,
  ): BodyCandidates => {
    if (field === undefined || field === "empty") return { kind: "empty" };
    if ("none" in field) return { kind: "none", reason: field.none };
    const list = (Array.isArray(field) ? field : [field]) as readonly BodySpec[];
    return { kind: "candidates", list: list.map((spec) => candidate(spec, side, id)) as never };
  };

  const candidate = (field: BodySpec, side: SourceName, id: number): BodySource => {
    const handle = { side, id };
    specs.set(handle, field);
    return field.kind === "text" || field.kind === "base64"
      ? {
          kind: "devtools",
          ref: handle as never,
          encoding: field.kind === "base64" ? "base64" : null,
          length: 0,
        }
      : {
          kind: "stored",
          at: handle as never,
          wireEncoding: field.kind === "bytes" ? (field.coding ?? null) : null,
          check: field.kind === "bytes" ? (field.check ?? "length-matched") : "length-matched",
        };
  };

  const item = (row: FakeRow, source: SourceName, side: SideRow): SourceItem => {
    const startedAt = (row.startedAt ?? FAKE_T0 + row.id) as EpochMs;
    return {
      source,
      key:
        row.key === null
          ? null
          : exchangeId(row.run ?? FAKE_RUN, (row.key ?? String(row.id)) as ChannelKey),
      startedAt,
      startedMinute: toMinute(startedAt),
      url: row.url,
      method: row.method ?? "GET",
      tab: row.tab === null || row.tab === undefined ? null : { run: FAKE_RUN, browserId: row.tab },
      site: "example.com" as Site,
      navigation: row.navigation ?? false,
      fetchOrXhr: false,
      inProgress: side.inProgress ?? false,
      ref: { row, side } as unknown as SourceRef,
    };
  };

  const source = (name: SourceName): ExchangeSource => ({
    name,
    async list() {
      if (env.listThrows === name) throw new Error("list failed");
      const items: SourceItem[] = [];
      for (const row of env.rows) {
        const side = row[name];
        if (side === undefined) continue;
        if (row.listedTwice === name) items.push(item(row, name, { ...side, inProgress: true }));
        items.push(item(row, name, side));
      }
      return { items, notNetwork: env.notNetwork?.[name] ?? {} };
    },
    async load(listed, opts) {
      const { row, side } = listed.ref as unknown as { row: FakeRow; side: SideRow };
      if (side.loadThrows === true) throw new Error("load failed");
      const material: Material = {
        entry: baseEntry(row, side),
        body:
          opts.body || env.ignoreBodyOption === true
            ? candidates(side.body, name, row.id)
            : { kind: "none", reason: "omitted-by-choice" },
        upload: candidates(side.upload, name, row.id),
      };
      return material;
    },
  });

  const ports: ExportPorts = {
    recording: source("recording"),
    devtools: source("devtools"),
    bodies: {
      async open(candidate) {
        const spec = specs.get(
          (candidate.kind === "stored" ? candidate.at : candidate.ref) as object,
        )!;
        if (spec.kind === "open-fails") return { ok: false, reason: spec.reason };
        if (spec.kind === "open-throws") throw new Error("open threw");
        if (spec.kind === "text" || spec.kind === "base64") {
          const failAt = spec.kind === "text" ? spec.failAt : undefined;
          return {
            ok: true,
            body: {
              kind: "text",
              encoding: spec.kind === "base64" ? "base64" : null,
              chunks: (async function* () {
                for (let n = 0; n < spec.slices.length; n += 1) {
                  if (n === failAt) throw new Error("slice read failed");
                  point();
                  yield spec.slices[n]!;
                }
              })(),
            },
          };
        }
        if (spec.kind === "generated") {
          return {
            ok: true,
            body: {
              kind: "bytes",
              wireEncoding: null,
              chunks: (async function* () {
                for (let at = 0, n = 0; at < spec.total; at += spec.chunk, n += 1) {
                  point();
                  yield generatedChunk(spec.seed, n, Math.min(spec.chunk, spec.total - at));
                }
              })(),
            },
          };
        }
        const data = wire(spec.data, spec.coding);
        const chunk = spec.chunk ?? 7;
        return {
          ok: true,
          body: {
            kind: "bytes",
            wireEncoding: spec.coding ?? null,
            chunks: (async function* () {
              let n = 0;
              for (let at = 0; at < data.length; at += chunk, n += 1) {
                if (n === spec.failAt) throw new Error("read failed");
                point();
                yield data.subarray(at, at + chunk);
              }
              if (n === spec.failAt) throw new Error("read failed at the end");
            })(),
          },
        };
      },
    },
    sink: {
      async write(text) {
        writes += 1;
        point();
        if (env.sinkFailsAt?.write === writes) {
          if (env.sinkFailsAt.kind === "error") throw new Error("disk exploded");
          throw new WriteRefused({
            kind: "disk-full",
            needBytes: 1 as ByteCount,
            freeBytes: 0 as ByteCount,
          });
        }
        bytes += Buffer.byteLength(text, "utf8");
        if (env.keepText === false) hash.update(text);
        else parts.push(text);
        env.onWrite?.(text);
      },
      bytesWritten: () => bytes as ByteCount,
    },
    creator: { name: "Hark", version: "0.0.0-test" },
    fileId: FAKE_FILE_ID,
    decode: nodeDecode,
    yieldNow: async () => {
      point();
      if (env.portsThrow?.yieldNow === true) throw new Error("yield threw");
    },
    onProgress: () => {
      if (env.portsThrow?.onProgress === true) throw new Error("progress threw");
    },
    signal,
  };

  let report: ExportReport | null = null;
  let error: unknown = null;
  try {
    report = await (env.runExport ?? runExport)(
      {
        selection: {
          scope: "everything",
          range: { kind: "last", minutes: parsePositiveMinutes(15)! },
          include: "all",
        },
        bodies: env.bodies ?? "include",
        redaction: env.redaction ?? "none",
        packaging: "har",
        fileName: null,
      },
      fakeSelection(),
      ports,
    );
  } catch (err) {
    error = err;
  }
  return {
    report,
    error,
    text: parts.join(""),
    bytes,
    writes,
    digest: hash.digest("hex"),
    points,
  };
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export function sha256(bytes: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/** The bytes a written text field holds, read from the file alone. */
export function writtenBytes(field: {
  readonly text?: string | null | undefined;
  readonly encoding?: string | undefined;
}): Uint8Array {
  if (field.text === undefined || field.text === null) return new Uint8Array(0);
  return field.encoding === "base64"
    ? new Uint8Array(Buffer.from(field.text, "base64"))
    : utf8(field.text);
}
