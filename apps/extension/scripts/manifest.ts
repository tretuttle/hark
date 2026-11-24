import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const extensionRoot = NodePath.resolve(import.meta.dirname, "..");
const publicDir = NodePath.join(extensionRoot, "public");

interface ExperimentApi {
  readonly schema: string;
  readonly parent: { readonly script: string };
}

export interface Manifest {
  readonly version: string;
  /** Raster icon paths by pixel size. */
  readonly icons: Readonly<Record<string, string>>;
  readonly action: {
    readonly default_popup: string;
    readonly default_icon: string;
    readonly theme_icons: ReadonlyArray<{ readonly light: string; readonly dark: string }>;
  };
  readonly experiment_apis: Readonly<Record<string, ExperimentApi>>;
}

export const readManifest = (
  path = NodePath.join(extensionRoot, "src", "manifest.json"),
): Manifest => JSON.parse(NodeFS.readFileSync(path, "utf8")) as Manifest;

/** Where a manifest path lands in the generated `public` folder, which extension.js copies to the build root. */
export const publicPath = (manifestPath: string): string =>
  NodePath.join(publicDir, manifestPath.replace(/^\//, ""));

export const buildDir = NodePath.join(extensionRoot, "dist", "firefox");

/** Where `pack` writes the XPI for a manifest version. */
export const xpiPath = (version: string): string =>
  NodePath.join(extensionRoot, "dist", `hark-${version}.xpi`);
