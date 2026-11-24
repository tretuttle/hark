import { describe, expect, it } from "vite-plus/test";

import type { ByteCount, Site } from "../src/ids.ts";
import type * as routes from "../src/routes.ts";
import {
  BODY_ROUTES,
  chooseRoute,
  compileRoutes,
  firstGate,
  resolveRow,
  type BodyRoute,
  type BodyRouteId,
  type CaptureAction,
  type GateFacts,
  type GateId,
  type RouteFacts,
} from "../src/routes.ts";
import { importAltered } from "./alter.ts";

const MiB = 1_048_576;
const compiled = compileRoutes({
  platform: "linux",
  excluded: [],
  keepMedia: false,
  maxBodyBytes: (5120 * MiB) as ByteCount,
  supported: ["memory-tee", "file-tee"],
});
const head = (o: Partial<RouteFacts>): RouteFacts => ({
  method: "GET",
  status: 200,
  source: "network",
  mimeType: "application/json",
  contentLength: null,
  hasLocation: false,
  ...o,
});
const len = (n: number) => n as ByteCount;

// Response heads, each with the row it must reach.
const CATALOGUE: readonly (readonly [string, RouteFacts, BodyRouteId])[] = [
  ["10 MiB chunked JSON POST", head({ method: "POST" }), "large-or-unknown"],
  ["9 MiB HTTP/2 streamed JSON, no-store", head({}), "large-or-unknown"],
  ["60 MiB chunked cacheable JSON", head({}), "large-or-unknown"],
  ["exactly 8 MiB with a length", head({ contentLength: len(8 * MiB) }), "large-or-unknown"],
  [
    "302 with Location and a body",
    head({ status: 302, contentLength: len(41), hasLocation: true }),
    "redirect",
  ],
  [
    "307 with Location",
    head({ status: 307, contentLength: len(23), hasLocation: true }),
    "redirect",
  ],
  [
    "a 302 without Location reaches the page",
    head({ status: 302, contentLength: len(41) }),
    "small",
  ],
  ["304 at examine-response", head({ status: 304 }), "awaiting-merge"],
  [
    "the merged head of that 304",
    head({ source: "revalidated", contentLength: len(20_000) }),
    "small",
  ],
  ["service-worker synthesized, no length", head({ source: "service-worker" }), "large-or-unknown"],
  [
    "service-worker passthrough, 22 bytes",
    head({ source: "service-worker", contentLength: len(22) }),
    "small",
  ],
  [
    "a 4 MiB cacheable download",
    head({ mimeType: "application/octet-stream", contentLength: len(4 * MiB) }),
    "large-or-unknown",
  ],
  ["a 14-byte poll response", head({ contentLength: len(14) }), "small"],
  [
    "cache hit at examine-cached-response",
    head({ source: "cache", contentLength: len(30_000) }),
    "small",
  ],
  ["HEAD", head({ method: "HEAD", contentLength: len(100) }), "no-body"],
  ["101 upgrade", head({ status: 101 }), "no-body"],
  ["204", head({ status: 204 }), "no-body"],
  ["SSE", head({ mimeType: "text/event-stream" }), "streaming"],
  ["endless ndjson, no length", head({ mimeType: "application/x-ndjson" }), "large-or-unknown"],
  [
    "video while media is off",
    head({ mimeType: "video/mp4", contentLength: len(16_384), status: 206 }),
    "media-details",
  ],
  [
    "audio while media is off",
    head({ mimeType: "audio/ogg", contentLength: len(4096) }),
    "media-details",
  ],
  ["205 Reset Content", head({ status: 205 }), "no-body"],
  [
    "an MJPEG camera over multipart/x-mixed-replace",
    head({ mimeType: "multipart/x-mixed-replace" }),
    "streaming",
  ],
  ["1 byte under the cutoff", head({ contentLength: len(MiB - 1) }), "small"],
  ["at the cutoff", head({ contentLength: len(MiB) }), "large-or-unknown"],
];

const firstRow = (rows: readonly BodyRoute[], facts: RouteFacts) =>
  rows.find((r) => r.when(facts, compiled))?.id;

describe("BODY_ROUTES", () => {
  it.each(CATALOGUE)("%s reaches its row", (_label, facts, want) => {
    expect(chooseRoute(compiled, facts).id).toBe(want);
  });

  it("every catalogue head reaches exactly one row, and every row is reached", () => {
    expect(CATALOGUE.map(([, facts]) => firstRow(BODY_ROUTES, facts))).toEqual(
      CATALOGUE.map(([, , want]) => want),
    );
    expect(new Set(CATALOGUE.map(([, , want]) => want))).toEqual(
      new Set(BODY_ROUTES.map((r) => r.id)),
    );
  });

  it("the redirect row swapped with the small row misroutes a head", () => {
    const swapped = [...BODY_ROUTES];
    const i = swapped.findIndex((r) => r.id === "redirect");
    const j = swapped.findIndex((r) => r.id === "small");
    [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
    expect(
      CATALOGUE.filter(([, facts, want]) => firstRow(swapped, facts) !== want).map(
        ([label]) => label,
      ),
    ).toContain("302 with Location and a body");
  });

  // Each change drops one case from a row's rule; exactly the head that case covers is misrouted.
  it.each([
    { id: "media-ignores-audio", from: 'f.mimeType?.startsWith("audio/") === true || ', to: "" },
    { id: "no-body-ignores-205", from: " ||\n      f.status === 205", to: "" },
    { id: "streaming-ignores-multipart", from: ', "multipart/x-mixed-replace"', to: "" },
  ])("with $id, one catalogue head is misrouted", async (m) => {
    const altered = await importAltered<typeof routes>("routes.ts", m);
    const misrouted = CATALOGUE.filter(
      ([, facts, want]) => altered.chooseRoute(compiled, facts).id !== want,
    );
    expect(misrouted.length).toBe(1);
  });

  it.each(BODY_ROUTES.map((r) => r.id))("without row %s some head is misrouted", (id) => {
    const without = BODY_ROUTES.filter((r) => r.id !== id);
    expect(CATALOGUE.some(([, facts, want]) => firstRow(without, facts) !== want)).toBe(true);
  });
});

describe("chooseRoute resolves a row against the backend's actions", () => {
  const withActions = (supported: readonly CaptureAction[], keepMedia = false) =>
    compileRoutes({
      platform: "win",
      excluded: [],
      keepMedia,
      maxBodyBytes: (64 * MiB) as ByteCount,
      supported,
    });

  it.each([
    [
      "a small body on the experiment host",
      withActions(["memory-tee", "file-tee"]),
      head({ contentLength: len(14) }),
      { id: "small", kind: "memory-tee", cap: 14 },
    ],
    [
      "an unknown length on the experiment host",
      withActions(["memory-tee", "file-tee"]),
      head({}),
      { id: "large-or-unknown", kind: "file-tee", cap: 16 * MiB },
    ],
    [
      "a small body on the standard host",
      withActions(["stream-filter"]),
      head({ contentLength: len(14) }),
      { id: "small", kind: "stream-filter", cap: 16 * MiB },
    ],
    [
      "a body on a host with no action",
      withActions([]),
      head({ contentLength: len(14) }),
      { id: "small", kind: "not-kept", reason: "not-recordable-here" },
    ],
    [
      "video with media bodies kept",
      withActions(["file-tee"], true),
      head({ mimeType: "video/mp4" }),
      { id: "large-or-unknown", kind: "file-tee", cap: 16 * MiB },
    ],
    [
      "a 304 from the network",
      withActions(["file-tee"]),
      head({ status: 304 }),
      { id: "awaiting-merge", kind: "awaiting-merge" },
    ],
    [
      "a redirect hop",
      withActions(["file-tee"]),
      head({ status: 301, hasLocation: true }),
      { id: "redirect", kind: "empty" },
    ],
    [
      "SSE",
      withActions(["file-tee"]),
      head({ mimeType: "text/event-stream" }),
      { id: "streaming", kind: "not-kept", reason: "streaming-response" },
    ],
  ])("%s", (_label, routes, facts, want) => {
    expect(chooseRoute(routes, facts)).toEqual(want);
  });

  it("a memory tee is never chosen without a declared length, even if a row lists it", () => {
    const row: BodyRoute = {
      id: "large-or-unknown",
      when: () => true,
      outcome: { kind: "copy", actions: ["memory-tee"] },
    };
    expect(resolveRow(row, withActions(["memory-tee"]), head({}))).toEqual({
      id: "large-or-unknown",
      kind: "not-kept",
      reason: "not-recordable-here",
    });
    expect(resolveRow(row, withActions(["memory-tee"]), head({ contentLength: len(9) }))).toEqual({
      id: "large-or-unknown",
      kind: "memory-tee",
      cap: 9,
    });
  });

  it("the body file cap is a quarter of the body retention limit", () => {
    expect(compiled.bodyFileCap).toBe(1280 * MiB);
    expect(compiled.memoryTeeMax).toBe(MiB);
  });
});

describe("GATES", () => {
  const ordinary: GateFacts = {
    privateBrowsingId: 0,
    triggeringIsSystem: false,
    browsingContextId: 12,
    loadingScheme: "https",
    topSite: "example.com" as Site,
  };
  const excluded = new Set(["blocked.example" as Site]);
  it.each([
    ["an ordinary tab request", ordinary, null],
    [
      "a private window",
      { ...ordinary, privateBrowsingId: 1, loadingScheme: "moz-extension" },
      "private-window",
    ],
    [
      "a browser-internal load",
      { ...ordinary, triggeringIsSystem: true, browsingContextId: 0 },
      "browser-internal",
    ],
    ["a service worker's own channel", { ...ordinary, browsingContextId: 0 }, null],
    ["a system-triggered load in a tab", { ...ordinary, triggeringIsSystem: true }, null],
    ["an extension page", { ...ordinary, loadingScheme: "moz-extension" }, "extension-page"],
    ["an excluded site", { ...ordinary, topSite: "blocked.example" as Site }, "excluded-site"],
    ["a channel with no site", { ...ordinary, topSite: null }, null],
  ] satisfies readonly (readonly [string, GateFacts, GateId | null])[])(
    "%s",
    (_label, facts, want) => {
      expect(firstGate(facts, excluded)).toBe(want);
    },
  );
});
