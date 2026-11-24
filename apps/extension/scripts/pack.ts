import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { zipSync, type Zippable } from "fflate";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";

const { version } = readManifest(NodePath.join(buildDir, "manifest.json"));

// A fixed timestamp keeps the archive byte-identical for identical build output. ZIP stores local time,
// so this is local midnight in every time zone.
const mtime = new Date(2000, 0, 1);
const names = NodeFS.readdirSync(buildDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) =>
    NodePath.relative(buildDir, NodePath.join(entry.parentPath, entry.name))
      .split(NodePath.sep)
      .join("/"),
  )
  .sort();
const files: Zippable = Object.fromEntries(
  names.map((name) => [name, [NodeFS.readFileSync(NodePath.join(buildDir, name)), { mtime }]]),
);

const xpi = xpiPath(version);
NodeFS.writeFileSync(xpi, zipSync(files, { level: 9 }));
console.log(`${NodePath.relative(process.cwd(), xpi)} ${NodeFS.statSync(xpi).size} bytes`);
