import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;

export async function readZipEntry(file: string, entryName: string): Promise<Buffer> {
  const bytes = await NodeFSP.readFile(file);
  if (bytes.length < 22) throw new Error("zip is too small");
  const eocd = findEocd(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error("zip central directory is invalid");
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (name === entryName) return inflateLocal(bytes, localOffset, method, compressedSize);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip has no ${entryName}`);
}

function findEocd(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_HEADER) return offset;
  }
  throw new Error("zip end of central directory is missing");
}

function inflateLocal(
  bytes: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) {
    throw new Error("zip local header is invalid");
  }
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  if (start + compressedSize > bytes.length) throw new Error("zip entry is truncated");
  const compressed = bytes.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return NodeZlib.inflateRawSync(compressed);
  throw new Error(`zip method ${String(method)} is unsupported`);
}
