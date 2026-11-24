// Contradictory export states, each a value the types must reject.

import type { BodyLocation } from "@hark/recording/exchange";
import type {
  ByteCount,
  ExchangeId,
  Minute,
  PositiveMinutes,
  Site,
  TabId,
} from "@hark/recording/ids";
import type { ExportRequest } from "../src/jobs.ts";
import { FIELD_RULES } from "../src/merge.ts";
import { MISSING_REASONS } from "../src/missing.ts";
import type { MinuteSpan, Selection, SessionRef } from "../src/selection.ts";
import type { BodyCandidates, BodySource } from "../src/source.ts";

const site = "app.example" as Site;
const at: BodyLocation = {
  kind: "file",
  site,
  id: "mhz02.1" as ExchangeId,
  length: 14 as ByteCount,
};
const stored: BodySource = {
  kind: "stored",
  at,
  wireEncoding: null,
  check: "length-matched",
};
const tab = 7 as TabId;
const span = { from: 0 as Minute, to: 60_000 as Minute } as MinuteSpan;

// A body with a candidate and a "no body" reason at once.
export const completeAndMissing: BodyCandidates = {
  kind: "candidates",
  list: [stored],
  // @ts-expect-error candidates and a reason cannot coexist
  reason: "removed-by-retention",
};
// @ts-expect-error a candidate list cannot be empty
export const noCandidates: BodyCandidates = { kind: "candidates", list: [] };
export const legalCandidates: BodyCandidates = { kind: "candidates", list: [stored] };
export const legalNone: BodyCandidates = { kind: "none", reason: "removed-by-retention" };

// A cache reference as a body source. There is no cache kind.
export const cacheSource: BodySource = {
  // @ts-expect-error there is no cache body source
  kind: "cache",
  ref: undefined as never,
};

// A "last" range of zero minutes, which selects nothing.
export const lastZero: Selection = {
  scope: "everything",
  // @ts-expect-error minutes must be a parsed PositiveMinutes
  range: { kind: "last", minutes: 0 },
  include: "all",
};
export const lastFifteen: Selection = {
  scope: "everything",
  range: { kind: "last", minutes: 15 as PositiveMinutes },
  include: "all",
};

export const inverted: Selection = {
  scope: "everything",
  // @ts-expect-error a between range is a parsed MinuteSpan, never two loose minutes
  range: { kind: "between", from: 10 as Minute, to: 5 as Minute },
  include: "all",
};
export const legalBetween: Selection = {
  scope: "everything",
  range: { kind: "between", span },
  include: "all",
};

// A sessions selection with no sessions.
export const noSessions: Selection = {
  scope: "sessions",
  // @ts-expect-error at least one session
  sessions: [],
  include: "all",
};
const oneSession: SessionRef = { site, span };
export const legalSessions: Selection = {
  scope: "sessions",
  sessions: [oneSession],
  include: "all",
};

// A raw negative or unparsed tab id.
export const negativeTab: Selection = {
  scope: "tab",
  // @ts-expect-error a tab is a parsed TabId
  tabId: -1,
  range: { kind: "everything" },
  include: "all",
};
export const legalTab: Selection = {
  scope: "tab",
  tabId: tab,
  range: { kind: "everything" },
  include: "all",
};

// An export request cannot carry bad packaging.
export const badPackaging: ExportRequest = {
  selection: legalTab,
  bodies: "include",
  redaction: "standard",
  // @ts-expect-error packaging must be one of Packaging
  packaging: "tar",
  fileName: null,
};

// The redaction level is @hark/har's by name, or none. The export has no level of its own.
export const ownLevel: ExportRequest = {
  selection: legalTab,
  bodies: "include",
  // @ts-expect-error redaction must be a RedactionChoice
  redaction: "remove",
  packaging: "har",
  fileName: null,
};

export const keep: readonly unknown[] = [at, FIELD_RULES, MISSING_REASONS];
