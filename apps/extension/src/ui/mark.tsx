// The Hark mark drawn inline, so it is vector at every device scale and takes its fills from --mark and --dot.
// The viewBox is the H's own box, so the ink fills the element and the CSS gap is the gap to the text beside it.
// At 24 CSS px a 4-unit step of the grid is 2 device px at 1x and 4 at 2x, so every straight edge is on a whole pixel.

import { DOT, MARK_BOX, MARK_PATH } from "./mark-shape.ts";

export const MARK_CSS_PX = 24;

export const Mark = () => (
  <svg
    className="hark-mark"
    width={MARK_CSS_PX}
    height={MARK_CSS_PX}
    viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.size} ${MARK_BOX.size}`}
    aria-hidden="true"
    focusable="false"
  >
    <path className="mark" d={MARK_PATH} />
    <circle className="dot" cx={DOT.cx} cy={DOT.cy} r={DOT.r} />
  </svg>
);
