import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readZipEntry } from "./zip.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("zip entries", () => {
  it("reads a stored manifest and a deflated manifest", async () => {
    const stored = Buffer.from('{"id":"stored"}\n');
    const storedFile = await writeTemp(manualZip("manifest.json", stored, stored, 0));
    expect(await readZipEntry(storedFile, "manifest.json")).toEqual(stored);

    const plain = Buffer.from('{"id":"deflated"}\n');
    const compressed = NodeZlib.deflateRawSync(plain);
    const deflatedFile = await writeTemp(manualZip("manifest.json", plain, compressed, 8));
    expect(await readZipEntry(deflatedFile, "manifest.json")).toEqual(plain);
  });

  it("rejects a missing entry and a truncated deflate stream", async () => {
    const payload = Buffer.from("abcdef");
    const file = await writeTemp(manualZip("manifest.json", payload, payload, 0));
    await expect(readZipEntry(file, "other.json")).rejects.toThrow(/zip has no other.json/);

    const plain = Buffer.from("deflated payload");
    const compressed = Buffer.from(NodeZlib.deflateRawSync(plain));
    compressed[0] = (compressed[0] ?? 0) ^ 0xff;
    const broken = await writeTemp(manualZip("manifest.json", plain, compressed, 8));
    await expect(readZipEntry(broken, "manifest.json")).rejects.toThrow();
  });
});

async function writeTemp(bytes: Buffer): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-zip-"));
  directories.push(directory);
  const file = NodePath.join(directory, "addon.xpi");
  await NodeFSP.writeFile(file, bytes);
  return file;
}

function manualZip(name: string, plain: Buffer, compressed: Buffer, method: number): Buffer {
  const crc = NodeZlib.crc32(plain);
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(plain.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(30 + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, eocd]);
}
