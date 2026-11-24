// The one shape both sources produce. The background recording and DevTools are two adapters behind ExchangeSource.

import { toHarUrl, type HarEntry } from "@hark/har/model";
import type { BodyCheck, BodyLocation } from "@hark/recording/exchange";
import type { EpochMs, ExchangeId, Minute, NonEmpty, Site, TabKey } from "@hark/recording/ids";
import type { MissingReason } from "./missing.ts";
import type { ResolvedSelection } from "./selection.ts";

export type SourceName = "recording" | "devtools";

/**
 * Only these schemes become entries. DevTools lists data:, blob: and about: rows, which are not network requests and
 * which har-to-k6 rejects with the whole file. They are counted in the report as left out.
 */
export const NETWORK_SCHEMES: readonly string[] = ["http:", "https:"];

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/u;
const CONTROL_OR_SPACE_PATTERN = /[\u0000-\u0020\u007f]/u;
const PORT_DIGITS_PATTERN = /^[0-9]+$/u;

function hasValidAuthority(rest: string): boolean {
  if (!rest.startsWith("//")) return false;
  const afterSlashes = rest.slice(2);
  const authorityEnd = afterSlashes.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
  if (authority.length === 0) return false;
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    if (closeBracket <= 1) return false;
    const afterBracket = hostPort.slice(closeBracket + 1);
    if (afterBracket === "") return true;
    return isValidPortSuffix(afterBracket);
  }
  const colon = hostPort.indexOf(":");
  if (colon === -1) return hostPort.length > 0;
  const host = hostPort.slice(0, colon);
  return host.length > 0 && isValidPortSuffix(hostPort.slice(colon));
}

function isValidPortSuffix(suffix: string): boolean {
  if (!suffix.startsWith(":")) return false;
  const portText = suffix.slice(1);
  if (portText === "") return true;
  if (!PORT_DIGITS_PATTERN.test(portText)) return false;
  const port = Number(portText);
  return Number.isInteger(port) && port >= 0 && port <= 65_535;
}

/** The one place a source's URL is classified. A row with another scheme never becomes a SourceItem. */
export function classifyUrl(
  raw: string,
):
  | { readonly kind: "network"; readonly url: string }
  | { readonly kind: "not-network"; readonly scheme: string }
  | { readonly kind: "malformed" } {
  if (raw.length === 0 || CONTROL_OR_SPACE_PATTERN.test(raw)) {
    return { kind: "malformed" };
  }
  const match = SCHEME_PATTERN.exec(raw);
  if (!match) return { kind: "malformed" };
  const scheme = `${(match[1] ?? "").toLowerCase()}:`;
  const rest = match[2] ?? "";
  if (rest.length === 0) return { kind: "malformed" };
  if (NETWORK_SCHEMES.includes(scheme)) {
    if (!hasValidAuthority(rest) || toHarUrl(raw) === null) {
      return { kind: "malformed" };
    }
    return { kind: "network", url: raw };
  }
  return { kind: "not-network", scheme };
}

/** Structural abort signal so this package needs neither DOM nor Node types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

/** A few dozen bytes, so a whole selection's items fit in memory. No headers, no body. */
export interface SourceItem {
  readonly source: SourceName;
  readonly key: ExchangeId | null;
  readonly startedAt: EpochMs;
  readonly startedMinute: Minute;
  readonly url: string;
  readonly method: string;
  readonly tab: TabKey | null;
  readonly site: Site | null;
  /** Top-level document load (policy type 6, or DevTools isNavigationRequest). Starts a HAR page. */
  readonly navigation: boolean;
  readonly fetchOrXhr: boolean;
  /** The recorder still holds this request (LiveExchange). Exported, marked in progress. */
  readonly inProgress: boolean;
  /** Opaque to everything but the source that made it. */
  readonly ref: SourceRef;
}
export type SourceRef = { readonly __sourceRef: unique symbol };

/** Opaque handle to a DevTools long string. Its adapter reads it in slices, so no body becomes one JS string. */
export type DevtoolsBodyRef = { readonly __devtoolsBody: unique symbol };

/** One place a body might come from. The merge orders these; the run tries them in order. There is no cache kind. */
export type BodySource =
  | {
      readonly kind: "stored";
      readonly at: BodyLocation;
      readonly wireEncoding: string | null;
      readonly check: BodyCheck;
    }
  | {
      readonly kind: "devtools";
      readonly ref: DevtoolsBodyRef;
      readonly encoding: "base64" | null;
      readonly length: number;
    };

/** A body either has candidates or a reason, never both and never neither. */
export type BodyCandidates =
  | { readonly kind: "candidates"; readonly list: NonEmpty<BodySource> }
  | { readonly kind: "none"; readonly reason: MissingReason }
  | { readonly kind: "empty" };

export type HeadGroup = "request-head" | "response-head" | "timings";

/** Everything one source knows about one request. `entry.response.content.text` and `postData.text` are absent. */
export interface Material {
  readonly entry: HarEntry;
  readonly body: BodyCandidates;
  readonly upload: BodyCandidates;
  readonly lostGroups?: { readonly [G in HeadGroup]?: MissingReason } | undefined;
}

export interface SourceListing {
  readonly items: readonly SourceItem[];
  /** Rows whose URL scheme is not in NETWORK_SCHEMES, by scheme. Reported, never written as entries. */
  readonly notNetwork: { readonly [scheme: string]: number };
}

export interface ExchangeSource {
  readonly name: SourceName;
  list(sel: ResolvedSelection): Promise<SourceListing>;
  load(item: SourceItem, opts: { readonly body: boolean }): Promise<Material>;
}

/** What a reader yields: raw wire bytes to decode and encode, or text DevTools already decoded. */
export type BodyChunks =
  | {
      readonly kind: "bytes";
      readonly chunks: AsyncIterable<Uint8Array>;
      readonly wireEncoding: string | null;
    }
  | {
      readonly kind: "text";
      readonly chunks: AsyncIterable<string>;
      readonly encoding: "base64" | null;
    };

/**
 * The host's way to read one candidate. `open` is the probe: it fails cheaply before anything is written.
 */
export interface BodyReader {
  open(
    source: BodySource,
    chunkBytes: number,
    signal: AbortSignalLike,
  ): Promise<
    | { readonly ok: true; readonly body: BodyChunks }
    | { readonly ok: false; readonly reason: MissingReason }
  >;
}
