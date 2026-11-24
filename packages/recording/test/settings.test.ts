import { describe, expect, it } from "vite-plus/test";

import {
  applySettingChange,
  DEFAULT_USER_SETTINGS,
  parseEditableSettings,
  parseSettingChange,
  parseStoredSettings,
  type EditableSettings,
} from "../src/settings.ts";

const MiB = 1_048_576;
const editable: EditableSettings = {
  version: 1,
  retention: {
    maxBodyBytes: DEFAULT_USER_SETTINGS.retention.maxBodyBytes,
    maxDetailBytes: DEFAULT_USER_SETTINGS.retention.maxDetailBytes,
    maxAgeDays: 14,
  },
  media: "details-only",
  secretStorage: "store",
  exportDefaults: { bodies: "include", secrets: "remove" },
};
const withRetention = (o: object) => ({ ...editable, retention: { ...editable.retention, ...o } });

describe("parseEditableSettings", () => {
  it("accepts the defaults unchanged, and ignores the site list, which excludeSite owns", () => {
    expect(
      parseEditableSettings({ ...DEFAULT_USER_SETTINGS, excludedSites: ["x.example"] }),
    ).toEqual(editable);
  });

  it("the defaults are 5 GiB of bodies, 1 GiB of details, 14 days", () => {
    expect(DEFAULT_USER_SETTINGS.retention).toEqual({
      maxBodyBytes: 5368709120,
      maxDetailBytes: 1073741824,
      maxAgeDays: 14,
    });
  });

  it.each([
    ["bodies under 64 MiB are raised to 64 MiB", { maxBodyBytes: 1 }, { maxBodyBytes: 64 * MiB }],
    ["bodies of exactly 64 MiB stay", { maxBodyBytes: 64 * MiB }, { maxBodyBytes: 64 * MiB }],
    [
      "details under 16 MiB are raised to 16 MiB",
      { maxDetailBytes: 0 },
      { maxDetailBytes: 16 * MiB },
    ],
    ["0 days is raised to 1", { maxAgeDays: 0 }, { maxAgeDays: 1 }],
    ["a large cap is kept", { maxBodyBytes: 200 * 1024 * MiB }, { maxBodyBytes: 200 * 1024 * MiB }],
  ])("%s", (_label, given, want) => {
    expect(parseEditableSettings(withRetention(given))?.retention).toEqual({
      ...editable.retention,
      ...want,
    });
  });

  it.each([
    ["a missing version", { ...editable, version: undefined }],
    ["a future version", { ...editable, version: 2 }],
    ["a negative cap", withRetention({ maxBodyBytes: -1 })],
    ["a fractional cap", withRetention({ maxDetailBytes: 16 * MiB + 0.5 })],
    ["a cap as a string", withRetention({ maxBodyBytes: "5368709120" })],
    ["fractional days", withRetention({ maxAgeDays: 1.5 })],
    ["an unknown media choice", { ...editable, media: "none" }],
    ["an unknown secret storage", { ...editable, secretStorage: "encrypt" }],
    [
      "an unknown export default",
      { ...editable, exportDefaults: { bodies: "include", secrets: "hash" } },
    ],
    ["no retention block", { ...editable, retention: null }],
    ["an array", [editable]],
    ["null", null],
  ])("rejects %s", (_label, raw) => {
    expect(parseEditableSettings(raw)).toBeNull();
  });
});

describe("parseStoredSettings", () => {
  const stored = {
    user: {
      ...DEFAULT_USER_SETTINGS,
      excludedSites: ["bank.example", "Bank.Example", "mail.example"],
    },
    exportFolder: { kind: "downloads" },
  };

  it("keeps the excluded sites, lowercased and without duplicates", () => {
    expect(parseStoredSettings(stored)).toEqual({
      user: { ...DEFAULT_USER_SETTINGS, excludedSites: ["bank.example", "mail.example"] },
      exportFolder: { kind: "downloads" },
    });
  });

  it("keeps a chosen export folder with its label", () => {
    const folder = { kind: "chosen", path: "/home/u/HAR exports", label: "HAR exports" };
    expect(parseStoredSettings({ ...stored, exportFolder: folder })?.exportFolder).toEqual(folder);
  });

  it.each([
    [
      "one excluded site that does not parse, so a site the user excluded is never recorded again",
      { ...stored, user: { ...stored.user, excludedSites: ["bank.example", "https://x/"] } },
    ],
    ["no site list", { ...stored, user: editable }],
    [
      "a chosen folder with no path",
      { ...stored, exportFolder: { kind: "chosen", path: "", label: "x" } },
    ],
    ["an unknown folder kind", { ...stored, exportFolder: { kind: "desktop" } }],
    ["user settings that do not parse", { ...stored, user: { ...stored.user, version: 3 } }],
    ["a torn file read as a string", '{"user":{"version":1'],
  ])("rejects %s", (_label, raw) => {
    expect(parseStoredSettings(raw)).toBeNull();
  });
});

describe("a change to one setting", () => {
  it.each([
    [
      { name: "maxBodyBytes", value: 2048 * MiB },
      { retention: { ...editable.retention, maxBodyBytes: 2048 * MiB } },
    ],
    [
      { name: "maxBodyBytes", value: 1 },
      { retention: { ...editable.retention, maxBodyBytes: 64 * MiB } },
    ],
    [{ name: "maxAgeDays", value: 3 }, { retention: { ...editable.retention, maxAgeDays: 3 } }],
    [{ name: "media", value: "keep-bodies" }, { media: "keep-bodies" }],
    [{ name: "secretStorage", value: "never-store" }, { secretStorage: "never-store" }],
    [
      { name: "bodies", value: "omit" },
      { exportDefaults: { ...editable.exportDefaults, bodies: "omit" } },
    ],
    [
      { name: "secrets", value: "keep" },
      { exportDefaults: { ...editable.exportDefaults, secrets: "keep" } },
    ],
  ] as const)("%o changes that setting alone", (raw, changed) => {
    const change = parseSettingChange(raw);
    expect(change).not.toBeNull();
    expect(applySettingChange(editable, change!)).toEqual({ ...editable, ...changed });
  });

  it.each([
    { name: "version", value: 2 },
    { name: "excludedSites", value: [] },
    { name: "maxBodyBytes", value: -1 },
    { name: "maxAgeDays", value: "3" },
    { name: "media", value: "everything" },
    { name: "bodies" },
    "maxBodyBytes",
  ])("refuses %o", (raw) => {
    expect(parseSettingChange(raw)).toBeNull();
  });
});
