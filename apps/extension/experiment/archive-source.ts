// The background recording as an export source: lines read back from the archive's segments, the recorder's live
// captures, and stored bodies read in chunks. System principal, parent process; nothing here leaves the host.

import { materialFromRecording } from "@hark/export/from-recording";
import { inSelection, type ResolvedSelection } from "@hark/export/selection";
import type {
  BodyReader,
  ExchangeSource,
  SourceItem,
  SourceListing,
  SourceRef,
} from "@hark/export/source";
import { segmentsFor, type ActivityIndex } from "@hark/recording/activity";
import {
  bodyAvailability,
  type BodyAvailability,
  type BodyLocation,
  type DiskInventory,
  type LiveExchange,
  type RequestFacts,
  type SettledExchange,
} from "@hark/recording/exchange";
import { toMinute, type ExchangeId, type PackId, type Site } from "@hark/recording/ids";
import { bodyFilePath, logSegmentPath, packPath, type SafeFolder } from "@hark/recording/layout";
import { decodeLine } from "@hark/recording/log";
import type { PinHandle, PinTargets } from "./maintenance.ts";

/** loadInfo.externalContentPolicyType: a top-level document, and XMLHttpRequest or fetch. */
const DOCUMENT_POLICY_TYPE = 6;
const FETCH_OR_XHR_POLICY_TYPES: readonly number[] = [11, 20];

type Held =
  | { readonly kind: "settled"; readonly settled: SettledExchange }
  | { readonly kind: "live"; readonly live: LiveExchange };

export interface ArchiveReads {
  readonly root: SafeFolder;
  readonly activity: ActivityIndex;
  /** Resolves when every line committed before the call is in a segment on disk. */
  readonly settle: () => Promise<void>;
  readonly enqueue: (task: () => Promise<void>) => Promise<void>;
  readonly pin: (targets: PinTargets) => PinHandle;
  readonly live: () => readonly { readonly site: Site | null; readonly live: LiveExchange }[];
}

export const itemOf = (
  request: RequestFacts,
  site: Site | null,
  inProgress: boolean,
  ref: number,
): SourceItem => ({
  source: "recording",
  key: request.id,
  startedAt: request.startedAt,
  startedMinute: toMinute(request.startedAt),
  url: request.url,
  method: request.method,
  tab: request.tab,
  site: request.topSite ?? site,
  navigation: request.policyType === DOCUMENT_POLICY_TYPE,
  fetchOrXhr: FETCH_OR_XHR_POLICY_TYPES.includes(request.policyType),
  inProgress,
  ref: ref as unknown as SourceRef,
});

const pathOf = (root: SafeFolder, at: BodyLocation): string =>
  PathUtils.join(root, ...(at.kind === "pack" ? packPath(at.pack) : bodyFilePath(at.site, at.id)));

const sizeOf = async (path: string): Promise<number | null> => {
  try {
    return (await IOUtils.stat(path)).size;
  } catch {
    return null;
  }
};

/** Sizes of the files these locations name, read once, so the pure availability rules answer synchronously. */
async function inventory(
  root: SafeFolder,
  locations: readonly BodyLocation[],
): Promise<DiskInventory> {
  const sizes = new Map<string, number | null>();
  for (const at of locations) sizes.set(pathOf(root, at), await sizeOf(pathOf(root, at)));
  return {
    hasPackRange: (pack, end) => {
      const size = sizes.get(PathUtils.join(root, ...packPath(pack))) ?? null;
      if (size === null) return "pack-gone";
      return size >= end ? "present" : "pack-short";
    },
    hasFile: (site, id) =>
      (sizes.get(PathUtils.join(root, ...bodyFilePath(site, id))) ?? null) !== null,
  };
}

const uploadAvailability = (settled: SettledExchange, disk: DiskInventory): BodyAvailability => {
  if (settled.upload.kind !== "stored") return { kind: "empty" };
  const at = settled.upload.at;
  const found =
    at.kind === "file"
      ? disk.hasFile(at.site, at.id)
        ? "present"
        : "removed-by-retention"
      : disk.hasPackRange(at.pack, at.offset + at.length);
  if (found === "present")
    return { kind: "available", at, encoding: null, check: "length-matched" };
  return {
    kind: "missing",
    reason: found === "pack-short" ? "interrupted-by-crash" : "removed-by-retention",
  };
};

const storedLocations = (settled: SettledExchange): BodyLocation[] => [
  ...(settled.kind === "answered" && settled.body.kind === "stored" ? [settled.body.at] : []),
  ...(settled.upload.kind === "stored" ? [settled.upload.at] : []),
];

/** Whole lines only: a segment the store is appending to may end mid-line until the newline commits it. */
const linesOf = (text: string): SettledExchange[] =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .flatMap((line) => {
      const decoded = decodeLine(line);
      return decoded === null ? [] : [decoded.exchange];
    });

export function archiveSource(reads: ArchiveReads): ExchangeSource {
  const held: Held[] = [];
  return {
    name: "recording",
    list: async (selection: ResolvedSelection): Promise<SourceListing> => {
      await reads.settle();
      const items: SourceItem[] = [];
      await reads.enqueue(async () => {
        const segments = segmentsFor(reads.activity, selection.windows);
        const packs = new Set<PackId>();
        const bodyFiles = new Set<ExchangeId>();
        for (const segment of segments) {
          let text: string;
          try {
            text = await IOUtils.readUTF8(PathUtils.join(reads.root, ...logSegmentPath(segment)));
          } catch {
            continue;
          }
          for (const settled of linesOf(text)) {
            const item = itemOf(settled.request, null, false, held.length);
            if (!inSelection(selection, item)) continue;
            held.push({ kind: "settled", settled });
            items.push(item);
            for (const location of storedLocations(settled)) {
              if (location.kind === "pack") packs.add(location.pack);
              else bodyFiles.add(location.id);
            }
          }
        }
        if (segments.length > 0 || packs.size > 0 || bodyFiles.size > 0) {
          reads.pin({
            segments,
            packs: [...packs],
            bodyFiles: [...bodyFiles],
          });
        }
      });
      for (const { site, live } of reads.live()) {
        const item = itemOf(live.request, site, true, held.length);
        if (!inSelection(selection, item)) continue;
        held.push({ kind: "live", live });
        items.push(item);
      }
      return { items, notNetwork: {} };
    },
    load: async (item) => {
      const found = held[item.ref as unknown as number];
      if (found === undefined) throw new Error("not an item of this listing");
      if (found.kind === "live") return materialFromRecording({ kind: "live", live: found.live });
      const disk = await inventory(reads.root, storedLocations(found.settled));
      return materialFromRecording({
        kind: "settled",
        settled: found.settled,
        body: bodyAvailability(found.settled, disk),
        upload: uploadAvailability(found.settled, disk),
      });
    },
  };
}

/** Stored bytes in chunks. Opening is the probe: a file that is gone fails before any byte of the entry is written. */
export function archiveBodies(root: SafeFolder): BodyReader {
  return {
    open: async (source, chunkBytes) => {
      if (source.kind !== "stored") return { ok: false, reason: "source-error" };
      const { at } = source;
      const path = pathOf(root, at);
      const start = at.kind === "pack" ? at.offset : 0;
      const size = await sizeOf(path);
      if (size === null) return { ok: false, reason: "removed-by-retention" };
      if (size < start + at.length) return { ok: false, reason: "interrupted-by-crash" };
      const chunks: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for (let done = 0; done < at.length;) {
            const want = Math.min(chunkBytes, at.length - done);
            const bytes = await IOUtils.read(path, { offset: start + done, maxBytes: want });
            if (bytes.byteLength !== want) throw new Error(`short read at ${String(done)}`);
            done += want;
            yield bytes;
          }
        },
      };
      return { ok: true, body: { kind: "bytes", chunks, wireEncoding: source.wireEncoding } };
    },
  };
}

const CONVERTERS = "@mozilla.org/streamConverters;1";

/** One content coding through Gecko's own decoder (gzip, deflate, br, zstd), chunk in, decoded chunks out. */
const decodeOne = (
  coding: string,
  input: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const out: Uint8Array[] = [];
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest: () => undefined,
      onStopRequest: () => undefined,
      onDataAvailable: (_request: unknown, stream: InputStream, _offset: number, count: number) => {
        const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
          Ci.nsIBinaryInputStream,
        );
        binary.setInputStream(stream);
        const buffer = new ArrayBuffer(count);
        binary.readArrayBuffer(count, buffer);
        out.push(new Uint8Array(buffer));
      },
    };
    const converter = Cc[CONVERTERS]
      .getService(Ci.nsIStreamConverterService)
      .asyncConvertData(coding, "uncompressed", listener, null);
    converter.onStartRequest(null);
    let offset = 0;
    for await (const chunk of input) {
      const stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
        Ci.nsIArrayBufferInputStream,
      );
      stream.setData(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
      converter.onDataAvailable(null, stream, offset, chunk.byteLength);
      offset += chunk.byteLength;
      yield* out.splice(0);
    }
    converter.onStopRequest(null, 0);
    yield* out.splice(0);
  },
});

/** Codings apply in the order listed, so they are undone last first. An unknown coding fails when read, not here. */
export const decodeContent = (
  encoding: string,
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> =>
  encoding
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity")
    .reverse()
    .reduce((stream, coding) => decodeOne(coding, stream), chunks);
