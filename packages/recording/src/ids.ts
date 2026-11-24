// Branded primitives. Each parser here is the one place a raw value becomes the brand.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EpochMs = Brand<number, "EpochMs">;
/** Epoch milliseconds at the start of a UTC minute. Previews, ranges, the activity index and sessions all use it. */
export type Minute = Brand<number, "Minute">;
/** A non-negative integer count of bytes. */
export type ByteCount = Brand<number, "ByteCount">;
/** A whole number of minutes, at least 1. A "last N minutes" range that selects nothing cannot be built. */
export type PositiveMinutes = Brand<number, "PositiveMinutes">;

/** One browser run, start to quit: startup time in base36. Every file a run creates carries it. */
export type RunId = Brand<string, "RunId">;
/** nsIHttpChannel.channelId in decimal. Unique only within one run: ids repeat after a restart. */
export type ChannelKey = Brand<string, "ChannelKey">;
/**
 * `${RunId}.${ChannelKey}`: the identity of a request across the product. A DevTools item is always of the current
 * run, so its key is exchangeId(currentRun, resourceId) and cannot pair with an older run's line.
 */
export type ExchangeId = Brand<string, "ExchangeId">;

/** Registrable domain of the top-level document (`example.com`), or the host for IP and single-label hosts. */
export type Site = Brand<string, "Site">;
/** A site as a directory name that is safe on every platform's file system. See layout.siteDirName. */
export type SiteDir = Brand<string, "SiteDir">;

/**
 * A WebExtension tab id as an extension page passes it: an integer, 0 or more. 0 parses and then resolves to
 * "no-such-tab" without a throw. -1 (Zen's empty tab) does not parse; the popup sends null for no tab.
 */
export type TabId = Brand<number, "TabId">;

/** A tab for one run. browserId survives navigation but not a restart, so the run is part of the key. */
export interface TabKey {
  readonly run: RunId;
  readonly browserId: number;
}

/** `${SiteDir}/${RunId}-<seq>`. The current run's open pack per site; old runs' packs are sealed by being old. */
export type PackId = Brand<string, "PackId">;
/** `${SiteDir}/${RunId}-<seq>`. One open segment per site per run. */
export type LogSegmentId = Brand<string, "LogSegmentId">;

/** A non-empty list, where an empty list would be an illegal state, such as a selection of zero sessions. */
export type NonEmpty<T> = readonly [T, ...T[]];

const MINUTE_MS = 60_000;
const MAX_TAB_ID = 2 ** 31 - 1;
const MAX_MINUTES = 525_600;
const RUN_PATTERN = /^[0-9a-z]{1,13}$/;
// A uint64 in decimal, without leading zeros.
const CHANNEL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const DNS_NAME =
  /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4 =
  /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const MAX_HOST_LENGTH = 253;

export function toMinute(at: EpochMs): Minute {
  return (Math.floor(at / MINUTE_MS) * MINUTE_MS) as Minute;
}

/** The minute that starts `minutes` after `from`. */
export function addMinutes(from: Minute, minutes: number): Minute {
  return (from + minutes * MINUTE_MS) as Minute;
}

/**
 * RFC 4291 text form: eight hex groups, or fewer around one `::`, where a dotted IPv4 address may stand for the last
 * two. So `host:port`, `:::` and a second `::` are refused.
 */
function isIpv6(host: string): boolean {
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  const tail = groups.at(-1)?.at(-1);
  const ipv4 = tail !== undefined && tail.includes(".");
  if (ipv4 && !IPV4.test(tail)) return false;
  const hex = groups.flat().slice(0, ipv4 ? -1 : undefined);
  if (!hex.every((g) => HEX_GROUP.test(g))) return false;
  const width = hex.length + (ipv4 ? 2 : 0);
  return halves.length === 2 ? width <= 7 : width === 8;
}

/**
 * An ASCII host as Gecko reports it (IDNs arrive as punycode), lowercased. IPv6 hosts come without brackets. Anything
 * else, such as a URL, a path, a port or an empty string, is rejected.
 */
export function parseSite(raw: unknown): Site | null {
  if (typeof raw !== "string") return null;
  const host = raw.toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;
  return DNS_NAME.test(host) || isIpv6(host) ? (host as Site) : null;
}

/** Integers 0 to 2^31-1. Rejects negatives, fractions, NaN, strings and numbers above the tab id range. */
export function parseTabId(raw: unknown): TabId | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_TAB_ID
    ? (raw as TabId)
    : null;
}

/** Integers 1 to 525600 (one year). */
export function parsePositiveMinutes(raw: unknown): PositiveMinutes | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_MINUTES
    ? (raw as PositiveMinutes)
    : null;
}

/** The run that started at `startedAt`. */
export function runIdAt(startedAt: EpochMs): RunId {
  return Math.floor(startedAt).toString(36) as RunId;
}

export function parseRunId(raw: string): RunId | null {
  return RUN_PATTERN.test(raw) ? (raw as RunId) : null;
}

export function parseChannelKey(raw: string): ChannelKey | null {
  return CHANNEL_PATTERN.test(raw) ? (raw as ChannelKey) : null;
}

export function exchangeId(run: RunId, channel: ChannelKey): ExchangeId {
  return `${run}.${channel}` as ExchangeId;
}

export function parseExchangeId(
  raw: string,
): { readonly run: RunId; readonly channel: ChannelKey } | null {
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const run = parseRunId(raw.slice(0, dot));
  const channel = parseChannelKey(raw.slice(dot + 1));
  return run === null || channel === null ? null : { run, channel };
}
