// Writes each raster icon the manifest lists under `icons` into `public`, rendered from the SVG master
// `src/icons/icon.svg`. Rasters are generated and gitignored, so a PNG cannot drift from its master.
// `scripts/toolbar-icon.ts` writes both `src/icons/icon.svg` and `src/icons/toolbar.svg`. extension.js copies the
// toolbar file as-is.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { extensionRoot, publicPath, readManifest } from "./manifest.ts";

export const renderPng = (svg: string, size: number): Uint8Array =>
  new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();

if (import.meta.main) {
  const master = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "icon.svg"),
    "utf8",
  );
  for (const [size, path] of Object.entries(readManifest().icons)) {
    const file = publicPath(path);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, renderPng(master, Number(size)));
  }
}
