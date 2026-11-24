import { describe, expect, it } from "vite-plus/test";

import { parseSite, type ExchangeId, type RunId, type Site } from "../src/ids.ts";
import type * as layout from "../src/layout.ts";
import {
  archiveKeyFromBytes,
  ARCHIVE_ROOTS,
  bodyFilePath,
  guardFolder,
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  packId,
  packPath,
  parseArchiveKey,
  parseArchiveName,
  parseLogSegmentId,
  parsePackId,
  parseSiteDir,
  partPath,
  rootSegments,
  siteDirName,
  type ForbiddenRoots,
} from "../src/layout.ts";
import { importAltered } from "./alter.ts";

const dirKeys: Record<string, string> = {
  Home: "/home/u",
  LocalAppData: "C:\\Users\\u\\AppData\\Local",
  ULibDir: "/Users/u/Library",
};
const dirKey = (key: string) => dirKeys[key] ?? `<${key}>`;
const envOf = (value: string | null) => (name: string) => (name === "XDG_DATA_HOME" ? value : null);

describe("rootSegments", () => {
  it.each([
    ["XDG_DATA_HOME set", "/data/u", ["/data/u", "hark"]],
    ["XDG_DATA_HOME with a trailing separator", "/data/u/", ["/data/u", "hark"]],
    [
      "XDG_DATA_HOME is never extended with .local/share",
      "/home/u/.local/share",
      ["/home/u/.local/share", "hark"],
    ],
    ["XDG_DATA_HOME empty", "", ["/home/u", ".local", "share", "hark"]],
    [
      "XDG_DATA_HOME relative, which the spec ignores",
      "data",
      ["/home/u", ".local", "share", "hark"],
    ],
    ["XDG_DATA_HOME unset", null, ["/home/u", ".local", "share", "hark"]],
  ])("linux, %s", (_label, value, want) => {
    expect(rootSegments(ARCHIVE_ROOTS.linux, envOf(value), dirKey)).toEqual(want);
  });

  it("windows and macOS take their directory keys", () => {
    expect(rootSegments(ARCHIVE_ROOTS.win, envOf("/x"), dirKey)).toEqual([
      "C:\\Users\\u\\AppData\\Local",
      "Hark",
    ]);
    expect(rootSegments(ARCHIVE_ROOTS.macosx, envOf("/x"), dirKey)).toEqual([
      "/Users/u/Library",
      "Application Support",
      "Hark",
    ]);
  });

  it("POSIX folders are 0700 and files 0600; Windows inherits its ACL", () => {
    expect([
      ARCHIVE_ROOTS.linux.dirMode,
      ARCHIVE_ROOTS.linux.fileMode,
      ARCHIVE_ROOTS.macosx.dirMode,
      ARCHIVE_ROOTS.macosx.fileMode,
    ]).toEqual([0o700, 0o600, 0o700, 0o600]);
    expect([ARCHIVE_ROOTS.win.dirMode, ARCHIVE_ROOTS.win.fileMode]).toEqual([null, null]);
  });
});

describe("guardFolder", () => {
  const linux: ForbiddenRoots = {
    profile: "/home/u/.zen/abc.default",
    greDir: "/opt/zen",
    appDir: "/opt/zen/browser",
    substitutions: ["/home/u/.zen/abc.default/chrome", "", "/usr/lib/zen-devtools"],
  };
  const win: ForbiddenRoots = {
    profile: "C:\\Users\\u\\AppData\\Roaming\\zen\\Profiles\\abc.default",
    greDir: "C:\\Program Files\\Zen Browser",
    appDir: "C:\\Program Files\\Zen Browser\\browser",
    substitutions: [],
  };

  it.each([
    [
      "the archive root",
      "/home/u/.local/share/hark",
      "linux",
      linux,
      { ok: true, folder: "/home/u/.local/share/hark" },
    ],
    [
      "a sibling whose name starts like the profile",
      "/home/u/.zen/abc.default-backup",
      "linux",
      linux,
      { ok: true, folder: "/home/u/.zen/abc.default-backup" },
    ],
    [
      "the AutoConfig chrome folder",
      "/home/u/.zen/abc.default/chrome/exports",
      "linux",
      linux,
      { ok: false, refusal: { kind: "inside", forbidden: "/home/u/.zen/abc.default" } },
    ],
    [
      "the profile itself",
      "/home/u/.zen/abc.default/",
      "linux",
      linux,
      { ok: false, refusal: { kind: "inside", forbidden: "/home/u/.zen/abc.default" } },
    ],
    [
      "a folder that contains the profile",
      "/home/u",
      "linux",
      linux,
      { ok: false, refusal: { kind: "contains", forbidden: "/home/u/.zen/abc.default" } },
    ],
    [
      "the file system root",
      "/",
      "linux",
      linux,
      { ok: false, refusal: { kind: "contains", forbidden: "/home/u/.zen/abc.default" } },
    ],
    [
      "a path that climbs back into the profile",
      "/home/u/Downloads/../.zen/abc.default/x",
      "linux",
      linux,
      { ok: false, refusal: { kind: "inside", forbidden: "/home/u/.zen/abc.default" } },
    ],
    [
      "linux is case-sensitive",
      "/home/u/.ZEN/abc.default",
      "linux",
      linux,
      { ok: true, folder: "/home/u/.ZEN/abc.default" },
    ],
    [
      "the GRE directory",
      "/opt/zen/defaults",
      "linux",
      linux,
      { ok: false, refusal: { kind: "inside", forbidden: "/opt/zen" } },
    ],
    [
      "a relative folder",
      "Downloads",
      "linux",
      linux,
      { ok: false, refusal: { kind: "not-absolute" } },
    ],
    [
      "windows ignores case",
      "c:\\users\\U\\appdata\\roaming\\ZEN\\profiles\\ABC.default\\chrome",
      "win",
      win,
      { ok: false, refusal: { kind: "inside", forbidden: win.profile } },
    ],
    [
      "windows forward slashes",
      "C:/Users/u/AppData/Roaming/zen/Profiles/abc.default",
      "win",
      win,
      { ok: false, refusal: { kind: "inside", forbidden: win.profile } },
    ],
    [
      "a windows downloads folder",
      "C:\\Users\\u\\Downloads\\",
      "win",
      win,
      { ok: true, folder: "C:\\Users\\u\\Downloads" },
    ],
    [
      "a windows drive-relative path",
      "\\Users\\u\\Downloads",
      "win",
      win,
      { ok: false, refusal: { kind: "not-absolute" } },
    ],
    [
      "macOS ignores case",
      "/USERS/u/library/application support/zen/profiles/x",
      "macosx",
      { ...linux, profile: "/Users/u/Library/Application Support/zen/Profiles/x" },
      {
        ok: false,
        refusal: {
          kind: "inside",
          forbidden: "/Users/u/Library/Application Support/zen/Profiles/x",
        },
      },
    ],
    [
      "a resource:// substitution outside the profile and the install",
      "/usr/lib/zen-devtools/exports",
      "linux",
      linux,
      { ok: false, refusal: { kind: "inside", forbidden: "/usr/lib/zen-devtools" } },
    ],
  ] as const)("%s", (_label, candidate, platform, forbidden, want) => {
    expect(guardFolder(candidate, forbidden, platform)).toEqual(want);
  });

  it("with the substitution check removed, a folder under one is accepted", async () => {
    const altered = await importAltered<typeof layout>("layout.ts", {
      id: "guard-ignores-substitutions",
      from: "    ...forbidden.substitutions,\n",
      to: "",
    });
    expect(altered.guardFolder("/usr/lib/zen-devtools/exports", linux, "linux")).toMatchObject({
      ok: true,
    });
  });
});

describe("archive key", () => {
  it("is the 16 random bytes in lowercase hex, and only that text parses back", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    const key = archiveKeyFromBytes(bytes);
    expect(key).toBe("00112233445566778899aabbccddeeff");
    expect(parseArchiveKey(`${key}\n`)).toBe(key);
    expect(() => archiveKeyFromBytes(bytes.subarray(0, 8))).toThrow(RangeError);
    for (const refused of [
      "9f86d081884c7d65",
      key.toUpperCase(),
      `${key}0`,
      ` ${key}`,
      `${key}\n\n`,
    ])
      expect(parseArchiveKey(refused)).toBeNull();
  });
});

describe("siteDirName", () => {
  const site = (raw: string) =>
    parseSite(raw) ??
    (() => {
      throw new Error(`${raw} must parse`);
    })();
  const long = (label: string) => `${label.repeat(60)}.example`;
  const SITES = [
    "example.com",
    "example.org",
    "xn--bcher-kva.example",
    "xn--bcher-kva-example",
    "127.0.0.1",
    "::1",
    "2001:db8::1",
    "2001:db8:0:0:0:0:0:1",
    "con",
    "con.example",
    "aux",
    "nul.example.com",
    "com1",
    "lpt9.example",
    "console.example",
    "_dmarc.example",
    "_5f.example",
    "a_b.example",
    long("a"),
    long("b"),
    `${"a".repeat(55)}x.example`,
    `${"a".repeat(55)}y.example`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
  ].map(site);

  it("is injective: no two sites share a directory", () => {
    const names = SITES.map(siteDirName);
    expect(new Set(names).size).toBe(SITES.length);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(SITES.length);
  });

  it.each(SITES.map((s) => [s]))("%s is a safe directory name on every platform", (s) => {
    const name = siteDirName(s);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9._~-]+$/);
    expect(name).not.toMatch(/\.$/);
    expect(name.split(".")[0]).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/);
  });

  it.each([
    ["example.com", "example.com"],
    ["::1", "_3a_3a1"],
    ["_dmarc.example", "_5fdmarc.example"],
    ["con", "_63on"],
    ["con.example", "_63on.example"],
    ["console.example", "console.example"],
  ])("%s becomes %s", (raw, want) => {
    expect(siteDirName(site(raw))).toBe(want);
  });

  it.each(SITES.filter((s) => !siteDirName(s).includes("~")).map((s) => [s]))(
    "%s reads back through parseSiteDir",
    (s) => {
      expect(parseSiteDir(siteDirName(s))).toBe(s);
    },
  );

  it("a name cut to length cannot be read back", () => {
    const cut = siteDirName(site(long("a")));
    expect(cut).toMatch(/^a{55}~[0-9a-f]{8}$/);
    expect(parseSiteDir(cut)).toBeNull();
  });

  it.each(["Example.com", "con", "_3A_3a1", "a_zz", "example.com.", "a/b", "", "..", "_e2_82_ac"])(
    "%j is not a name siteDirName makes",
    (dir) => {
      expect(parseSiteDir(dir)).toBeNull();
    },
  );
});

describe("archive names", () => {
  const run = "mhz01" as RunId;
  const id = "mhz01.15032385539" as ExchangeId;
  const s = "example.com" as Site;
  const segment = logSegmentId(s, run, 3);
  const pack = packId(s, run, 0);

  it("every path the store writes parses back to what built it", () => {
    expect(logSegmentPath(segment)).toEqual(["sites", "example.com", "log", "mhz01-3.jsonl"]);
    expect(parseArchiveName(logSegmentPath(segment))).toEqual({
      kind: "log",
      dir: "example.com",
      segment: "example.com/mhz01-3",
      run,
      seq: 3,
    });
    expect(logSummaryPath(segment)).toEqual([
      "sites",
      "example.com",
      "log",
      "mhz01-3.summary.json",
    ]);
    expect(parseArchiveName(logSummaryPath(segment))).toEqual({
      kind: "summary",
      dir: "example.com",
      segment,
      run,
    });
    expect(packPath(pack)).toEqual(["sites", "example.com", "packs", "mhz01-0.pack"]);
    expect(parseArchiveName(packPath(pack))).toEqual({
      kind: "pack",
      dir: "example.com",
      pack,
      run,
      seq: 0,
    });
    expect(partPath(id)).toEqual(["incoming", "mhz01.15032385539.part"]);
    expect(parseArchiveName(partPath(id))).toEqual({ kind: "part", id, run });
    expect(bodyFilePath(s, id)).toEqual([
      "sites",
      "example.com",
      "bodies",
      "mhz01.15032385539.body",
    ]);
    expect(parseArchiveName(bodyFilePath(s, id))).toEqual({
      kind: "body",
      dir: "example.com",
      id,
      run,
    });
    expect(parseArchiveName(["sites", "example.com"])).toEqual({
      kind: "site-dir",
      dir: "example.com",
    });
  });

  it("interrupted atomic writes are named with their run", () => {
    expect(parseArchiveName([`${LAYOUT.settings}${LAYOUT.tmpSuffix}`])).toEqual({
      kind: "tmp",
      of: "settings",
    });
    expect(parseArchiveName([`${LAYOUT.ledger}${LAYOUT.tmpSuffix}`])).toEqual({
      kind: "tmp",
      of: "ledger",
    });
    const tmp = [...logSummaryPath(segment).slice(0, -1), "mhz01-3.summary.json.tmp"];
    expect(parseArchiveName(tmp)).toEqual({
      kind: "tmp",
      of: "summary",
      dir: "example.com",
      segment,
      run,
    });
  });

  it("a site whose name was cut is named by its directory, like every other site", () => {
    const longSite = `${"a".repeat(60)}.example` as Site;
    const dir = "a".repeat(55);
    expect(siteDirName(longSite)).toMatch(new RegExp(`^${dir}~[0-9a-f]{8}$`));
    expect(parseArchiveName(logSegmentPath(logSegmentId(longSite, run, 0)))).toEqual({
      kind: "log",
      dir: siteDirName(longSite),
      segment: `${siteDirName(longSite)}/${run}-0`,
      run,
      seq: 0,
    });
  });

  it.each([
    [["settings.json"]],
    [["ledger.json"]],
    [["exports.jsonl"]],
    [["incoming"]],
    [["incoming", "notes.txt"]],
    [["incoming", "mhz01.15.part", "x"]],
    [["incoming", "mhz01.015.part"]],
    [["sites", "Example.com"]],
    [["sites", "example.com", "log"]],
    [["sites", "example.com", "log", "mhz01-03.jsonl"]],
    [["sites", "example.com", "log", "mhz01.jsonl"]],
    [["sites", "example.com", "packs", "mhz01-0.jsonl"]],
    [["sites", "example.com", "bodies", "mhz01-0.body"]],
    [["sites", "example.com", "other", "mhz01-0.pack"]],
    [["sites", "example.com", "log", "mhz01-0.jsonl", "x"]],
    [["desktop.ini"]],
    [[]],
  ])("%j is foreign and left alone", (path) => {
    expect(parseArchiveName(path)).toBeNull();
  });

  it("scoped ids parse only in their canonical form", () => {
    expect(parseLogSegmentId("example.com/mhz01-3")).toBe("example.com/mhz01-3");
    expect(parsePackId("example.com/mhz01-0")).toBe("example.com/mhz01-0");
    expect(parsePackId("example.com/mhz01-00")).toBeNull();
    expect(parseLogSegmentId("Example.com/mhz01-3")).toBeNull();
    expect(parseLogSegmentId("mhz01-3")).toBeNull();
  });
});
