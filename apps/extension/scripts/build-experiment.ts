// Writes the experiment's schema.json and parent script to the paths the manifest names, under the folder given
// as the first argument. extension.js only copies scripts, so `build` runs this on its output afterwards and
// `dev` runs it on `public`. The bundler only bundles: the parent script is minified by the parent-script step in
// minify.ts, which check-xpi runs again on the packed file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";
import { FILE_WORKER, harkApi, namespace } from "../experiment/contract.ts";
import { toGeckoSchema } from "../experiment/gecko-schema.ts";
import { extensionRoot, readManifest } from "./manifest.ts";
import { MINIFIED } from "./minify.ts";

/**
 * Bundles `entryFile` into one self-contained IIFE at `scriptFile`, the way the parent script ships. `minify: false`
 * exists so the XPI check can be tested against the unminified output of this same build.
 */
export const bundleScript = async (
  entryFile: string,
  scriptFile: string,
  minify: boolean,
): Promise<void> => {
  await build({
    config: false,
    entry: { [NodePath.basename(scriptFile, ".js")]: entryFile },
    outDir: NodePath.dirname(scriptFile),
    format: "iife",
    platform: "neutral",
    deps: { alwaysBundle: [/./] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    minify: false,
    clean: false,
    report: false,
    logLevel: "warn",
    outputOptions: { entryFileNames: "[name].js" },
  });
  if (minify)
    NodeFS.writeFileSync(
      scriptFile,
      MINIFIED["parent-script"].run(NodeFS.readFileSync(scriptFile, "utf8"), scriptFile),
    );
};

export const bundleParent = (scriptFile: string, minify: boolean): Promise<void> =>
  bundleScript(NodePath.join(extensionRoot, "experiment", "parent.ts"), scriptFile, minify);

if (import.meta.main) {
  const [outRoot] = process.argv.slice(2);
  if (outRoot === undefined)
    throw new Error("Usage: node scripts/build-experiment.ts <output folder>");

  const experiment = readManifest().experiment_apis[namespace];
  if (experiment === undefined) {
    throw new Error(
      `src/manifest.json declares no experiment_apis.${namespace}, the namespace in experiment/contract.ts`,
    );
  }

  const schemaFile = NodePath.resolve(extensionRoot, outRoot, experiment.schema);
  NodeFS.mkdirSync(NodePath.dirname(schemaFile), { recursive: true });
  NodeFS.writeFileSync(
    schemaFile,
    `${JSON.stringify(toGeckoSchema(namespace, harkApi), null, 2)}\n`,
  );
  await bundleParent(NodePath.resolve(extensionRoot, outRoot, experiment.parent.script), true);
  await bundleScript(
    NodePath.join(extensionRoot, "experiment", "file-worker.ts"),
    NodePath.resolve(extensionRoot, outRoot, FILE_WORKER),
    true,
  );
}
