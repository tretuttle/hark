import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  isHarUrl,
  isIsoDateTime,
  isMimeType,
  isPageId,
  isoDateTimeFromEpochMs,
  toHarUrl,
  toIsoDateTime,
  toMimeType,
  toPageId,
  type HarUrl,
  type IsoDateTime,
  type MimeType,
  type PageId,
} from "../src/model.ts";

describe("HAR branded primitives", () => {
  it("keeps distinct branded string types incompatible at compile time", () => {
    expectTypeOf<IsoDateTime>().not.toEqualTypeOf<HarUrl>();
    expectTypeOf<PageId>().not.toEqualTypeOf<HarUrl>();
    expectTypeOf<MimeType>().not.toEqualTypeOf<IsoDateTime>();
  });

  it("validates ISO 8601 timestamps including leap years and rejects invalid calendar dates", () => {
    expect(isIsoDateTime("2026-11-16T00:08:08.123Z")).toBe(true);
    expect(isIsoDateTime("2009-07-24T19:20:30.45+01:00")).toBe(true);
    expect(isIsoDateTime("2024-02-29T12:00:00-05:00")).toBe(true);
    expect(isIsoDateTime("2025-02-29T12:00:00Z")).toBe(false);
    expect(isIsoDateTime("2026-02-30T12:00:00Z")).toBe(false);
    expect(isIsoDateTime("2026-11-16 00:08:08Z")).toBe(false);
    expect(isIsoDateTime("https://example.com")).toBe(false);

    expect(toIsoDateTime("2026-11-16T00:08:08Z")).toBe("2026-11-16T00:08:08Z");
    expect(toIsoDateTime("invalid")).toBeNull();
    expect(isoDateTimeFromEpochMs(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("takes a string as a URL exactly when the URL Standard parses it as an absolute URL", () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["https://example.com/path?a=1", true],
      ["http://[::1]:8080/health", true],
      ["wss://socket.example.com/feed", true],
      ["data:text/plain;base64,SGVsbG8=", true],
      ["moz-extension://uuid-123/sidebar.html", true],
      ["blob:https://user:secret@/no-host", true],
      ["https://example.com/with space", true],
      ["https:example.com", true],
      ["  https://example.com/  ", true],
      ["about:", true],
      ["file:///tmp/a", true],
      ["", false],
      ["/relative/path", false],
      ["https://", false],
      ["https://user:SECRET%40example.com/path", false],
      ["https://[fe80::1%25eth0]/", false],
      ["https://256.1.1.1/", false],
      ["foo://u@/x", false],
      ["file://user@host/x", false],
    ];
    for (const [value, valid] of cases) {
      expect(isHarUrl(value), value).toBe(valid);
    }
    expect(toHarUrl("https://example.com")).toBe("https://example.com");
    expect(toHarUrl("/relative")).toBeNull();
  });

  it("validates page IDs and MIME types", () => {
    expect(isPageId("page_0")).toBe(true);
    expect(isPageId("")).toBe(false);
    expect(toPageId("page_1")).toBe("page_1");
    expect(toPageId("")).toBeNull();

    expect(isMimeType("application/json; charset=utf-8")).toBe(true);
    expect(isMimeType("text/html")).toBe(true);
    expect(isMimeType("")).toBe(false);
    expect(isMimeType("not-a-mime")).toBe(false);
    expect(toMimeType("text/plain")).toBe("text/plain");
    expect(toMimeType("invalid")).toBeNull();
  });
});
