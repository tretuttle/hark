import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vite-plus/test";
import {
  CELLS,
  GRIDS,
  type Grid,
  type Part,
  type Scheme,
  SHORTFALLS,
  SURFACES,
  TOKENS,
  contrast,
  dotSize,
  drawingAt,
  generateMasterSvg,
  generateToolbarSvg,
  gridDrawingSvg,
  iconSvgPath,
  shapeCount,
  toolbarSvgPath,
} from "./toolbar-icon.ts";
import { MASTER_DOT, MASTER_MARK } from "../src/ui/mark-shape.ts";
import { extensionRoot } from "./manifest.ts";

const shownClass = (svg: string, width: number): string => {
  let shown = "master";
  let hits = 0;
  for (const rule of svg.matchAll(
    /@media ([^{]+)\{(?:\.m\{display:none\}\.(g\d+)\{display:inline\})\}/g,
  )) {
    const query = rule[1] ?? "";
    const id = rule[2] ?? "";
    const hit = query.split(",").some((part) => {
      const min = part.match(/min-width:([\d.]+)px/);
      const max = part.match(/max-width:([\d.]+)px/);
      if (!min?.[1] || !max?.[1]) return false;
      return width + 1e-9 >= Number(min[1]) && width - 1e-9 <= Number(max[1]);
    });
    if (!hit) continue;
    hits += 1;
    shown = id;
  }
  expect(hits, `width ${width} matched ${hits} drawings`).toBeLessThanOrEqual(1);
  return shown;
};

/** Alpha of every pixel resvg paints for `svg` at `width` pixels wide. */
const alphaOf = (svg: string, width: number): Uint8Array => {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  }).render();
  return Uint8Array.from(
    { length: image.width * image.height },
    (_, i) => image.pixels[i * 4 + 3] ?? 0,
  );
};

const drawing = (grid: Grid): Uint8Array => alphaOf(gridDrawingSvg(grid), grid.w);

/** The same drawing with one of its two elements removed, by class. */
const without = (svg: string, part: Part): string =>
  svg.replace(new RegExp(`<path class="${part}"[^>]*/>`), "");

const MANIFEST_SIZES = [16, 32, 48, 96, 128];

describe("toolbar icon", () => {
  it("writes the files the generator describes", () => {
    expect(NodeFS.readFileSync(iconSvgPath, "utf8")).toBe(generateMasterSvg());
    const svg = generateToolbarSvg();
    expect(svg.includes("\n")).toBe(false);
    expect(NodeFS.readFileSync(toolbarSvgPath, "utf8")).toBe(svg);
  });

  it("shows the drawing the media query table names for every measured width", () => {
    const svg = generateToolbarSvg();
    for (const cell of CELLS) {
      expect(drawingAt(cell.query), `${cell.css}@${cell.scale}`).toBe(cell.drawing);
      expect(shownClass(svg, cell.query), `${cell.css}@${cell.scale}`).toBe(cell.drawing);
    }
    for (const width of [32, 48, 64, 80, 96]) {
      expect(drawingAt(width)).toBe("master");
      expect(shownClass(svg, width)).toBe("master");
    }
  });

  it("draws icon.svg as one mark path and one dot circle, with no background", () => {
    const svg = generateMasterSvg();
    const elements = [...svg.matchAll(/<(\w+)[\s>]/g)].map((match) => match[1]);
    expect(elements).toEqual(["svg", "path", "circle"]);
    expect(svg).toMatch(/<path class="mark" d="[^"]+" fill="#[0-9A-F]{6}"\/>/);
    expect(svg).toMatch(/<circle class="dot" [^>]*fill="#[0-9A-F]{6}"\/>/);
    expect(svg).not.toMatch(/stroke|<g|<style|<rect/);
  });

  it("renders the master as two separate shapes at every manifest size", () => {
    const svg = generateMasterSvg();
    for (const size of MANIFEST_SIZES) {
      expect(shapeCount(alphaOf(svg, size), size), `${size}`).toBe(2);
    }
    const touching = svg.replace('cy="14"', 'cy="18"');
    for (const size of MANIFEST_SIZES) {
      expect(shapeCount(alphaOf(touching, size), size), `dot on the crossbar at ${size}`).toBe(1);
    }
  });

  it("draws every grid as two shapes, and one when the dot sits on the crossbar", () => {
    for (const grid of GRIDS) {
      expect(shapeCount(drawing(grid), grid.w), grid.id).toBe(2);
      const dropped = { ...grid, dot: { ...grid.dot, y: grid.bar[0] - dotSize(grid.dot) } };
      expect(shapeCount(drawing(dropped), grid.w), `${grid.id} merged`).toBe(1);
    }
  });

  it("puts every edge of a grid's mark on a whole pixel, and only the cut corners of its dot between pixels", () => {
    for (const grid of GRIDS) {
      const mark = alphaOf(without(gridDrawingSvg(grid), "dot"), grid.w);
      const partial = mark.filter((alpha) => alpha !== 0 && alpha !== 255).length;
      expect(partial, grid.id).toBe(0);
      const dot = alphaOf(without(gridDrawingSvg(grid), "mark"), grid.w);
      const corners = grid.dot.shape === "octagon" ? 4 : 0;
      expect(dot.filter((alpha) => alpha !== 0 && alpha !== 255).length, grid.id).toBe(corners);
    }
  });

  it("keeps each grid's dot over the right stem with a clear row above the crossbar", () => {
    for (const grid of GRIDS) {
      const size = dotSize(grid.dot);
      expect(size, grid.id).toBe(grid.stem);
      expect(grid.dot.x + size / 2, grid.id).toBe(grid.right - grid.stem / 2);
      expect(grid.dot.y, grid.id).toBe(grid.top);
      expect(grid.dot.y + size, grid.id).toBeLessThanOrEqual(grid.bar[0] - 1);
      expect(grid.bar[1] - grid.bar[0], `${grid.id} crossbar weight`).toBe(grid.stem);
      const above = grid.bar[0] - grid.top;
      const below = grid.bottom - grid.bar[1];
      expect(above, `${grid.id} crossbar above the middle`).toBeLessThan(below);
    }
  });

  it("clears 3:1 on every surface of its scheme except the pinned shortfalls", () => {
    for (const scheme of ["light", "dark"] as const satisfies readonly Scheme[]) {
      for (const part of ["mark", "dot"] as const satisfies readonly Part[]) {
        const fill = TOKENS[scheme][part];
        const pinned = new Map(SHORTFALLS[scheme][part].map((row) => [row.id, row.ratio]));
        const surfaces = SURFACES.filter((surface) => surface.scheme === scheme);
        for (const surface of surfaces) {
          const ratio = contrast(fill, surface.hex);
          const claimed = pinned.get(surface.id);
          const label = `${scheme} ${part} on ${surface.id}`;
          if (claimed === undefined) {
            expect(ratio, label).toBeGreaterThanOrEqual(3);
          } else {
            expect(ratio, label).toBeCloseTo(claimed, 2);
            expect(ratio, label).toBeLessThan(3);
          }
        }
        const missed = surfaces
          .filter((surface) => contrast(fill, surface.hex) < 3)
          .map((surface) => surface.id);
        expect(missed.toSorted(), `${scheme} ${part}`).toEqual([...pinned.keys()].toSorted());
      }
    }
  });

  it("gives the page headers the master fills in light and the dark toolbar fills in dark", () => {
    const css = NodeFS.readFileSync(NodePath.join(extensionRoot, "src", "styles.css"), "utf8");
    const [light = "", dark = ""] = css.toUpperCase().split("@MEDIA (PREFERS-COLOR-SCHEME: DARK)");
    expect(light).toContain(`--MARK: ${MASTER_MARK};`);
    expect(light).toContain(`--DOT: ${MASTER_DOT};`);
    expect(dark).toContain(`--MARK: ${TOKENS.dark.mark};`);
    expect(dark).toContain(`--DOT: ${TOKENS.dark.dot};`);
  });

  it("a fill equal to the background has contrast 1", () => {
    expect(contrast("#D9D9DA", "#D9D9DA")).toBe(1);
    expect(contrast("#381C1C", "#381C1C")).toBe(1);
  });
});
