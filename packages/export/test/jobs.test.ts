import { describe, expect, it } from "vite-plus/test";
import { parseExportId, parseExportRequest } from "../src/jobs.ts";
import { M0 } from "./fixtures.ts";
import { importAltered } from "./alter.ts";

const validSelection = {
  scope: "everything",
  range: { kind: "last", minutes: 15 },
  include: "all",
};

const validRequest = {
  selection: validSelection,
  bodies: "include",
  redaction: "standard",
  packaging: "har",
  fileName: null,
};

describe("parseExportRequest rejection table", () => {
  it.each([
    ["null", null],
    ["array", []],
    [
      "invalid selection",
      {
        ...validRequest,
        selection: { scope: "everything", range: { kind: "last", minutes: 0 }, include: "all" },
      },
    ],
    ["bad bodies", { ...validRequest, bodies: "partial" }],
    ["bad redaction", { ...validRequest, redaction: "remove" }],
    ["har.zip packaging", { ...validRequest, packaging: "har.zip" }],
    ["har.gz packaging", { ...validRequest, packaging: "har.gz" }],
    ["unknown packaging", { ...validRequest, packaging: "json" }],
    ["empty fileName", { ...validRequest, fileName: "" }],
    ["whitespace fileName", { ...validRequest, fileName: "   " }],
    ["path traversal fileName", { ...validRequest, fileName: "../secret.har" }],
    ["slash in fileName", { ...validRequest, fileName: "dir/file.har" }],
    ["colon in fileName", { ...validRequest, fileName: "C:file.har" }],
    ["number fileName", { ...validRequest, fileName: 42 }],
    ["undefined fileName", { ...validRequest, fileName: undefined }],
  ])("rejects %s", (_label, raw) => {
    expect(parseExportRequest(raw)).toBeNull();
  });

  it("accepts valid requests with null or sanitized fileName", () => {
    expect(parseExportRequest(validRequest)).toEqual(validRequest);
    expect(parseExportRequest({ ...validRequest, fileName: "capture.har" })).toEqual({
      ...validRequest,
      fileName: "capture.har",
    });
  });

  it("with har.zip accepted in ACCEPTED_PACKAGING, a har.zip request parses", async () => {
    const altered = await importAltered<{ parseExportRequest: typeof parseExportRequest }>(
      "jobs.ts",
      {
        id: "accept-har-zip",
        from: '  "har.zip": false,',
        to: '  "har.zip": true,',
      },
    );
    expect(altered.parseExportRequest({ ...validRequest, packaging: "har.zip" })).not.toBeNull();
  });
});

describe("parseExportId", () => {
  it.each([
    ["exp-1", "exp-1"],
    ["job_42.a", "job_42.a"],
    ["", null],
    ["../job", null],
    ["job/1", null],
    ["a".repeat(65), null],
    [123, null],
    [null, null],
  ])("parses %j as %j", (raw, want) => {
    expect(parseExportId(raw)).toBe(want);
  });

  it("minute fixture stays aligned", () => {
    expect(M0 % 60_000).toBe(0);
  });
});
