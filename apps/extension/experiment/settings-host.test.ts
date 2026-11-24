import type { ByteCount } from "@hark/recording/ids";
import { guardFolder, type ForbiddenRoots } from "@hark/recording/layout";
import { DEFAULT_USER_SETTINGS } from "@hark/recording/settings";
import { describe, expect, it } from "vite-plus/test";
import type { RefusedFolder } from "./contract.ts";
import { refusedFolder, settingsView } from "./settings-host.ts";

const ARCHIVE = "/home/u/.local/share/hark/0123abcd";
const ROOTS: ForbiddenRoots = {
  profile: "/home/u/.zen/abc.default",
  greDir: "/opt/zen",
  appDir: "/opt/zen/browser",
  substitutions: ["/home/u/.zen/abc.default/chrome", ARCHIVE],
};

/** What the options page must say for a folder, written from the rule, not from a run of the code. */
const CASES: readonly (readonly [folder: string, said: RefusedFolder | "accepted"])[] = [
  ["/home/u/.zen/abc.default/exports", "inside-profile"],
  ["/home/u/.zen/abc.default", "inside-profile"],
  ["/home/u/.zen", "contains-profile"],
  ["/home/u/.zen/abc.default/chrome/x", "inside-profile"],
  ["/opt/zen/browser/features", "inside-browser"],
  ["/opt", "contains-browser"],
  [`${ARCHIVE}/sites`, "inside-recording"],
  ["/home/u/.local/share", "contains-recording"],
  ["exports", "not-absolute"],
  ["/home/u/Downloads/hars", "accepted"],
  ["/home/u/.zen-exports", "accepted"],
];

const said = (folder: string): RefusedFolder | "accepted" => {
  const verdict = guardFolder(folder, ROOTS, "linux");
  return verdict.ok ? "accepted" : refusedFolder(verdict.refusal, ROOTS, ARCHIVE);
};

describe("a chosen export folder", () => {
  it.each(CASES)("%s is %s", (folder, expected) => {
    expect(said(folder)).toBe(expected);
  });

  it("reaches a page as its own name only, never its path", () => {
    const view = settingsView(
      {
        user: DEFAULT_USER_SETTINGS,
        exportFolder: { kind: "chosen", path: "/home/u/Documents/hars", label: "hars" },
      },
      { bodyBytes: 3 as ByteCount, detailBytes: 4 as ByteCount },
    );
    expect(view.exportTo).toEqual({ kind: "chosen", label: "hars" });
    expect(JSON.stringify(view)).not.toContain("/home/u");
    expect(view.usage).toEqual({ bodyBytes: 3, detailBytes: 4 });
  });
});
