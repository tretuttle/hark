import { describe, expect, it } from "vite-plus/test";

import { formatHarFilename } from "../src/filename.ts";
import { toIsoDateTime } from "../src/model.ts";

describe("formatHarFilename", () => {
  it("builds a sortable, cross-platform safe filename from host, time range, and options", () => {
    const name = formatHarFilename({
      host: "Api.Example.com:8443",
      timeRange: {
        start: toIsoDateTime("2026-11-16T00:05:00.000-05:00")!,
        end: toIsoDateTime("2026-11-16T05:12:30.000Z")!,
      },
      scope: "tab",
      includeBodies: false,
      redacted: true,
      extension: "har.zip",
    });

    expect(name).toBe(
      "api.example.com-8443_20261116-050500Z_to_20261116-051230Z_tab_headers-only_redacted.har.zip",
    );

    const earlier = formatHarFilename({
      host: "api.example.com",
      timeRange: { start: toIsoDateTime("2026-11-16T04:00:00Z")! },
    });
    const later = formatHarFilename({
      host: "api.example.com",
      timeRange: { start: toIsoDateTime("2026-11-16T06:00:00Z")! },
    });
    expect(earlier < later).toBe(true);
  });

  it("sanitizes forbidden Windows path characters, traversal dots, and reserved device names", () => {
    expect(formatHarFilename({ host: "CON" })).toBe("con-host.har");
    expect(formatHarFilename({ host: "../etc/passwd" })).toBe("etc-passwd.har");
    expect(formatHarFilename({ host: "..", scope: "all" })).toBe("all-sites.har");
    expect(formatHarFilename({ host: 'evil<host>:80/"bad"|?*name' })).toBe(
      "evil-host-80-bad-name.har",
    );
  });

  it("truncates only the host segment when enforcing maxLength so timestamp and extension stay intact", () => {
    const longHost = `${"a".repeat(200)}.example.com`;
    const name = formatHarFilename({
      host: longHost,
      timeRange: { start: toIsoDateTime("2026-11-16T05:00:00Z")! },
      redacted: true,
      maxLength: 64,
    });

    expect(name.length).toBe(64);
    expect(name.endsWith("_20261116-050000Z_redacted.har")).toBe(true);
    expect(name.startsWith(".")).toBe(false);

    const dotBoundary = formatHarFilename({
      host: "api.service.example.com",
      timeRange: { start: toIsoDateTime("2026-11-16T05:00:00Z")! },
      maxLength: 25,
    });
    expect(dotBoundary).toBe("api_20261116-050000Z.har");
    expect(dotBoundary).not.toContain("._");
  });

  it("drops URL userinfo and keeps the filename tail inside maxLength", () => {
    expect(formatHarFilename({ host: "https://alice:hunter2@example.com/x" })).toBe(
      "example.com.har",
    );

    const name = formatHarFilename({
      host: "example.com",
      maxLength: 40,
      timeRange: { start: 0, end: 3_600_000 },
      scope: "tab",
      includeBodies: false,
      redacted: true,
      extension: "har.zip",
    });

    expect(name).toBe("example.com.har.zip");
    expect(name.includes("alice")).toBe(false);
    expect(name.includes("hunter2")).toBe(false);
    expect(name.startsWith(".")).toBe(false);

    expect(formatHarFilename({ host: "example.com", maxLength: 4 })).toBe("har");
    expect(formatHarFilename({ host: "example.com", maxLength: 0 })).toBe("");
    expect(formatHarFilename({ host: "example.com", maxLength: 3, extension: "har.zip" })).toBe(
      "zip",
    );
  });
});
