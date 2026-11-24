// Writes the two icon files. icon.svg is the master drawing on the 64-unit grid, which the manifest PNGs are rendered
// from. toolbar.svg adds one drawing per device-pixel width measured in Zen and Firefox, because a width that is not a
// multiple of 16 puts the master's edges between pixels, and one for 16, where the master's 3-pixel dot paints blended.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DOT, MARK_PATH, MASTER_DOT, MASTER_MARK } from "../src/ui/mark-shape.ts";
import { extensionRoot } from "./manifest.ts";

export type Scheme = "light" | "dark";
export type Part = "mark" | "dot";

/** Toolbar fills. Each is chosen against the worst surface of its scheme in SURFACES. */
export const TOKENS: Readonly<Record<Scheme, Readonly<Record<Part, string>>>> = {
  light: { mark: "#004ECB", dot: "#BB0438" },
  dark: { mark: "#B5D8FF", dot: "#FF7488" },
};

/**
 * The capture dot on its own pixel box. At 3 and 4 pixels Gecko paints a circle with one and four solid pixels, and a
 * stepped outline reads as a plus sign, so those grids cut each corner diagonally: a solid core and four half-covered
 * corners. From 5 pixels up the steps read as round and leave no partial pixel.
 */
export type Dot =
  | { readonly shape: "octagon"; readonly x: number; readonly y: number; readonly size: number }
  | {
      readonly shape: "steps";
      readonly x: number;
      readonly y: number;
      /** Width of each pixel row, centred in the widest. */
      readonly rows: readonly number[];
    };

/** The mark drawn on one bitmap. A unit is one device pixel and every coordinate is whole. */
export interface Grid {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  /** Outer edges of the H. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Width of both stems. */
  readonly stem: number;
  /** First row of the crossbar, and the row after its last. The right stem starts at the first. */
  readonly bar: readonly [number, number];
  readonly dot: Dot;
}

export const dotSize = (dot: Dot): number =>
  dot.shape === "octagon" ? dot.size : Math.max(...dot.rows);

// Each grid keeps the master's proportions where whole pixels allow: stems and crossbar one weight, the crossbar a
// little above the middle, the dot as wide as the right stem and over it, at least one clear row above the crossbar.
export const GRIDS: readonly Grid[] = [
  {
    id: "g14",
    w: 14,
    h: 14,
    left: 1,
    right: 13,
    top: 1,
    bottom: 13,
    stem: 3,
    bar: [5, 8],
    dot: { shape: "octagon", x: 10, y: 1, size: 3 },
  },
  {
    id: "g16",
    w: 16,
    h: 16,
    left: 2,
    right: 14,
    top: 2,
    bottom: 14,
    stem: 3,
    bar: [6, 9],
    dot: { shape: "octagon", x: 11, y: 2, size: 3 },
  },
  {
    id: "g17",
    w: 17,
    h: 18,
    left: 1,
    right: 16,
    top: 1,
    bottom: 17,
    stem: 4,
    bar: [6, 10],
    dot: { shape: "octagon", x: 12, y: 1, size: 4 },
  },
  {
    id: "g20",
    w: 20,
    h: 20,
    left: 2,
    right: 18,
    top: 2,
    bottom: 18,
    stem: 4,
    bar: [7, 11],
    dot: { shape: "octagon", x: 14, y: 2, size: 4 },
  },
  {
    id: "g21",
    w: 21,
    h: 21,
    left: 2,
    right: 19,
    top: 2,
    bottom: 19,
    stem: 4,
    bar: [8, 12],
    dot: { shape: "octagon", x: 15, y: 2, size: 4 },
  },
  {
    id: "g24",
    w: 24,
    h: 24,
    left: 2,
    right: 22,
    top: 2,
    bottom: 22,
    stem: 5,
    bar: [9, 14],
    dot: { shape: "steps", x: 17, y: 2, rows: [3, 5, 5, 5, 3] },
  },
  {
    id: "g35",
    w: 35,
    h: 35,
    left: 3,
    right: 32,
    top: 3,
    bottom: 32,
    stem: 7,
    bar: [13, 20],
    dot: { shape: "steps", x: 25, y: 3, rows: [3, 5, 7, 7, 7, 5, 3] },
  },
  {
    id: "g40",
    w: 40,
    h: 40,
    left: 4,
    right: 36,
    top: 4,
    bottom: 36,
    stem: 8,
    bar: [15, 23],
    dot: { shape: "steps", x: 28, y: 4, rows: [4, 6, 8, 8, 8, 8, 6, 4] },
  },
];

export interface Cell {
  /** CSS pixels of the toolbar image. */
  readonly css: number;
  /** Value written to layout.css.devPixelsPerPx. 1.75 is the string; Gecko uses 30/17. */
  readonly scale: string;
  /** Media-query width that matched, in px. The viewport is in [query, query + 0.1). */
  readonly query: number;
  readonly bitmap: readonly [number, number];
  readonly drawing: string;
}

/**
 * Device sizes of this button. 14 CSS px is the Zen pill.
 * 16 CSS px is the Firefox navbar and both customize palettes.
 * 32 CSS px is Zen dual and collapsed at a 1400 CSS px window.
 * Scales are 1, 1.25, 1.5, 1.75, 2, 2.5 and 3.
 */
export const CELLS: readonly Cell[] = [
  { css: 14, scale: "1", query: 14, bitmap: [14, 14], drawing: "g14" },
  { css: 14, scale: "1.25", query: 17.5, bitmap: [17, 17], drawing: "g17" },
  { css: 14, scale: "1.5", query: 21, bitmap: [21, 21], drawing: "g21" },
  { css: 14, scale: "1.75", query: 24.7, bitmap: [24, 25], drawing: "g24" },
  { css: 14, scale: "2", query: 28, bitmap: [28, 28], drawing: "g14" },
  { css: 14, scale: "2.5", query: 35, bitmap: [35, 35], drawing: "g35" },
  { css: 14, scale: "3", query: 42, bitmap: [42, 42], drawing: "g14" },
  { css: 16, scale: "1", query: 16, bitmap: [16, 16], drawing: "g16" },
  { css: 16, scale: "1.25", query: 20, bitmap: [20, 20], drawing: "g20" },
  { css: 16, scale: "1.5", query: 24, bitmap: [24, 24], drawing: "g24" },
  { css: 16, scale: "1.75", query: 28.2, bitmap: [28, 28], drawing: "g14" },
  { css: 16, scale: "2", query: 32, bitmap: [32, 32], drawing: "master" },
  { css: 16, scale: "2.5", query: 40, bitmap: [40, 40], drawing: "g40" },
  { css: 16, scale: "3", query: 48, bitmap: [48, 48], drawing: "master" },
  { css: 32, scale: "1", query: 32, bitmap: [32, 32], drawing: "master" },
  { css: 32, scale: "1.25", query: 40, bitmap: [40, 40], drawing: "g40" },
  { css: 32, scale: "1.5", query: 48, bitmap: [48, 48], drawing: "master" },
  { css: 32, scale: "1.75", query: 56.4, bitmap: [56, 56], drawing: "g14" },
  { css: 32, scale: "2", query: 64, bitmap: [64, 64], drawing: "master" },
  { css: 32, scale: "2.5", query: 80, bitmap: [80, 80], drawing: "master" },
  { css: 32, scale: "3", query: 96, bitmap: [96, 96], drawing: "master" },
];

export interface Surface {
  readonly id: string;
  readonly scheme: "light" | "dark";
  readonly hex: string;
}

/** Toolbar pixels behind the icon, grouped by the scheme the icon is given. */
export const SURFACES: readonly Surface[] = [
  { id: "zen-preset-0-beige", scheme: "light", hex: "#EBE8E6" },
  { id: "zen-preset-1-pink", scheme: "light", hex: "#EBCED9" },
  { id: "zen-preset-2-mauve", scheme: "light", hex: "#D2C1CF" },
  { id: "zen-preset-3-coral", scheme: "light", hex: "#EBBABF" },
  { id: "zen-preset-4-orange", scheme: "light", hex: "#EFC7B9" },
  { id: "zen-preset-5-yellow", scheme: "light", hex: "#EDE2B9" },
  { id: "zen-preset-6-mint", scheme: "light", hex: "#ACE7CC" },
  { id: "zen-preset-7-sky", scheme: "light", hex: "#BFD9E2" },
  { id: "zen-preset-8-slate", scheme: "light", hex: "#BDBDC8" },
  { id: "zen-preset-9", scheme: "light", hex: "#EFEEED" },
  { id: "zen-preset-10", scheme: "light", hex: "#EFE8EB" },
  { id: "zen-preset-11", scheme: "light", hex: "#EAE0E9" },
  { id: "zen-preset-12", scheme: "light", hex: "#EFDEE0" },
  { id: "zen-preset-13", scheme: "light", hex: "#EFE4E1" },
  { id: "zen-preset-14", scheme: "light", hex: "#EFEDE6" },
  { id: "zen-preset-15", scheme: "light", hex: "#E4EEE8" },
  { id: "zen-preset-16", scheme: "light", hex: "#E3EBEE" },
  { id: "zen-preset-17", scheme: "light", hex: "#DCDDE6" },
  { id: "zen-preset-18", scheme: "light", hex: "#B6AEBA" },
  { id: "zen-preset-19", scheme: "light", hex: "#BEACB9" },
  { id: "zen-preset-20", scheme: "light", hex: "#CAB1B2" },
  { id: "zen-preset-21", scheme: "light", hex: "#D4BFB1" },
  { id: "zen-preset-22", scheme: "light", hex: "#E2D5BA" },
  { id: "zen-preset-23", scheme: "light", hex: "#DFDFD1" },
  { id: "zen-preset-24", scheme: "light", hex: "#C4D3C6" },
  { id: "zen-preset-25", scheme: "light", hex: "#A7BBB4" },
  { id: "zen-preset-26", scheme: "light", hex: "#A8B3BF" },
  { id: "zen-preset-27", scheme: "light", hex: "#EFEFEF" },
  { id: "zen-pill", scheme: "light", hex: "#D9D9DA" },
  { id: "zen-dual", scheme: "light", hex: "#E9E9E9" },
  { id: "firefox-system", scheme: "light", hex: "#F2F2F2" },
  { id: "firefox-compact-light", scheme: "light", hex: "#FEF4F1" },
  { id: "firefox-alpenglow", scheme: "light", hex: "#EFD4F2" },
  { id: "zen-preset-0-beige", scheme: "dark", hex: "#747170" },
  { id: "zen-preset-1-pink", scheme: "dark", hex: "#745862" },
  { id: "zen-preset-2-mauve", scheme: "dark", hex: "#5C4C59" },
  { id: "zen-preset-3-coral", scheme: "dark", hex: "#74464A" },
  { id: "zen-preset-4-orange", scheme: "dark", hex: "#775243" },
  { id: "zen-preset-5-yellow", scheme: "dark", hex: "#766A43" },
  { id: "zen-preset-6-mint", scheme: "dark", hex: "#397156" },
  { id: "zen-preset-7-sky", scheme: "dark", hex: "#4A626B" },
  { id: "zen-preset-8-slate", scheme: "dark", hex: "#484953" },
  { id: "zen-preset-9", scheme: "dark", hex: "#777676" },
  { id: "zen-preset-10", scheme: "dark", hex: "#777174" },
  { id: "zen-preset-11", scheme: "dark", hex: "#746972" },
  { id: "zen-preset-12", scheme: "dark", hex: "#776869" },
  { id: "zen-preset-13", scheme: "dark", hex: "#776E69" },
  { id: "zen-preset-14", scheme: "dark", hex: "#777670" },
  { id: "zen-preset-15", scheme: "dark", hex: "#6D7772" },
  { id: "zen-preset-16", scheme: "dark", hex: "#6C7476" },
  { id: "zen-preset-17", scheme: "dark", hex: "#666670" },
  { id: "zen-preset-18", scheme: "dark", hex: "#403A44" },
  { id: "zen-preset-19", scheme: "dark", hex: "#493943" },
  { id: "zen-preset-20", scheme: "dark", hex: "#543C3D" },
  { id: "zen-preset-21", scheme: "dark", hex: "#604B3C" },
  { id: "zen-preset-22", scheme: "dark", hex: "#6B6045" },
  { id: "zen-preset-23", scheme: "dark", hex: "#68685B" },
  { id: "zen-preset-24", scheme: "dark", hex: "#4E5D51" },
  { id: "zen-preset-25", scheme: "dark", hex: "#32463F" },
  { id: "zen-preset-26", scheme: "dark", hex: "#343E4A" },
  { id: "zen-preset-27", scheme: "dark", hex: "#777777" },
  { id: "zen-pill", scheme: "dark", hex: "#2E2E2F" },
  { id: "zen-dual", scheme: "dark", hex: "#131313" },
  { id: "firefox-compact-dark", scheme: "dark", hex: "#381D1E" },
  { id: "firefox-system", scheme: "dark", hex: "#44434B" },
  { id: "firefox-alpenglow", scheme: "dark", hex: "#281D50" },
];

export interface Shortfall {
  readonly id: string;
  readonly ratio: number;
}

/**
 * Surfaces where a token stays under 3:1, with its ratio. Only the dark dot has any: a red at its hue and chroma that
 * clears the mid-grey dark presets would be pink. Sorted by ratio.
 */
export const SHORTFALLS: Readonly<Record<Scheme, Readonly<Record<Part, readonly Shortfall[]>>>> = {
  light: { mark: [], dot: [] },
  dark: {
    mark: [],
    dot: [
      { id: "zen-preset-27", ratio: 1.728 },
      { id: "zen-preset-9", ratio: 1.748 },
      { id: "zen-preset-14", ratio: 1.758 },
      { id: "zen-preset-15", ratio: 1.789 },
      { id: "zen-preset-10", ratio: 1.843 },
      { id: "zen-preset-16", ratio: 1.843 },
      { id: "zen-preset-0-beige", ratio: 1.868 },
      { id: "zen-preset-13", ratio: 1.921 },
      { id: "zen-preset-11", ratio: 2.023 },
      { id: "zen-preset-12", ratio: 2.043 },
      { id: "zen-preset-5-yellow", ratio: 2.071 },
      { id: "zen-preset-23", ratio: 2.179 },
      { id: "zen-preset-17", ratio: 2.191 },
      { id: "zen-preset-6-mint", ratio: 2.208 },
      { id: "zen-preset-22", ratio: 2.395 },
      { id: "zen-preset-1-pink", ratio: 2.445 },
      { id: "zen-preset-7-sky", ratio: 2.494 },
      { id: "zen-preset-4-orange", ratio: 2.638 },
      { id: "zen-preset-24", ratio: 2.694 },
      { id: "zen-preset-3-coral", ratio: 2.983 },
    ],
  },
};

const lin = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast of two opaque sRGB fills. */
export const contrast = (a: string, b: string): number => {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
};

const TOL = 35;

const bandsFor = (id: string): Array<[number, number]> => {
  const raw = CELLS.filter((cell) => cell.drawing === id).map((cell) => {
    const c = Math.round(cell.query * 100);
    return [c - TOL, c + TOL] as [number, number];
  });
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of raw) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
};

/** Drawing whose band contains this media-query width. Anything else is the master. */
export const drawingAt = (width: number): string => {
  const c = Math.round(width * 100);
  for (const grid of GRIDS) {
    for (const [a, b] of bandsFor(grid.id)) {
      if (c >= a && c <= b) return grid.id;
    }
  }
  return "master";
};

const px = (hundredths: number): string => String(hundredths / 100);

const queryFor = (id: string): string =>
  bandsFor(id)
    .map(([a, b]) => `(min-width:${px(a)}px) and (max-width:${px(b)}px)`)
    .join(",");

const widthRules = (): string =>
  GRIDS.map(
    (grid) => `@media ${queryFor(grid.id)}{.m{display:none}.${grid.id}{display:inline}}`,
  ).join("");

const markPath = (grid: Grid): string => {
  const { left, right, top, bottom, stem } = grid;
  const [barTop, barBottom] = grid.bar;
  return `M${left} ${top}H${left + stem}V${barTop}H${right}V${bottom}H${right - stem}V${barBottom}H${left + stem}V${bottom}H${left}Z`;
};

/** The stepped dot as one outline: down the right side run by run of equal rows, then back up the left. */
const stepsPath = (x: number, y: number, rows: readonly number[]): string => {
  const size = Math.max(...rows);
  const runs: Array<{ width: number; from: number; to: number }> = [];
  rows.forEach((width, i) => {
    const last = runs.at(-1);
    if (last?.width === width) last.to = y + i + 1;
    else runs.push({ width, from: y + i, to: y + i + 1 });
  });
  const right = runs.map(({ width, to }) => `H${x + (size + width) / 2}V${to}`).join("");
  const left = runs
    .toReversed()
    .map(({ width, from }) => `H${x + (size - width) / 2}V${from}`)
    .join("");
  return `M${x + (size - (rows[0] ?? size)) / 2} ${y}${right}${left}Z`;
};

/** A square on whole pixels with a one-pixel diagonal cut at each corner. */
const octagonPath = (x: number, y: number, size: number): string =>
  `M${x + 1} ${y}H${x + size - 1}L${x + size} ${y + 1}V${y + size - 1}L${x + size - 1} ${y + size}H${x + 1}L${x} ${y + size - 1}V${y + 1}Z`;

const dotElement = (dot: Dot, fill: string): string =>
  `<path class="dot" d="${dot.shape === "octagon" ? octagonPath(dot.x, dot.y, dot.size) : stepsPath(dot.x, dot.y, dot.rows)}" fill="${fill}"/>`;

/** The two elements of one grid drawing, in the light fills. */
const gridShapes = (grid: Grid): string =>
  `<path class="mark" d="${markPath(grid)}" fill="${TOKENS.light.mark}"/>${dotElement(grid.dot, TOKENS.light.dot)}`;

/** One grid drawing as a file of its own, at its bitmap size. */
export const gridDrawingSvg = (grid: Grid): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid.w} ${grid.h}" width="${grid.w}" height="${grid.h}">${gridShapes(grid)}</svg>`;

const nestedSvg = (grid: Grid): string =>
  `<svg class="${grid.id} off" x="0" y="0" width="64" height="64" viewBox="0 0 ${grid.w} ${grid.h}" preserveAspectRatio="none">${gridShapes(grid)}</svg>`;

const ROOT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Hark">`;

const masterShapes = (mark: string, dot: string): string =>
  `<path class="mark" d="${MARK_PATH}" fill="${mark}"/><circle class="dot" cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${dot}"/>`;

/** icon.svg: the two master shapes and nothing else, so two fills recolour it. */
export const generateMasterSvg = (): string =>
  `${ROOT}${masterShapes(MASTER_MARK, MASTER_DOT)}</svg>\n`;

const fills = (scheme: Scheme): string =>
  `.mark{fill:${TOKENS[scheme].mark}}.dot{fill:${TOKENS[scheme].dot}}`;

/** The toolbar file, one line, both theme slots. */
export const generateToolbarSvg = (): string => {
  const style = `<style>.off{display:none}${fills("light")}${widthRules()}@media (prefers-color-scheme:dark){${fills("dark")}}</style>`;
  return `${ROOT}${style}<g class="m">${masterShapes(TOKENS.light.mark, TOKENS.light.dot)}</g>${GRIDS.map(nestedSvg).join("")}</svg>`;
};

/** 4-connected shapes of the pixels whose alpha is not 0. `alpha` is row-major, `w` wide. */
export const shapeCount = (alpha: ArrayLike<number>, w: number): number => {
  const h = alpha.length / w;
  const seen = new Uint8Array(alpha.length);
  let n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (!alpha[i] || seen[i]) continue;
    n += 1;
    const stack = [i];
    seen[i] = 1;
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      const x = cur % w;
      const y = (cur - x) / w;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (alpha[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return n;
};

export const iconSvgPath = NodePath.join(extensionRoot, "src", "icons", "icon.svg");
export const toolbarSvgPath = NodePath.join(extensionRoot, "src", "icons", "toolbar.svg");

if (import.meta.main) {
  NodeFS.writeFileSync(iconSvgPath, generateMasterSvg());
  NodeFS.writeFileSync(toolbarSvgPath, generateToolbarSvg());
}
