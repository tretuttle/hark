import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MARK_CSS_PX, Mark } from "./mark.tsx";

const iconSvg = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "icons", "icon.svg"),
  "utf8",
);

const attribute = (markup: string, element: string, name: string): string =>
  markup.match(new RegExp(`<${element}[^>]*\\s${name}="([^"]*)"`))?.[1] ?? "";

describe("header mark", () => {
  const markup = renderToStaticMarkup(<Mark />);

  it("draws the same two shapes as icon.svg", () => {
    expect(attribute(markup, "path", "d")).toBe(attribute(iconSvg, "path", "d"));
    for (const name of ["cx", "cy", "r"]) {
      expect(attribute(markup, "circle", name), name).toBe(attribute(iconSvg, "circle", name));
    }
  });

  it("puts every 4-unit edge on a whole device pixel at 1x and 2x, and frames the whole drawing", () => {
    const [x, y, w, h] = attribute(markup, "svg", "viewBox").split(" ").map(Number);
    expect(attribute(markup, "svg", "width")).toBe(String(MARK_CSS_PX));
    expect(attribute(markup, "svg", "height")).toBe(String(MARK_CSS_PX));
    expect(w).toBe(h);
    for (const scale of [1, 2]) {
      const unit = (MARK_CSS_PX * scale) / (w ?? 1);
      expect(Number.isInteger(4 * unit), `${scale}x`).toBe(true);
      expect(
        Number.isInteger((x ?? 0) * unit) && Number.isInteger((y ?? 0) * unit),
        `${scale}x`,
      ).toBe(true);
    }
    // The H spans 8 to 56 on both axes and the dot sits inside it.
    expect([x, y, (x ?? 0) + (w ?? 0), (y ?? 0) + (h ?? 0)]).toEqual([8, 8, 56, 56]);
  });
});
