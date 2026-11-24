import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { extensionRoot, readManifest } from "./manifest.ts";
import { renderPng } from "./write-icons.ts";

const master = NodeFS.readFileSync(
  NodePath.join(extensionRoot, "src", "icons", "icon.svg"),
  "utf8",
);

interface Pixel {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

/** Decodes an 8-bit RGBA PNG and returns its size and a pixel reader. */
const decode = (png: Uint8Array) => {
  const view = Buffer.from(png);
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  expect([view[24], view[25]], "8-bit RGBA").toEqual([8, 6]);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < view.length;) {
    const length = view.readUInt32BE(offset);
    if (view.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      idat.push(view.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= 4 ? (pixels[y * stride + i - 4] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 4 ? (pixels[(y - 1) * stride + i - 4] ?? 0) : 0;
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        (() => {
          const p = left + up - upLeft;
          const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
          return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        })(),
      ][filter ?? 0];
      pixels[y * stride + i] = (x + (predictor ?? 0)) & 255;
    }
  }
  const at = (x: number, y: number): Pixel => {
    const i = y * stride + x * 4;
    return {
      red: pixels[i] ?? -1,
      green: pixels[i + 1] ?? -1,
      blue: pixels[i + 2] ?? -1,
      alpha: pixels[i + 3] ?? -1,
    };
  };
  return { width, height, at };
};

const color = (hex: string, alpha = 255): Pixel => ({
  red: Number.parseInt(hex.slice(1, 3), 16),
  green: Number.parseInt(hex.slice(3, 5), 16),
  blue: Number.parseInt(hex.slice(5, 7), 16),
  alpha,
});

describe("write-icons", () => {
  it("renders every size the manifest lists at that size", () => {
    for (const size of Object.keys(readManifest().icons)) {
      const { width, height } = decode(renderPng(master, Number(size)));
      expect({ width, height }).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  // The expected colours and positions come from icon.svg's fills and its 64-unit grid: the left stem spans x 8 to 20,
  // the crossbar y 24 to 36 in #1D5AD9, and the dot is centred on (50, 14) in #E11D48.
  it("draws the master's blue mark and red dot on a transparent background", () => {
    const icon = decode(renderPng(master, 128));
    expect(icon.at(28, 64)).toEqual(color("#1D5AD9"));
    expect(icon.at(64, 60)).toEqual(color("#1D5AD9"));
    expect(icon.at(100, 28)).toEqual(color("#E11D48"));
    expect(icon.at(0, 0).alpha).toBe(0);
    expect(icon.at(64, 40).alpha, "the counter above the crossbar").toBe(0);
    expect(icon.at(100, 44).alpha, "the gap under the dot").toBe(0);
  });

  // Every straight edge is on the 4-unit grid, so at each size the row above and below the crossbar is clear and its
  // first and last rows are solid. A crossbar on y 26 to 38 leaves half-covered rows at 16 and 48.
  it("lands the crossbar on whole pixels at every manifest size", () => {
    for (const size of Object.keys(readManifest().icons).map(Number)) {
      const icon = decode(renderPng(master, size));
      const scale = size / 64;
      const x = 32 * scale;
      const [top, bottom] = [24 * scale, 36 * scale];
      expect(icon.at(x, top - 1).alpha, `${size} above`).toBe(0);
      expect(icon.at(x, top).alpha, `${size} first row`).toBe(255);
      expect(icon.at(x, bottom - 1).alpha, `${size} last row`).toBe(255);
      expect(icon.at(x, bottom).alpha, `${size} below`).toBe(0);
    }
  });

  it("tells the master apart from a flat square", () => {
    const flat = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2f6fdb"/></svg>`;
    const icon = decode(renderPng(flat, 128));
    expect(icon.at(0, 0).alpha).toBe(255);
    expect(icon.at(100, 28)).not.toEqual(color("#E11D48"));
  });
});
