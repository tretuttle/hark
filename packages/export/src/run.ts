// The export itself, host-neutral: both hosts call runExport with their own ports, and Node tests call it with fakes.

import type { PageId } from "@hark/har/model";
import type { BodyCheck } from "@hark/recording/exchange";
import type { ByteCount } from "@hark/recording/ids";
import {
  base64Stream,
  bytesFromBase64Slices,
  bytesFromTextSlices,
  charsetOf,
  chooseEncoding,
} from "./body.ts";
import {
  NO_BODY,
  buildEntry,
  missingBody,
  splitAtSentinel,
  streamSentinel,
  type BodyWrite,
} from "./entry-writer.ts";
import type { ExportRequest, WriteFailure } from "./jobs.ts";
import {
  devtoolsBodyWanted,
  mergeEntry,
  pairItems,
  stubMaterial,
  type MergedEntry,
  type Pair,
} from "./merge.ts";
import type { MissingReason } from "./missing.ts";
import { finishPages, pageFor, startPages } from "./pages.ts";
import { documentRedaction, type DocumentRedaction, type LogFields } from "./redaction.ts";
import { emptyReport, reportComment, tally, type ExportReport } from "./report.ts";
import type { ResolvedSelection } from "./selection.ts";
import {
  classifyUrl,
  type AbortSignalLike,
  type BodyCandidates,
  type BodyChunks,
  type BodyReader,
  type BodySource,
  type ExchangeSource,
  type Material,
  type SourceItem,
  type SourceListing,
  type SourceName,
} from "./source.ts";

const BODY_CHUNK_BYTES = 3 * 1_048_576;
/**
 * A body up to this size is read whole before any of it is written, so its encoding is decided on all its bytes and
 * it is redacted inside its entry. A longer response body streams as base64; a longer request body is cut here.
 */
export const BODY_WINDOW_BYTES = BODY_CHUNK_BYTES;

/** Where the document goes. The host's sink batches writes and owns the .part file and its rename. */
export interface HarSink {
  write(text: string): Promise<void>;
  readonly bytesWritten: () => ByteCount;
}

/**
 * Thrown by a sink when the file system refuses. A failing sink is the only port failure that fails the export;
 * every other port that throws becomes a loss written into the file and counted in the report.
 */
export class WriteRefused extends Error {
  readonly failure: WriteFailure;

  constructor(failure: WriteFailure, message?: string) {
    super(message ?? failure.kind);
    this.name = "WriteRefused";
    this.failure = failure;
  }
}

export interface ExportPorts {
  readonly recording: ExchangeSource;
  readonly devtools: ExchangeSource;
  readonly bodies: BodyReader;
  readonly sink: HarSink;
  readonly creator: { readonly name: string; readonly version: string };
  /**
   * Random, and written in the document's first bytes as `log._harExportId`, so a file on disk can be proved to be
   * this export's own before it is deleted.
   */
  readonly fileId: string;
  /** Wire-encoded bytes to decoded bytes, chunk by chunk (gzip, deflate, br, zstd). */
  readonly decode: (
    encoding: string,
    chunks: AsyncIterable<Uint8Array>,
  ) => AsyncIterable<Uint8Array>;
  readonly yieldNow: () => Promise<void>;
  readonly onProgress: (p: {
    readonly done: number;
    readonly total: number;
    readonly bytes: ByteCount;
  }) => void;
  readonly signal: AbortSignalLike;
}

function throwIfAborted(signal: AbortSignalLike): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const err = new Error("Export aborted");
  err.name = "AbortError";
  throw err;
}

/** A port call that may throw. An abort and a sink refusal pass through; anything else is reported as a loss. */
async function attempt<T>(
  signal: AbortSignalLike,
  call: () => Promise<T> | T,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    throwIfAborted(signal);
    if (err instanceof WriteRefused) throw err;
    return { ok: false };
  }
}

function networkItems(listing: SourceListing, notNetwork: Record<string, number>): SourceItem[] {
  for (const [scheme, count] of Object.entries(listing.notNetwork)) {
    if (count > 0) notNetwork[scheme] = (notNetwork[scheme] ?? 0) + count;
  }
  const kept: SourceItem[] = [];
  for (const item of listing.items) {
    const kind = classifyUrl(item.url);
    if (kind.kind === "network") {
      kept.push(item);
    } else {
      const key = kind.kind === "not-network" ? kind.scheme : "malformed";
      notNetwork[key] = (notNetwork[key] ?? 0) + 1;
    }
  }
  return kept;
}

function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One opened body as decoded bytes, whatever shape its reader gave. */
interface OpenBody {
  readonly chunks: AsyncIterator<Uint8Array>;
  readonly charset: string | null;
  readonly from: "stored" | "devtools";
  readonly check: BodyCheck | null;
  readonly wireBytes: () => number | null;
  readonly lossy: () => number;
}

function asBytes(
  body: BodyChunks,
  candidate: BodySource,
  mimeType: string,
  ports: ExportPorts,
): OpenBody {
  const from = candidate.kind === "stored" ? "stored" : "devtools";
  const check = candidate.kind === "stored" ? candidate.check : null;
  if (body.kind === "bytes") {
    let wire = 0;
    const raw = body.chunks;
    const counted: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of raw) {
          wire += chunk.byteLength;
          yield chunk;
        }
      },
    };
    const decoded = body.wireEncoding === null ? counted : ports.decode(body.wireEncoding, counted);
    return {
      chunks: decoded[Symbol.asyncIterator](),
      charset: charsetOf(mimeType),
      from,
      check,
      wireBytes: () => (from === "stored" ? wire : null),
      lossy: () => 0,
    };
  }
  if (body.encoding === "base64") {
    return {
      chunks: bytesFromBase64Slices(body.chunks)[Symbol.asyncIterator](),
      charset: charsetOf(mimeType),
      from,
      check,
      wireBytes: () => null,
      lossy: () => 0,
    };
  }
  const text = bytesFromTextSlices(body.chunks);
  return {
    chunks: text.bytes[Symbol.asyncIterator](),
    charset: "utf-8",
    from,
    check,
    wireBytes: () => null,
    lossy: text.lossy,
  };
}

async function openBody(
  candidates: readonly BodySource[],
  mimeType: string,
  ports: ExportPorts,
): Promise<
  | { readonly ok: true; readonly body: OpenBody }
  | { readonly ok: false; readonly reason: MissingReason }
> {
  let reason: MissingReason = "source-error";
  for (const candidate of candidates) {
    throwIfAborted(ports.signal);
    const opened = await attempt(ports.signal, () =>
      ports.bodies.open(candidate, BODY_CHUNK_BYTES, ports.signal),
    );
    if (!opened.ok) {
      reason = "source-error";
    } else if (!opened.value.ok) {
      reason = opened.value.reason;
    } else {
      return { ok: true, body: asBytes(opened.value.body, candidate, mimeType, ports) };
    }
  }
  return { ok: false, reason };
}

type Step =
  | { readonly kind: "chunk"; readonly bytes: Uint8Array }
  | { readonly kind: "end" | "failed" };

async function nextChunk(body: OpenBody, signal: AbortSignalLike): Promise<Step> {
  throwIfAborted(signal);
  const step = await attempt(signal, () => body.chunks.next());
  if (!step.ok) return { kind: "failed" };
  if (step.value.done === true) return { kind: "end" };
  return { kind: "chunk", bytes: step.value.value };
}

/** Reads until the body ends, fails, or passes `limit` bytes. */
async function readWindow(
  body: OpenBody,
  limit: number,
  signal: AbortSignalLike,
): Promise<{ readonly bytes: Uint8Array; readonly ended: "end" | "failed" | "more" }> {
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total <= limit) {
    const step = await nextChunk(body, signal);
    if (step.kind !== "chunk") return { bytes: concatBytes(parts, total), ended: step.kind };
    if (step.bytes.byteLength === 0) continue;
    parts.push(step.bytes);
    total += step.bytes.byteLength;
  }
  return { bytes: concatBytes(parts, total), ended: "more" };
}

function wholeWrite(body: OpenBody, bytes: Uint8Array, ended: "end" | "failed"): BodyWrite {
  if (ended === "failed" && bytes.length === 0) {
    return missingBody({ kind: "missing", reason: "source-error" });
  }
  if (
    ended === "end" &&
    bytes.length === 0 &&
    body.check !== "first-part" &&
    body.check !== "scan-timeout"
  ) {
    return NO_BODY;
  }
  const written = chooseEncoding(bytes, body.charset);
  const outcome =
    ended === "failed"
      ? ({ kind: "cut-short", reason: "source-error", lossy: body.lossy() } as const)
      : body.check === "first-part"
        ? ({ kind: "cut-short", reason: "over-body-cap", lossy: body.lossy() } as const)
        : body.check === "scan-timeout"
          ? ({ kind: "cut-short", reason: "scan-timeout", lossy: body.lossy() } as const)
          : ({
              kind: "included",
              from: body.from,
              unchecked: body.check === "sink-only",
              lossy: body.lossy(),
            } as const);
  return {
    outcome,
    text: written.text,
    encoding: written.encoding,
    size: bytes.length,
    wireBytes: body.wireBytes(),
    check: body.check,
  };
}

function withRequestChoice(candidates: BodyCandidates, request: ExportRequest): BodyCandidates {
  return request.bodies === "omit" && candidates.kind === "candidates"
    ? { kind: "none", reason: "omitted-by-choice" }
    : candidates;
}

/** The request body is read whole, up to one window, because HAR 1.2 gives it no streamable place of its own. */
async function readUpload(
  merged: MergedEntry,
  request: ExportRequest,
  ports: ExportPorts,
): Promise<BodyWrite> {
  const upload = withRequestChoice(merged.upload, request);
  if (upload.kind === "empty") return NO_BODY;
  if (upload.kind === "none") return missingBody({ kind: "missing", reason: upload.reason });
  const mimeType = merged.entry.request.postData?.mimeType ?? "";
  const opened = await openBody(upload.list, mimeType, ports);
  if (!opened.ok) return missingBody({ kind: "missing", reason: opened.reason });
  const read = await readWindow(opened.body, BODY_WINDOW_BYTES, ports.signal);
  if (read.ended !== "more") return wholeWrite(opened.body, read.bytes, read.ended);
  await attempt(ports.signal, () => opened.body.chunks.return?.());
  const kept = read.bytes.subarray(0, BODY_WINDOW_BYTES);
  const written = chooseEncoding(kept, opened.body.charset);
  return {
    outcome: { kind: "cut-short", reason: "over-export-window", lossy: opened.body.lossy() },
    text: written.text,
    encoding: written.encoding,
    size: kept.length,
    wireBytes: null,
    check: opened.body.check,
  };
}

interface EntryContext {
  readonly merged: MergedEntry;
  readonly pageref: PageId;
  readonly upload: BodyWrite;
  readonly loadFailed: readonly SourceName[];
  readonly index: number;
  readonly prefix: string;
}

function entryJson(ctx: EntryContext, response: BodyWrite, redaction: DocumentRedaction): string {
  const entry = buildEntry(ctx.merged, ctx.pageref, response, ctx.upload, ctx.loadFailed);
  return JSON.stringify(redaction.entry(entry, ctx.index));
}

/**
 * A response body longer than one window. Its text is base64, decided before its first byte is written. A probe of
 * the entry, redacted but not counted, says whether the level keeps the text and gives the JSON before it; the entry
 * redacted once its body has ended gives the JSON after it, and must agree on the part already written.
 */
async function streamLongBody(
  ctx: EntryContext,
  body: OpenBody,
  first: Uint8Array,
  redaction: DocumentRedaction,
  ports: ExportPorts,
): Promise<BodyOutcomeWritten> {
  const placeholder = (sentinel: string): BodyWrite => ({
    outcome: { kind: "included", from: body.from, unchecked: false, lossy: 0 },
    text: sentinel,
    encoding: "base64",
    size: 0,
    wireBytes: null,
    check: body.check,
  });
  const preview = (text: string | null): string =>
    JSON.stringify(
      redaction.preview(
        buildEntry(
          ctx.merged,
          ctx.pageref,
          { ...placeholder(""), text },
          ctx.upload,
          ctx.loadFailed,
        ),
        ctx.index,
      ),
    );
  const bare = preview(null);
  let k = 0;
  while (bare.includes(JSON.stringify(streamSentinel(k)))) k += 1;
  const sentinel = streamSentinel(k);
  const hole = splitAtSentinel(preview(sentinel), sentinel);
  const encoder = base64Stream();
  if (hole !== null) await ports.sink.write(`${ctx.prefix}${hole.head}${encoder.push(first)}`);

  let size = first.length;
  let ended: "end" | "failed" = "end";
  for (;;) {
    const step = await nextChunk(body, ports.signal);
    if (step.kind !== "chunk") {
      ended = step.kind;
      break;
    }
    size += step.bytes.length;
    if (hole !== null) {
      const text = encoder.push(step.bytes);
      if (text.length > 0) await ports.sink.write(text);
    }
  }
  const outcome =
    ended === "failed"
      ? ({ kind: "cut-short", reason: "source-error", lossy: body.lossy() } as const)
      : body.check === "first-part"
        ? ({ kind: "cut-short", reason: "over-body-cap", lossy: body.lossy() } as const)
        : body.check === "scan-timeout"
          ? ({ kind: "cut-short", reason: "scan-timeout", lossy: body.lossy() } as const)
          : ({
              kind: "included",
              from: body.from,
              unchecked: body.check === "sink-only",
              lossy: body.lossy(),
            } as const);
  const write: BodyWrite = {
    outcome,
    text: sentinel,
    encoding: "base64",
    size,
    wireBytes: body.wireBytes(),
    check: body.check,
  };
  const json = entryJson(ctx, write, redaction);
  const done = splitAtSentinel(json, sentinel);
  if (hole === null) {
    if (done !== null) throw new Error("Redaction kept a body its probe removed.");
    await ports.sink.write(`${ctx.prefix}${json}`);
  } else {
    if (done?.head !== hole.head)
      throw new Error("Redaction changed the entry around a streamed body.");
    await ports.sink.write(`${encoder.end()}${done.tail}`);
  }
  return { outcome };
}

interface BodyOutcomeWritten {
  readonly outcome: BodyWrite["outcome"];
}

/** Writes the entry and returns what its response body ended as. */
async function writeEntry(
  ctx: EntryContext,
  request: ExportRequest,
  redaction: DocumentRedaction,
  ports: ExportPorts,
): Promise<BodyOutcomeWritten> {
  const body = withRequestChoice(ctx.merged.body, request);
  const writeWhole = async (response: BodyWrite): Promise<BodyOutcomeWritten> => {
    await ports.sink.write(`${ctx.prefix}${entryJson(ctx, response, redaction)}`);
    return { outcome: response.outcome };
  };
  if (body.kind === "empty") return writeWhole(NO_BODY);
  if (body.kind === "none")
    return writeWhole(missingBody({ kind: "missing", reason: body.reason }));
  const opened = await openBody(body.list, ctx.merged.entry.response.content.mimeType, ports);
  if (!opened.ok) return writeWhole(missingBody({ kind: "missing", reason: opened.reason }));
  const read = await readWindow(opened.body, BODY_WINDOW_BYTES, ports.signal);
  if (read.ended !== "more") return writeWhole(wholeWrite(opened.body, read.bytes, read.ended));
  return streamLongBody(ctx, opened.body, read.bytes, redaction, ports);
}

/** Both sides' material for a pair. A side whose load throws is left out and named; with no side left, a stub. */
async function loadPair(
  pair: Pair,
  request: ExportRequest,
  ports: ExportPorts,
): Promise<{
  readonly recording: Material | null;
  readonly devtools: Material | null;
  readonly loadFailed: readonly SourceName[];
}> {
  const includeBodies = request.bodies === "include";
  const loadFailed: SourceName[] = [];
  let recording: Material | null = null;
  if (pair.kind !== "devtools-only") {
    const loaded = await attempt(ports.signal, () =>
      ports.recording.load(pair.recording, { body: includeBodies }),
    );
    if (loaded.ok) recording = loaded.value;
    else loadFailed.push("recording");
  }
  let devtools: Material | null = null;
  if (pair.kind !== "recording-only") {
    const loaded = await attempt(ports.signal, () =>
      ports.devtools.load(pair.devtools, {
        body: includeBodies && devtoolsBodyWanted(pair, recording),
      }),
    );
    if (loaded.ok) devtools = loaded.value;
    else loadFailed.push("devtools");
  }
  if (recording === null && devtools === null) {
    recording = stubMaterial(pair.kind === "devtools-only" ? pair.devtools : pair.recording);
  }
  return { recording, devtools, loadFailed };
}

async function listSource(
  source: ExchangeSource,
  selection: ResolvedSelection,
  signal: AbortSignalLike,
): Promise<SourceListing | null> {
  const listed = await attempt(signal, () => source.list(selection));
  return listed.ok ? listed.value : null;
}

/**
 * Writes one complete HAR 1.2 document into ports.sink and returns what it wrote. Rejects only on an abort or when
 * the sink throws. Every other failure is a loss written into the file and counted in the report.
 */
export async function runExport(
  request: ExportRequest,
  selection: ResolvedSelection,
  ports: ExportPorts,
): Promise<ExportReport> {
  throwIfAborted(ports.signal);
  const [recListing, dtListing] = await Promise.all([
    listSource(ports.recording, selection, ports.signal),
    listSource(ports.devtools, selection, ports.signal),
  ]);
  throwIfAborted(ports.signal);

  const notNetwork: Record<string, number> = {};
  const empty: SourceListing = { items: [], notNetwork: {} };
  const recItems = networkItems(recListing ?? empty, notNetwork);
  const dtItems = networkItems(dtListing ?? empty, notNetwork);
  const listFailed: SourceName[] = [
    ...(recListing === null ? (["recording"] as const) : []),
    ...(dtListing === null ? (["devtools"] as const) : []),
  ];

  const { pairs, unpaired, duplicates } = pairItems(recItems, dtItems);
  let report = emptyReport(request.redaction, unpaired, duplicates, notNetwork, listFailed);
  const redaction = documentRedaction(request.redaction);
  let pageState = startPages();
  const progress = async (done: number): Promise<void> => {
    await attempt(ports.signal, () =>
      ports.onProgress({ done, total: pairs.length, bytes: ports.sink.bytesWritten() }),
    );
  };

  await progress(0);
  await ports.sink.write(`{"log":{"_harExportId":${JSON.stringify(ports.fileId)},"entries":[`);

  for (let index = 0; index < pairs.length; index += 1) {
    throwIfAborted(ports.signal);
    const pair = pairs[index]!;
    const loaded = await loadPair(pair, request, ports);
    throwIfAborted(ports.signal);
    const merged = mergeEntry(pair, loaded.recording, loaded.devtools);
    const page = pageFor(pageState, {
      tab: pair.kind === "devtools-only" ? pair.devtools.tab : pair.recording.tab,
      startedAt: pair.kind === "devtools-only" ? pair.devtools.startedAt : pair.recording.startedAt,
      navigation: merged.navigation,
      url: merged.entry.request.url,
    });
    pageState = page.state;
    const upload = await readUpload(merged, request, ports);
    const ctx: EntryContext = {
      merged,
      pageref: page.pageref,
      upload,
      loadFailed: loaded.loadFailed,
      index,
      prefix: index > 0 ? "," : "",
    };
    const written = await writeEntry(ctx, request, redaction, ports);
    report = tally(report, merged, {
      response: written.outcome,
      request: upload.outcome,
      loadFailed: loaded.loadFailed,
    });
    await progress(index + 1);
    await attempt(ports.signal, () => ports.yieldNow());
  }

  throwIfAborted(ports.signal);
  const fileReport = {
    ...report,
    redaction: { choice: request.redaction },
    fileBytes: ports.sink.bytesWritten(),
  };
  const log: LogFields = {
    version: "1.2",
    creator: { name: ports.creator.name, version: ports.creator.version },
    pages: finishPages(pageState),
    comment: reportComment(report),
    _harExport: { report: fileReport },
  };
  const finished = redaction.finish(log);
  await ports.sink.write(`],${JSON.stringify(finished.log).slice(1)}}`);
  return {
    ...report,
    redaction: { choice: request.redaction, report: finished.report },
    fileBytes: ports.sink.bytesWritten(),
  };
}
