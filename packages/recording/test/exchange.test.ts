import { describe, expect, it } from "vite-plus/test";

import {
  abandon,
  bodyAvailability,
  examine,
  open,
  settle,
  SETTLE_RULES,
  unanswered,
  type BodyAvailability,
  type BodyLocation,
  type Capture,
  type DiskInventory,
  type ExamineTopic,
  type NetError,
  type SettledBody,
  type SettledExchange,
  type SettleInput,
  type SinkResult,
  type StopFacts,
} from "../src/exchange.ts";
import type { ByteCount, PackId, Site } from "../src/ids.ts";
import type { Route } from "../src/routes.ts";
import { facts, ID, request, response, SITE, stop, T0 } from "./fixtures.ts";

const MiB = 1_048_576;
const bytes = (n: number) => n as ByteCount;
const PACK = "example.com/mhz02-0" as PackId;
const inPack: BodyLocation = { kind: "pack", pack: PACK, offset: 4096, length: bytes(14) };
const inFile: BodyLocation = { kind: "file", site: SITE, id: ID, length: bytes(1280 * MiB) };
const none = { kind: "none" } as const;
const failed = (error: string): StopFacts["status"] => ({
  kind: "failed",
  error: error as NetError,
});

type Phase<P extends Capture["phase"]> = Extract<Capture, { readonly phase: P }>;
const decided = (route: Extract<Route, { kind: "empty" | "not-kept" }>): Phase<"decided"> => ({
  phase: "decided",
  id: ID,
  facts,
  route,
  upload: none,
});
const copying = (
  route: Extract<Route, { kind: "memory-tee" | "file-tee" }>,
  contentLength: number | null = 14,
): Phase<"copying"> => ({
  phase: "copying",
  id: ID,
  facts: {
    request,
    response: { ...response, contentLength: contentLength === null ? null : bytes(contentLength) },
  },
  route,
  upload: none,
});
const memoryTee = copying({ id: "small", kind: "memory-tee", cap: bytes(14) });
const fileTee = copying({ id: "large-or-unknown", kind: "file-tee", cap: bytes(1280 * MiB) }, null);
const closed = (n: number, cappedAt: number | null = null): SinkResult => ({
  kind: "closed",
  bytes: bytes(n),
  cappedAt: cappedAt === null ? null : bytes(cappedAt),
});
const stopWith = (o: Partial<StopFacts>): StopFacts => ({ ...stop, ...o });

interface SettleCase {
  readonly label: string;
  readonly input: SettleInput;
  readonly at: BodyLocation | null;
  /** The rule that applies. The first three read only the capture's phase and route; SETTLE_RULES holds the rest. */
  readonly rule: string;
  readonly body: SettledBody;
}
const BY_PHASE = ["decided-empty", "decided-not-kept", "unmerged-304"];

// Expected values written out by hand, at least one case per rule.
const SETTLE_CASES: readonly SettleCase[] = [
  {
    label: "a redirect hop stops with NS_BINDING_REDIRECTED",
    input: {
      capture: decided({ id: "redirect", kind: "empty" }),
      stop: stopWith({ status: { kind: "redirected" }, encodedBodySize: bytes(0) }),
      sink: null,
    },
    at: null,
    rule: "decided-empty",
    body: { kind: "empty" },
  },
  {
    label: "video while media is off",
    input: {
      capture: decided({ id: "media-details", kind: "not-kept", reason: "media-setting" }),
      stop,
      sink: null,
    },
    at: null,
    rule: "decided-not-kept",
    body: { kind: "not-kept", reason: "media-setting" },
  },
  {
    label: "a 304 the page received itself",
    input: {
      capture: { phase: "awaiting-merge", id: ID, facts, upload: none },
      stop: stopWith({ encodedBodySize: bytes(0) }),
      sink: null,
    },
    at: null,
    rule: "unmerged-304",
    body: { kind: "empty" },
  },
  {
    label: "an endless stream cut at the body cap, then aborted by navigation",
    input: {
      capture: fileTee,
      stop: stopWith({ status: failed("NS_BINDING_ABORTED"), encodedBodySize: bytes(4000 * MiB) }),
      sink: closed(1280 * MiB, 1280 * MiB),
    },
    at: inFile,
    rule: "capped",
    body: { kind: "stored", at: inFile, encoding: null, check: "first-part" },
  },
  {
    label: "scan-timeout with kept prefix records stored scan-timeout body",
    input: {
      capture: fileTee,
      stop: stopWith({ encodedBodySize: bytes(4096) }),
      sink: { kind: "closed", bytes: bytes(1024), cappedAt: bytes(1024), cutWhy: "scan-timeout" },
    },
    at: inFile,
    rule: "capped",
    body: { kind: "stored", at: inFile, encoding: null, check: "scan-timeout" },
  },
  {
    label: "scan-timeout with 0 bytes kept records incomplete scan-timeout instead of first-part",
    input: {
      capture: fileTee,
      stop: stopWith({ encodedBodySize: bytes(4096) }),
      sink: { kind: "closed", bytes: bytes(0), cappedAt: bytes(0), cutWhy: "scan-timeout" },
    },
    at: null,
    rule: "capped",
    body: { kind: "incomplete", reason: "scan-timeout" },
  },
  {
    label: "a download cancelled after 1 MiB",
    input: {
      capture: fileTee,
      stop: stopWith({ status: failed("NS_BINDING_ABORTED"), encodedBodySize: bytes(MiB) }),
      sink: closed(MiB),
    },
    at: inFile,
    rule: "stop-failed",
    body: { kind: "incomplete", reason: "network-aborted" },
  },
  {
    label: "a sink that could not be created",
    input: { capture: memoryTee, stop, sink: { kind: "prepare-failed", why: "disk-full" } },
    at: null,
    rule: "prepare-failed",
    body: { kind: "incomplete", reason: "write-failed" },
  },
  {
    label: "a sink with 1 byte fewer than encodedBodySize",
    input: { capture: memoryTee, stop, sink: closed(13) },
    at: inPack,
    rule: "count-differs",
    body: { kind: "incomplete", reason: "write-failed" },
  },
  {
    label: "a declared empty body",
    input: {
      capture: copying({ id: "small", kind: "memory-tee", cap: bytes(0) }, 0),
      stop: stopWith({ encodedBodySize: bytes(0) }),
      sink: closed(0),
    },
    at: inPack,
    rule: "zero-bytes",
    body: { kind: "empty" },
  },
  {
    label: "a 14-byte poll response",
    input: { capture: memoryTee, stop, sink: closed(14) },
    at: inPack,
    rule: "length-matched",
    body: { kind: "stored", at: inPack, encoding: null, check: "length-matched" },
  },
  {
    label: "a service-worker passthrough: encodedBodySize 0, Content-Length 22",
    input: {
      capture: copying({ id: "small", kind: "memory-tee", cap: bytes(22) }, 22),
      stop: stopWith({ encodedBodySize: bytes(0) }),
      sink: closed(22),
    },
    at: inPack,
    rule: "length-matched",
    body: { kind: "stored", at: inPack, encoding: null, check: "length-matched" },
  },
  {
    label: "a matched body the store could not place",
    input: { capture: memoryTee, stop, sink: closed(14) },
    at: null,
    rule: "length-matched",
    body: { kind: "incomplete", reason: "write-failed" },
  },
  {
    label: "a synthesized service-worker body of unknown length",
    input: { capture: fileTee, stop: stopWith({ encodedBodySize: bytes(0) }), sink: closed(5014) },
    at: inFile,
    rule: "sink-only",
    body: { kind: "stored", at: inFile, encoding: null, check: "sink-only" },
  },
];

describe("settle", () => {
  it.each(SETTLE_CASES)("$label settles by $rule", ({ input, at, rule, body }) => {
    expect(
      input.sink === null ? BY_PHASE.includes(rule) : SETTLE_RULES.find((r) => r.when(input))?.id,
    ).toBe(input.sink === null ? true : rule);
    expect(settle(input, at).body).toEqual(body);
  });

  it("every settle rule is reached by a case", () => {
    expect(new Set(SETTLE_CASES.map((c) => c.rule))).toEqual(
      new Set([...BY_PHASE, ...SETTLE_RULES.map((r) => r.id)]),
    );
  });

  it.each([
    ["no-body", { id: "no-body", kind: "empty" }, { kind: "empty" }],
    ["redirect", { id: "redirect", kind: "empty" }, { kind: "empty" }],
    [
      "streaming",
      { id: "streaming", kind: "not-kept", reason: "streaming-response" },
      { kind: "not-kept", reason: "streaming-response" },
    ],
    [
      "media-details",
      { id: "media-details", kind: "not-kept", reason: "media-setting" },
      { kind: "not-kept", reason: "media-setting" },
    ],
    [
      "large-or-unknown",
      { id: "large-or-unknown", kind: "not-kept", reason: "not-recordable-here" },
      { kind: "not-kept", reason: "not-recordable-here" },
    ],
  ] satisfies readonly (readonly [
    string,
    Extract<Route, { kind: "empty" | "not-kept" }>,
    SettledBody,
  ])[])("a decided %s route settles to its own outcome, under its own id", (id, route, body) => {
    expect(settle({ capture: decided(route), stop, sink: null }, null)).toMatchObject({
      route: id,
      body,
    });
  });

  it("an answered exchange carries the capture's facts, stop and route", () => {
    const answered = settle({ capture: memoryTee, stop, sink: closed(14) }, inPack);
    expect(answered).toMatchObject({
      kind: "answered",
      request,
      stop,
      route: "small",
      upload: none,
    });
    expect(answered.response.contentLength).toBe(14);
  });

  it("a stored body keeps its Content-Encoding so the export can decode it", () => {
    const gzip: Phase<"copying"> = {
      ...memoryTee,
      facts: { request, response: { ...response, contentEncoding: "gzip" } },
    };
    expect(settle({ capture: gzip, stop, sink: closed(14) }, inPack).body).toEqual({
      kind: "stored",
      at: inPack,
      encoding: "gzip",
      check: "length-matched",
    });
  });
});

const PHASES = {
  opened: open(ID, T0),
  "awaiting-merge": { phase: "awaiting-merge", id: ID, facts, upload: none },
  decided: decided({ id: "no-body", kind: "empty" }),
  copying: memoryTee,
} as const satisfies { readonly [P in Capture["phase"]]: Capture };
const TOPICS: readonly ExamineTopic[] = [
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
  "service-worker-synthesized-response",
];
// EXAMINE_ACCEPTS written out by hand: which topics each live phase acts on.
const ACCEPTED: { readonly [P in Capture["phase"]]: readonly ExamineTopic[] } = {
  opened: TOPICS,
  "awaiting-merge": ["http-on-examine-merged-response"],
  decided: [],
  copying: [],
};

describe("examine", () => {
  const route: Route = { id: "small", kind: "memory-tee", cap: bytes(14) };
  it.each(
    Object.keys(PHASES).flatMap((phase) =>
      TOPICS.map((topic) => [phase as Capture["phase"], topic] as const),
    ),
  )("%s with %s", (phase, topic) => {
    const before = PHASES[phase];
    const after = examine(before, topic, facts, route, none);
    expect(after === before).toBe(!ACCEPTED[phase].includes(topic));
  });

  it.each([
    ["an empty route decides", { id: "no-body", kind: "empty" }, "decided"],
    [
      "a not-kept route decides",
      { id: "streaming", kind: "not-kept", reason: "streaming-response" },
      "decided",
    ],
    [
      "a copy route starts copying",
      { id: "large-or-unknown", kind: "file-tee", cap: bytes(MiB) },
      "copying",
    ],
    [
      "a 304 from the network waits for its merge",
      { id: "awaiting-merge", kind: "awaiting-merge" },
      "awaiting-merge",
    ],
  ] satisfies readonly (readonly [string, Route, Capture["phase"]])[])("%s", (_label, r, phase) => {
    expect(examine(open(ID, T0), "http-on-examine-response", facts, r, none).phase).toBe(phase);
  });

  it("a 304 then its merged response settles with the merged body and the 304's head", () => {
    const revalidation = {
      ...response,
      status: 304,
      statusText: "Not Modified",
      headers: [["ETag", '"v2"']] as const,
      contentLength: null,
    };
    const mergedHead = {
      ...response,
      status: 200,
      contentLength: bytes(20_000),
      contentEncoding: "br",
      source: "revalidated" as const,
    };
    const upload = { kind: "stored", at: inPack, mimeType: "application/json" } as const;
    const waiting = examine(
      open(ID, T0),
      "http-on-examine-response",
      { request, response: revalidation },
      { id: "awaiting-merge", kind: "awaiting-merge" },
      upload,
    );
    const merged = examine(
      waiting,
      "http-on-examine-merged-response",
      { request, response: mergedHead },
      { id: "small", kind: "memory-tee", cap: bytes(20_000) },
      none,
    );
    expect(merged.phase).toBe("copying");
    if (merged.phase !== "copying") return;
    const answered = settle(
      { capture: merged, stop: stopWith({ encodedBodySize: bytes(20_000) }), sink: closed(20_000) },
      inPack,
    );
    expect(answered.response).toMatchObject({
      status: 304,
      statusText: "Not Modified",
      headers: [["ETag", '"v2"']],
      contentLength: 20_000,
      contentEncoding: "br",
    });
    expect(answered.body).toEqual({
      kind: "stored",
      at: inPack,
      encoding: "br",
      check: "length-matched",
    });
    expect(answered.upload).toEqual(upload);
  });
});

describe("unanswered and abandon", () => {
  it("a refused connection settles unanswered with its stop status", () => {
    const refused = stopWith({
      status: failed("NS_ERROR_CONNECTION_REFUSED"),
      encodedBodySize: bytes(0),
    });
    expect(
      unanswered(open(ID, T0) as Extract<Capture, { phase: "opened" }>, request, refused, none),
    ).toEqual({ kind: "unanswered", request, stop: refused, upload: none });
  });

  it.each([
    ["browser-closed", "opened", null, { kind: "incomplete" }],
    ["recording-stopped", "opened", null, { kind: "incomplete" }],
    ["browser-closed", "awaiting-merge", response, { kind: "incomplete" }],
    ["recording-stopped", "copying", { ...response, contentLength: 14 }, { kind: "incomplete" }],
    ["browser-closed", "decided", response, { kind: "empty" }],
  ] as const)("abandoned as %s during %s", (reason, phase, wantResponse, body) => {
    const abandoned = abandon(PHASES[phase], request, reason);
    expect(abandoned).toEqual({
      kind: "abandoned",
      request,
      response: wantResponse,
      reason,
      body,
      upload: none,
    });
  });

  it("a decided not-kept capture keeps its route's reason when abandoned", () => {
    expect(
      abandon(
        decided({ id: "streaming", kind: "not-kept", reason: "streaming-response" }),
        request,
        "browser-closed",
      ).body,
    ).toEqual({ kind: "not-kept", reason: "streaming-response" });
  });
});

describe("bodyAvailability", () => {
  const disk = (packBytes: number | null, files: readonly string[]): DiskInventory => ({
    hasPackRange: (pack, end) =>
      pack !== PACK || packBytes === null
        ? "pack-gone"
        : end <= packBytes
          ? "present"
          : "pack-short",
    hasFile: (site: Site, id) => files.includes(`${site}/${id}`),
  });
  const answered = (
    body: Extract<SettledExchange, { readonly route: "small" }>["body"],
  ): SettledExchange => ({
    kind: "answered",
    request,
    response,
    stop,
    route: "small",
    body,
    upload: none,
  });
  const storedPack = answered({
    kind: "stored",
    at: inPack,
    encoding: null,
    check: "length-matched",
  });
  const storedFile = answered({ kind: "stored", at: inFile, encoding: null, check: "first-part" });

  it.each([
    [
      "a pack range present",
      storedPack,
      disk(4110, []),
      { kind: "available", at: inPack, encoding: null, check: "length-matched" },
    ],
    [
      "a pack one byte short of the range",
      storedPack,
      disk(4109, []),
      { kind: "missing", reason: "interrupted-by-crash" },
    ],
    [
      "a pack removed by retention",
      storedPack,
      disk(null, []),
      { kind: "missing", reason: "removed-by-retention" },
    ],
    [
      "a first part kept at the cap",
      storedFile,
      disk(null, [`${SITE}/${ID}`]),
      { kind: "available", at: inFile, encoding: null, check: "first-part" },
    ],
    [
      "a body file removed by retention",
      storedFile,
      disk(null, []),
      { kind: "missing", reason: "removed-by-retention" },
    ],
    ["an empty body", answered({ kind: "empty" }), disk(null, []), { kind: "empty" }],
    [
      "a body not kept by rule",
      {
        kind: "answered",
        request,
        response,
        stop,
        route: "media-details",
        body: { kind: "not-kept", reason: "media-setting" },
        upload: none,
      },
      disk(null, []),
      { kind: "missing", reason: "media-setting" },
    ],
    [
      "a failed write",
      answered({ kind: "incomplete", reason: "write-failed" }),
      disk(null, []),
      { kind: "missing", reason: "write-failed" },
    ],
    [
      "an unanswered request",
      { kind: "unanswered", request, stop, upload: none },
      disk(null, []),
      { kind: "missing", reason: "no-response" },
    ],
    [
      "an abandoned download",
      abandon(fileTee, request, "browser-closed"),
      disk(null, []),
      { kind: "missing", reason: "browser-closed" },
    ],
    [
      "a download abandoned when the add-on stopped",
      abandon(fileTee, request, "recording-stopped"),
      disk(null, []),
      { kind: "missing", reason: "recording-stopped" },
    ],
    [
      "an abandoned decided body keeps its rule's reason",
      abandon(
        decided({ id: "media-details", kind: "not-kept", reason: "media-setting" }),
        request,
        "browser-closed",
      ),
      disk(null, []),
      { kind: "missing", reason: "media-setting" },
    ],
  ] satisfies readonly (readonly [string, SettledExchange, DiskInventory, BodyAvailability])[])(
    "%s",
    (_label, settled, inventory, want) => {
      expect(bodyAvailability(settled, inventory)).toEqual(want);
    },
  );
});
