// The Hark mark on its 64-unit grid: an H whose right stem starts at the crossbar, and the capture dot in the
// space above it. icon.svg, the master drawing in toolbar.svg and the page headers all draw these two shapes.
// Every straight edge is on the 4-unit grid, so it lands on a whole pixel at 16, 32, 48, 96 and 128.

/** One closed outline: stems 12 wide, crossbar from y 24 to 36, outer corners radius 4. */
export const MARK_PATH =
  "M12 8 H16 Q20 8 20 12 V24 H52 Q56 24 56 28 V52 Q56 56 52 56 H48 Q44 56 44 52 V36 H20 V52 Q20 56 16 56 H12 Q8 56 8 52 V12 Q8 8 12 8 Z";

/** Over the right stem, with 4 units clear above the crossbar. */
export const DOT = { cx: 50, cy: 14, r: 6 } as const;

/** The square the H fills, which holds the dot too: x and y 8 to 56. */
export const MARK_BOX = { x: 8, y: 8, size: 48 } as const;

/** The fills icon.svg carries, and so the manifest PNGs. */
export const MASTER_MARK = "#1D5AD9";
export const MASTER_DOT = "#E11D48";
