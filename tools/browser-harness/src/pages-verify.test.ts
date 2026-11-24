import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  checkCapAtStart,
  checkEmptySelection,
  checkExclusion,
  checkFolderRefused,
  checkProblemLink,
  compareSettings,
  checkStatusBlock,
  settingsOnDisk,
  type Exclusion,
  type SettingsReading,
} from "./pages-verify.ts";

describe("an empty selection", () => {
  const held = { buttonDisabled: true, jobsBefore: 1, jobsAfter: 1, apiRefused: true };
  it("passes when nothing can start an export", () => {
    expect(checkEmptySelection(held)).toEqual([]);
  });
  it.each([
    [{ buttonDisabled: false }, "enabled"],
    [{ jobsAfter: 2 }, "started 1 export"],
    [{ apiRefused: false }, "accepted an empty session list"],
  ] as const)("catches %o", (broken, said) => {
    expect(checkEmptySelection({ ...held, ...broken }).join()).toContain(said);
  });
});

describe("excluding a site", () => {
  const kept = { prompts: 0, onDisk: true, listed: true };
  const asked: Exclusion = {
    asked: { ...kept, prompts: 1 },
    cancelled: kept,
    confirmed: { prompts: 0, onDisk: false, listed: false, inSettings: true },
    revisited: { onDisk: false, listed: false },
  };
  it("passes when it asks once and then deletes", () => {
    expect(checkExclusion("s03.localhost", asked)).toEqual([]);
  });
  it.each([
    [
      "deleted with no question",
      { asked: { prompts: 0, onDisk: false, listed: false } },
      "asked 0 times",
    ],
    ["asked twice", { confirmed: { ...asked.confirmed, prompts: 1 } }, "asked again"],
    ["data left on disk", { confirmed: { ...asked.confirmed, onDisk: true } }, "still on disk"],
    ["Cancel deleted it", { cancelled: { ...kept, onDisk: false } }, "Cancel did not keep"],
    ["recorded again", { revisited: { onDisk: true, listed: true } }, "recorded again"],
  ] as const)("catches %s", (_name, broken, said) => {
    expect(checkExclusion("s03.localhost", { ...asked, ...broken }).join()).toContain(said);
  });
});

describe("the status block", () => {
  const text =
    "Recording is on. Recording runs whenever the browser is open and cannot be turned off.";
  it("passes when it says so and nothing switches recording", () => {
    expect(
      checkStatusBlock({ text, controls: ["Choose folder", "Exclude", "Record again"] }),
    ).toEqual([]);
  });
  it("catches a missing sentence and a recording switch", () => {
    expect(checkStatusBlock({ text: "Recording is on.", controls: [] }).join()).toContain(
      "does not say",
    );
    expect(checkStatusBlock({ text, controls: ["Pause recording"] }).join()).toContain("switch");
    expect(checkStatusBlock({ text, controls: ["Recording off"] }).join()).toContain("switch");
  });
});

describe("settings", () => {
  const set: SettingsReading = {
    maxBodyBytes: 67_108_864,
    maxAgeDays: 3,
    media: "keep-bodies",
    secretStorage: "never-store",
    bodies: "omit",
    secrets: "remove",
    excludedSites: ["s09.localhost"],
  };
  it("compares field by field, and reads settings.json without the product", () => {
    const disk = settingsOnDisk(
      JSON.stringify({
        user: {
          version: 1,
          retention: { maxBodyBytes: 67_108_864, maxDetailBytes: 1, maxAgeDays: 3 },
          excludedSites: ["s09.localhost"],
          media: "keep-bodies",
          secretStorage: "never-store",
          exportDefaults: { bodies: "omit", secrets: "remove" },
        },
        exportFolder: { kind: "downloads" },
      }),
    );
    expect(compareSettings("disk", set, disk)).toEqual([]);
    expect(compareSettings("page", set, { ...set, maxAgeDays: 14, media: "details-only" })).toEqual(
      ["page: maxAgeDays is 14, set to 3", 'page: media is "details-only", set to "keep-bodies"'],
    );
    expect(compareSettings("disk", set, null)).toEqual(["disk: no settings"]);
  });
});

describe("a folder inside the profile", () => {
  const before = { kind: "downloads" };
  it("passes when refused with the profile named and nothing saved", () => {
    expect(
      checkFolderRefused(
        { shown: "That folder is inside the browser profile.", saved: before },
        before,
      ),
    ).toEqual([]);
  });
  it("catches an accepted folder and a refusal with no reason", () => {
    const saved = { kind: "chosen", path: "/p/exports" };
    expect(checkFolderRefused({ shown: null, saved }, before)).toHaveLength(2);
    expect(checkFolderRefused({ shown: "Not chosen.", saved: before }, before).join()).toContain(
      "no reason",
    );
  });
});

describe("a problem row's link", () => {
  const text =
    "Files skipped at startup. When the browser started, some files in the recording folder could not be read, so they were skipped. What you can do: restart the browser.";
  it("passes when it opens its section in view", () => {
    expect(
      checkProblemLink({
        section: "unreadable-files",
        hash: "#unreadable-files",
        found: true,
        inView: true,
        text,
      }),
    ).toEqual([]);
  });
  it("catches a link to the wrong place and a section that is missing or empty", () => {
    expect(
      checkProblemLink({
        section: "unreadable-files",
        hash: "#storage",
        found: true,
        inView: true,
        text,
      }).join(),
    ).toContain("opened #storage");
    expect(
      checkProblemLink({
        section: "export-holding",
        hash: "#export-holding",
        found: false,
        inView: false,
        text: "",
      }).join(),
    ).toContain("no such section");
    expect(
      checkProblemLink({
        section: "export-holding",
        hash: "#export-holding",
        found: true,
        inView: true,
        text: "Soon.",
      }).join(),
    ).toContain("what the user can do");
  });
});

describe("a lowered cap at the next start", () => {
  const body = (n: number) => Buffer.alloc(n, n % 251);
  const sha = (b: Buffer) => NodeCrypto.createHash("sha256").update(b).digest("hex");
  const served = [1, 2, 3].map((seq) => ({ seq, bytes: body(seq * 1000) }));
  const server = {
    host: "127.0.0.1:1",
    server: {
      getRequestLog: () =>
        served.map((s) => ({
          seq: s.seq,
          method: "GET",
          path: `/b${String(s.seq)}`,
          url: `/b${String(s.seq)}`,
          status: 200,
        })),
      getSequenceTruth: (seq: number) => {
        const s = served.find((x) => x.seq === seq);
        return s === undefined
          ? undefined
          : ({
              seq,
              path: `/b${String(seq)}`,
              decodedLength: s.bytes.length,
              decodedSha256: sha(s.bytes),
            } as never);
      },
    },
  };
  const entry = (seq: number, kept: boolean) => ({
    request: { url: `http://127.0.0.1:1/b${String(seq)}` },
    response: {
      headers: [{ name: "X-Seq", value: String(seq) }],
      content: kept ? { text: body(seq * 1000).toString("base64"), encoding: "base64" } : {},
    },
    ...(kept ? {} : { _harExport: { bodyMissing: "removed-by-retention" } }),
  });
  const har = (entries: readonly unknown[]) => JSON.stringify({ log: { entries } });
  const base = { cap: 4000, bodyBytesOnDisk: 3000, slack: 0, server };

  it("passes when the oldest bodies are removed, the rest exact and every request kept", () => {
    const verdict = checkCapAtStart({
      ...base,
      har: har([entry(1, false), entry(2, true), entry(3, true)]),
    });
    expect(verdict).toEqual({ exact: 2, removed: 1, problems: [] });
  });
  it.each([
    ["a request lost", { har: har([entry(2, true), entry(3, true)]) }, "lost GET /b1"],
    [
      "over the cap on disk",
      { bodyBytesOnDisk: 5000, har: har([entry(1, false), entry(2, true), entry(3, true)]) },
      "cap 4000",
    ],
    [
      "no body removed",
      { har: har([entry(1, true), entry(2, true), entry(3, true)]) },
      "did not apply",
    ],
    [
      "everything removed",
      { har: har([entry(1, false), entry(2, false), entry(3, false)]) },
      "no body is left",
    ],
  ] as const)("catches %s", (_name, broken, said) => {
    expect(checkCapAtStart({ ...base, ...broken }).problems.join()).toContain(said);
  });
  it("catches a flipped byte in a kept body", () => {
    const flipped = entry(2, true);
    const bytes = body(2000);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const altered = {
      ...flipped,
      response: {
        ...flipped.response,
        content: { text: bytes.toString("base64"), encoding: "base64" },
      },
    };
    expect(
      checkCapAtStart({
        ...base,
        har: har([entry(1, false), altered, entry(3, true)]),
      }).problems.join(),
    ).toContain("wrong body bytes");
  });
});
