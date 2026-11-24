import { describe, expect, it } from "vite-plus/test";

import { examine, open, settle, type SettledExchange, type SettleInput } from "../src/exchange.ts";
import { parsePositiveMinutes, parseTabId, type ByteCount, type PackId } from "../src/ids.ts";
import { rootSegments } from "../src/layout.ts";
import { decodeLine, encodeLine } from "../src/log.ts";
import { windowOf } from "../src/activity.ts";
import {
  compileRoutes,
  resolveRow,
  type BodyRoute,
  type BodyRouteId,
  type Route,
  type RouteOutcome,
} from "../src/routes.ts";
import { facts, ID, request, response, stop, T0 } from "./fixtures.ts";

const MiB = 1_048_576;
import * as states from "./illegal-states.ts";

// A value only the type checker rejects could still arrive from disk. The log decoder is that boundary, so it must
// reject the same states at run time and accept each legal twin.
const roundTrip = (exchange: SettledExchange) =>
  decodeLine(encodeLine({ v: 2, exchange }).slice(0, -1));
const answeredWith = (body: unknown): SettledExchange =>
  ({ ...states.legalAnswered, body }) as SettledExchange;
const answeredOn = (route: BodyRouteId, body: unknown): SettledExchange =>
  ({ ...states.legalAnswered, route, body }) as SettledExchange;
const notRecordable = { kind: "not-kept", reason: "not-recordable-here" };
const mediaNotKept = { kind: "not-kept", reason: "media-setting" };
const inPack = {
  kind: "pack",
  pack: "example.com/mhz02-0" as PackId,
  offset: 0,
  length: 14 as ByteCount,
} as const;

describe("the log decoder rejects what the types reject", () => {
  it.each([
    ["an abandoned exchange with a stored body", states.abandonedButStored],
    ["an answered exchange without stop", states.answeredWithoutStop],
    ["an incomplete body for a reason that does not exist", answeredWith(states.vagueShutdown)],
    ["a capped body stored as missing", answeredWith(states.cappedAsMissing)],
    ["an abandoned body naming the other abandon reason", states.abandonReasonsDisagree],
    ["an exchange abandoned before its head with a decided body", states.headlessButDecided],
    [
      "an exchange abandoned before its head with a stored upload",
      { ...states.legalHeadless, upload: { kind: "stored", at: inPack, mimeType: null } } as never,
    ],
    ["a stored body on the no-body route", states.noBodyButStored],
    ["the media reason on the streaming route", states.streamingAsMedia],
    ["a not-recordable body on the streaming route", answeredOn("streaming", notRecordable)],
    ["the media reason on a copy route", answeredOn("small", mediaNotKept)],
  ])("%s decodes to null", (_label, exchange) => {
    expect(roundTrip(exchange)).toBeNull();
  });

  it.each([
    ["abandoned, recording stopped", states.legalAbandoned],
    ["abandoned before its head", states.legalHeadless],
    ["answered with a stored body", states.legalAnswered],
    ["a 204 on the no-body route", states.legalNoBody],
    ["a copy route the backend cannot record", answeredOn("large-or-unknown", notRecordable)],
    ["the media reason on the media route", answeredOn("media-details", mediaNotKept)],
    ["answered with a first part kept at the cap", answeredWith(states.legalCapped)],
    [
      "unanswered",
      {
        kind: "unanswered",
        request,
        stop: { ...stop, status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" } },
        upload: { kind: "none" },
      } as SettledExchange,
    ],
    [
      "abandoned before any head",
      {
        kind: "abandoned",
        request,
        response: null,
        reason: "browser-closed",
        body: { kind: "incomplete" },
        upload: { kind: "none" },
      } as SettledExchange,
    ],
    [
      "answered with a 304 head",
      {
        ...states.legalAnswered,
        response: { ...response, status: 304 },
        route: "awaiting-merge",
        body: { kind: "empty" },
      } as SettledExchange,
    ],
  ])("the legal twin %s round-trips", (_label, exchange) => {
    expect(roundTrip(exchange)).toEqual({ v: 2, exchange });
  });
});

const compiledFor = () =>
  compileRoutes({
    platform: "linux",
    excluded: [],
    keepMedia: false,
    maxBodyBytes: (64 * MiB) as ByteCount,
    supported: ["memory-tee", "file-tee"],
  });
const headFacts = {
  method: "GET",
  status: 200,
  source: "network",
  mimeType: null,
  contentLength: 14 as ByteCount,
  hasLocation: false,
} as const;
const closed14 = { kind: "closed", bytes: 14 as ByteCount, cappedAt: null } as const;
const none = { kind: "none" } as const;

// The rest have no decoder in front of them, so the code that reads each one must not be fooled by it either.
describe("the code behind the other types holds without them", () => {
  it("a stray `under` on the XDG base never extends the variable's own value", () => {
    const env = (name: string) => (name === "XDG_DATA_HOME" ? "/home/u/.local/share" : null);
    const home = () => "/home/u";
    expect(rootSegments(states.doubledXdg, env, home)).toEqual(["/home/u/.local/share", "hark"]);
    expect(rootSegments(states.legalXdg, env, home)).toEqual(
      rootSegments(states.doubledXdg, env, home),
    );
  });

  it("a copy row with no action is never recordable, and an empty row's stray reason is dropped", () => {
    const compiled = compiledFor();
    const facts = headFacts;
    const withOutcome = (outcome: RouteOutcome) =>
      resolveRow({ id: "small", when: () => true, outcome } as BodyRoute, compiled, facts);
    expect(withOutcome(states.copyNothing)).toEqual({
      id: "small",
      kind: "not-kept",
      reason: "not-recordable-here",
    });
    expect(withOutcome(states.legalCopy)).toEqual({ id: "small", kind: "file-tee", cap: 16 * MiB });
    const noBodyRow = { id: "no-body", when: () => true, outcome: states.emptyWithReason };
    expect(resolveRow(noBodyRow as BodyRoute, compiled, facts)).toEqual({
      id: "no-body",
      kind: "empty",
      reason: "media-setting",
    });
  });

  it("a 304 still awaiting its merge settles with no body, whatever route it carries", () => {
    for (const capture of [states.decidedAwaiting, states.legalAwaiting] as const) {
      if (capture.phase !== "awaiting-merge") throw new Error("the capture must await its merge");
      expect(settle({ capture, stop, sink: null }, null)).toMatchObject({
        route: "awaiting-merge",
        body: { kind: "empty" },
      });
    }
  });

  it("a route whose id cannot produce its kind settles to a line the decoder refuses", () => {
    const lineFor = (route: Route) => {
      const capture = examine(open(ID, T0), "http-on-examine-response", facts, route, none);
      if (capture.phase === "opened") throw new Error("the route must be acted on");
      return settle({ capture, stop, sink: closed14 } as SettleInput, inPack);
    };
    expect(roundTrip(lineFor(states.noBodyTee))).toBeNull();
    expect(roundTrip(lineFor(states.largeEmpty))).toBeNull();
    expect(roundTrip(lineFor(states.legalLarge))).toEqual({
      v: 2,
      exchange: lineFor(states.legalLarge),
    });
    expect(() => resolveRow(states.smallRowEmpty, compiledFor(), headFacts)).toThrow(TypeError);
  });

  it("a copying capture settled without its sink's report throws instead of storing a body", () => {
    expect(() => settle(states.copyingWithoutSink, null)).toThrow(TypeError);
    expect(settle(states.legalCopying, null).body).toEqual({
      kind: "incomplete",
      reason: "write-failed",
    });
  });

  it("windowOf refuses the inverted window and builds its legal twin", () => {
    const { from, to } = states.invertedWindow;
    expect(windowOf("all", from, to)).toBeNull();
    expect(states.legalWindow).toEqual({ key: "all", from: to, to: from });
  });

  it("the tab and minute parsers refuse the values the brands keep out", () => {
    expect([parseTabId(states.negativeTab), parsePositiveMinutes(states.lastZero)]).toEqual([
      null,
      null,
    ]);
  });
});
