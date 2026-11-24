// Contradictory states as values the types must reject. If a type change accepts one, its @ts-expect-error is
// unused and typecheck fails with TS2578. Each legal twin follows its case, so a type that rejects everything cannot
// pass either. test/weakened-types.test.ts weakens the types one at a time and expects the checker to fail.

import { windowOf, type Window } from "../src/activity.ts";
import type {
  AbandonedExchange,
  AnsweredExchange,
  BodyLocation,
  Capture,
  SettledBody,
  SettleInput,
} from "../src/exchange.ts";
import type { ByteCount, Minute, PositiveMinutes, TabId } from "../src/ids.ts";
import type { ArchiveRootRow } from "../src/layout.ts";
import type { BodyRoute, Route, RouteOutcome } from "../src/routes.ts";
import { facts, ID, request, response, SITE, stop } from "./fixtures.ts";

const at: BodyLocation = { kind: "file", site: SITE, id: ID, length: 14 as ByteCount };

// An exchange abandoned before stop that claims a stored body.
export const abandonedButStored: AbandonedExchange = {
  kind: "abandoned",
  request,
  response,
  reason: "browser-closed",
  // @ts-expect-error an abandoned exchange has no stored body
  body: { kind: "stored", at, encoding: null, check: "length-matched" },
  upload: { kind: "none" },
};
export const legalAbandoned: AbandonedExchange = {
  kind: "abandoned",
  request,
  response,
  reason: "recording-stopped",
  body: { kind: "incomplete" },
  upload: { kind: "none" },
};

// An answered exchange with no stop.
export const answeredWithoutStop: AnsweredExchange = {
  kind: "answered",
  request,
  response,
  // @ts-expect-error an answered exchange always has its stop facts
  stop: null,
  route: "small",
  body: { kind: "empty" },
  upload: { kind: "none" },
};
export const legalAnswered: AnsweredExchange = {
  kind: "answered",
  request,
  response,
  stop,
  route: "small",
  body: { kind: "stored", at, encoding: null, check: "length-matched" },
  upload: { kind: "none" },
};

// A vague shutdown reason. The abandon reason says whether the browser closed or the add-on stopped.
// @ts-expect-error "shutdown" does not exist
export const vagueShutdown: SettledBody = { kind: "incomplete", reason: "shutdown" };
// A body cut at the body cap keeps its first part, so it is never stored as missing.
// @ts-expect-error over-body-cap is a stored first part, not an incomplete body
export const cappedAsMissing: SettledBody = { kind: "incomplete", reason: "over-body-cap" };
export const legalCapped: SettledBody = { kind: "stored", at, encoding: null, check: "first-part" };

// A raw negative tab id and a range of zero minutes.
// @ts-expect-error a tab is a parsed TabId
export const negativeTab: TabId = -1;
// @ts-expect-error minutes are a parsed PositiveMinutes
export const lastZero: PositiveMinutes = 0;

// The XDG rule extended with .local/share on the variable's own value.
export const doubledXdg: ArchiveRootRow = {
  platform: "linux",
  base: {
    kind: "xdg-data-home",
    env: "XDG_DATA_HOME",
    // @ts-expect-error the XDG base has no `under`; only the fallback has fallbackUnder
    under: [".local", "share"],
    fallbackKey: "Home",
    fallbackUnder: [".local", "share"],
  },
  appFolder: "hark",
  dirMode: 0o700,
  fileMode: 0o600,
};
export const legalXdg: ArchiveRootRow = {
  platform: "linux",
  base: {
    kind: "xdg-data-home",
    env: "XDG_DATA_HOME",
    fallbackKey: "Home",
    fallbackUnder: [".local", "share"],
  },
  appFolder: "hark",
  dirMode: 0o700,
  fileMode: 0o600,
};

// A copy row with no action, or an empty row with a reason.
// @ts-expect-error a copy route names at least one action
export const copyNothing: RouteOutcome = { kind: "copy", actions: [] };
// @ts-expect-error an empty body has no reason
export const emptyWithReason: RouteOutcome = { kind: "empty", reason: "media-setting" };
export const legalCopy: RouteOutcome = { kind: "copy", actions: ["file-tee"] };

// A 304 decided as no body while it still awaits its merge. awaiting-merge carries no route.
export const decidedAwaiting: Capture = {
  phase: "awaiting-merge",
  id: ID,
  facts,
  upload: { kind: "none" },
  // @ts-expect-error awaiting-merge has no route yet; the merged head decides it
  route: { id: "no-body", kind: "empty" },
};
export const legalAwaiting: Capture = {
  phase: "awaiting-merge",
  id: ID,
  facts,
  upload: { kind: "none" },
};

// An abandoned exchange whose body names the other abandon reason.
export const abandonReasonsDisagree: AbandonedExchange = {
  kind: "abandoned",
  request,
  response,
  reason: "browser-closed",
  // @ts-expect-error an interrupted body names no reason; the exchange's own reason is the only one
  body: { kind: "incomplete", reason: "recording-stopped" },
  upload: { kind: "none" },
};

// Abandoned before any head, yet with a decided route's body and a stored upload.
export const headlessButDecided: AbandonedExchange = {
  kind: "abandoned",
  request,
  response: null,
  reason: "browser-closed",
  // @ts-expect-error with no response no route was decided and no upload was read
  body: { kind: "not-kept", reason: "media-setting" },
  upload: { kind: "stored", at, mimeType: null },
};
export const legalHeadless: AbandonedExchange = {
  kind: "abandoned",
  request,
  response: null,
  reason: "browser-closed",
  body: { kind: "incomplete" },
  upload: { kind: "none" },
};

// A 204 on the no-body route, stopped as failed, yet with a stored body.
export const noBodyButStored: AnsweredExchange = {
  kind: "answered",
  request,
  response: { ...response, status: 204 },
  stop: { ...stop, status: { kind: "failed", error: "NS_BINDING_ABORTED" as never } },
  route: "no-body",
  // @ts-expect-error the no-body route settles to an empty body only
  body: { kind: "stored", at, encoding: null, check: "length-matched" },
  upload: { kind: "none" },
};
export const legalNoBody: AnsweredExchange = {
  kind: "answered",
  request,
  response: { ...response, status: 204 },
  stop,
  route: "no-body",
  body: { kind: "empty" },
  upload: { kind: "none" },
};
// The same rule for the reason: the streaming route never settles as the media setting.
// @ts-expect-error a not-kept route settles to its own reason
export const streamingAsMedia: AnsweredExchange = {
  kind: "answered",
  request,
  response,
  stop,
  route: "streaming",
  body: { kind: "not-kept", reason: "media-setting" },
  upload: { kind: "none" },
};

// A route whose id cannot produce its kind, and a row given another row's outcome.
// @ts-expect-error the no-body row never copies
export const noBodyTee: Route = { id: "no-body", kind: "file-tee", cap: 1024 as ByteCount };
// @ts-expect-error the large-or-unknown row copies or is not recordable here; it is never empty
export const largeEmpty: Route = { id: "large-or-unknown", kind: "empty" };
export const legalLarge: Route = {
  id: "large-or-unknown",
  kind: "file-tee",
  cap: 1024 as ByteCount,
};
// @ts-expect-error the small row copies
export const smallRowEmpty: BodyRoute = {
  id: "small",
  when: () => true,
  outcome: { kind: "empty" },
};

// A copying capture settled without its sink's report.
const copyingCapture = {
  phase: "copying",
  id: ID,
  facts,
  route: { id: "small", kind: "memory-tee", cap: 14 as ByteCount },
  upload: { kind: "none" },
} as const satisfies Capture;
// @ts-expect-error a copying capture always has its sink's report
export const copyingWithoutSink: SettleInput = { capture: copyingCapture, stop, sink: null };
export const legalCopying: SettleInput = {
  capture: copyingCapture,
  stop,
  sink: { kind: "closed", bytes: 14 as ByteCount, cappedAt: null },
};

// An inverted window, which would select nothing.
// @ts-expect-error a window is built by windowOf, which refuses from >= to
export const invertedWindow: Window = { key: "all", from: 120_000 as Minute, to: 60_000 as Minute };
export const legalWindow: Window | null = windowOf("all", 60_000 as Minute, 120_000 as Minute);
