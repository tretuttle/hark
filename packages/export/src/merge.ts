// One entry per request, whichever sources saw it.
//   pairItems:   join the two listings on ExchangeId, run included; never guess by time
//   mergeEntry:  every field of the entry from FIELD_RULES, a table total over the HAR model's fields
//   bodyPlan:    stored candidates first, DevTools after, else the most specific reason

import { buildHarEntry } from "@hark/har/build";
import {
  isoDateTimeFromEpochMs,
  toHarUrl,
  type HarEntry,
  type HarRequest,
  type HarResponse,
  type HarTimings,
} from "@hark/har/model";
import type { NonEmpty } from "@hark/recording/ids";
import type { HarEntryField } from "./har-fields.ts";
import type { MissingReason } from "./missing.ts";
import type { BodyCandidates, BodySource, Material, SourceItem, SourceName } from "./source.ts";

/** At least one side is present. Sorted by startedAt, oldest first. */
export type Pair =
  | { readonly kind: "both"; readonly recording: SourceItem; readonly devtools: SourceItem }
  | { readonly kind: "recording-only"; readonly recording: SourceItem }
  | { readonly kind: "devtools-only"; readonly devtools: SourceItem };

function pairStartedAt(pair: Pair): number {
  return pair.kind === "devtools-only" ? pair.devtools.startedAt : pair.recording.startedAt;
}

/**
 * The rule for rows that share a key. A source may list one request twice: the recording's listing includes its live
 * snapshot, so a request that settles between reading the lines and taking the snapshot appears as a line and as a
 * live row. Within one source the row of the better standing is kept, ties go to the first listed, and each row left
 * out is counted in the report's `duplicates`. Across sources the kept rows pair one to one.
 */
const DUPLICATE_RULE = {
  standing: ["settled", "live"],
  tie: "first listed",
  counted: "report.duplicates, per source",
} as const;

function standing(item: SourceItem): number {
  return DUPLICATE_RULE.standing.indexOf(item.inProgress ? "live" : "settled");
}

/** One row per key, chosen by DUPLICATE_RULE, in the order the keys were first listed. Keyless rows all stay. */
function oneRowPerKey(items: readonly SourceItem[]): {
  readonly kept: readonly SourceItem[];
  readonly dropped: number;
} {
  const slotByKey = new Map<string, number>();
  const kept: SourceItem[] = [];
  let dropped = 0;
  for (const item of items) {
    const slot = item.key === null ? undefined : slotByKey.get(item.key);
    if (slot === undefined) {
      if (item.key !== null) slotByKey.set(item.key, kept.length);
      kept.push(item);
      continue;
    }
    dropped += 1;
    if (standing(item) < standing(kept[slot]!)) kept[slot] = item;
  }
  return { kept, dropped };
}

/**
 * Items join on `key` only. A key is an ExchangeId, so a DevTools item (current run) can never pair with a recording
 * line of another run that reused the channel id. Items without a key stay unpaired and are counted.
 */
export function pairItems(
  recordingItems: readonly SourceItem[],
  devtoolsItems: readonly SourceItem[],
): {
  readonly pairs: readonly Pair[];
  readonly unpaired: number;
  readonly duplicates: { readonly [S in SourceName]: number };
} {
  const recording = oneRowPerKey(recordingItems);
  const devtools = oneRowPerKey(devtoolsItems);
  let unpaired = 0;
  const dtByKey = new Map<string, SourceItem>();
  for (const item of devtools.kept) {
    if (item.key === null) unpaired += 1;
    else dtByKey.set(item.key, item);
  }

  const pairs: Pair[] = [];
  for (const item of recording.kept) {
    if (item.key === null) unpaired += 1;
    const dt = item.key === null ? undefined : dtByKey.get(item.key);
    if (dt === undefined) {
      pairs.push({ kind: "recording-only", recording: item });
    } else {
      dtByKey.delete(item.key!);
      pairs.push({ kind: "both", recording: item, devtools: dt });
    }
  }
  for (const item of devtools.kept) {
    if (item.key === null || dtByKey.has(item.key))
      pairs.push({ kind: "devtools-only", devtools: item });
  }

  pairs.sort((a, b) => pairStartedAt(a) - pairStartedAt(b));
  return {
    pairs,
    unpaired,
    duplicates: { recording: recording.dropped, devtools: devtools.dropped },
  };
}

/** Fields that only make sense together come from one source as a unit, so an entry never mixes two sources' timings. */
export type FieldGroup = "request-head" | "response-head" | "timings";

export const FIELD_GROUPS: {
  readonly [G in FieldGroup]: { readonly order: NonEmpty<SourceName>; readonly why: string };
} = {
  "request-head": {
    order: ["devtools", "recording"],
    why: "Both saw the request as sent. DevTools keeps header values when the recording was set to never store secrets.",
  },
  "response-head": {
    order: ["devtools", "recording"],
    why: "Both saw the same head. For a revalidated response both report the 304 and its headers.",
  },
  timings: {
    order: ["devtools", "recording"],
    why: "DevTools fills dns, connect and ssl from its own actor; the phases must come from one clock.",
  },
};

export type FieldRule =
  | { readonly kind: "first-of"; readonly order: NonEmpty<SourceName>; readonly why: string }
  | { readonly kind: "group"; readonly group: FieldGroup }
  /** The export computes it while writing; neither source's value is used. */
  | { readonly kind: "export-writes"; readonly why: string };

/**
 * One rule per field of the HAR model, checked by the mapped type: a missing or extra row fails typecheck. A field
 * a source sends that the model does not name is not written, so nothing reaches the file without a rule.
 */
export const FIELD_RULES: { readonly [F in HarEntryField]: FieldRule } = {
  pageref: { kind: "export-writes", why: "Assigned by pages.ts while entries stream." },
  startedDateTime: {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "One clock for ordering and page assignment. The sources differ by up to 22 ms; the recording covers more requests.",
  },
  time: {
    kind: "export-writes",
    why: "The sum of the chosen timings, so it always agrees with them.",
  },
  serverIPAddress: {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "Read from the channel at examine time.",
  },
  connection: {
    kind: "first-of",
    order: ["devtools", "recording"],
    why: "DevTools writes its connection id; the recording has the remote port.",
  },
  comment: {
    kind: "export-writes",
    why: "The export's note when a source's details for this request could not be read (SOURCE_FAILURES).",
  },
  _securityState: {
    kind: "first-of",
    order: ["devtools"],
    why: "Only DevTools reads the security state.",
  },
  _priority: { kind: "first-of", order: ["devtools"], why: "Only DevTools reads it." },
  _initiator: {
    kind: "first-of",
    order: ["devtools"],
    why: "Stack traces exist only in DevTools.",
  },
  _resourceType: {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "From externalContentPolicyType.",
  },
  _fromCache: {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "The examine topic says cache or revalidated exactly.",
  },
  _connectionId: { kind: "first-of", order: ["devtools"], why: "Only DevTools reads it." },
  _webSocketMessages: {
    kind: "first-of",
    order: ["devtools"],
    why: "Frames are keyed by resourceId in DevTools' store. The recording has none.",
  },
  _harExport: {
    kind: "export-writes",
    why: "Source, body states and checks, known once the bodies were read.",
  },
  "request.method": { kind: "group", group: "request-head" },
  "request.url": { kind: "group", group: "request-head" },
  "request.httpVersion": { kind: "group", group: "request-head" },
  "request.cookies": { kind: "group", group: "request-head" },
  "request.headers": { kind: "group", group: "request-head" },
  "request.queryString": { kind: "group", group: "request-head" },
  "request.headersSize": { kind: "group", group: "request-head" },
  "request.postData": {
    kind: "export-writes",
    why: "Built from the upload candidate and its MIME type. Text when the bytes are UTF-8, else base64 with encoding.",
  },
  "request.bodySize": {
    kind: "export-writes",
    why: "The upload bytes actually written, or -1 when none were.",
  },
  "request.comment": {
    kind: "export-writes",
    why: "Why the request body is missing or cut short, from MISSING_REASONS or CUT_SHORT_REASONS.",
  },
  "response.status": { kind: "group", group: "response-head" },
  "response.statusText": { kind: "group", group: "response-head" },
  "response.httpVersion": { kind: "group", group: "response-head" },
  "response.cookies": { kind: "group", group: "response-head" },
  "response.headers": { kind: "group", group: "response-head" },
  "response.redirectURL": { kind: "group", group: "response-head" },
  "response.headersSize": { kind: "group", group: "response-head" },
  "response.bodySize": {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "The channel's encodedBodySize at stop.",
  },
  "response.comment": { kind: "export-writes", why: "Reserved for the export's own notes." },
  "response._transferSize": {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "The channel's transferSize at stop.",
  },
  "response._error": {
    kind: "first-of",
    order: ["recording", "devtools"],
    why: "The stop status name, such as NS_ERROR_CONNECTION_REFUSED, for a request that got no response.",
  },
  "response.content.size": {
    kind: "export-writes",
    why: "The decoded bytes actually written, counted while streaming.",
  },
  "response.content.compression": {
    kind: "export-writes",
    why: "Decoded minus wire bytes, known only after the stream.",
  },
  "response.content.mimeType": { kind: "group", group: "response-head" },
  "response.content.text": {
    kind: "export-writes",
    why: "From the body candidate that opened: whole when it fits one window, else streamed as base64.",
  },
  "response.content.encoding": {
    kind: "export-writes",
    why: "base64 unless the bytes are whole, valid UTF-8 in a UTF-8 or ASCII charset (chooseEncoding).",
  },
  "response.content.comment": {
    kind: "export-writes",
    why: "Why the body is missing or cut short, from MISSING_REASONS or CUT_SHORT_REASONS.",
  },
  "cache.beforeRequest": {
    kind: "first-of",
    order: ["devtools"],
    why: "DevTools fills it for cached responses. The recording reads no cache entry.",
  },
  "cache.afterRequest": { kind: "first-of", order: ["devtools"], why: "Same." },
  "cache.comment": { kind: "first-of", order: ["devtools"], why: "Same." },
  "timings.blocked": { kind: "group", group: "timings" },
  "timings.dns": { kind: "group", group: "timings" },
  "timings.connect": { kind: "group", group: "timings" },
  "timings.send": { kind: "group", group: "timings" },
  "timings.wait": { kind: "group", group: "timings" },
  "timings.receive": { kind: "group", group: "timings" },
  "timings.ssl": { kind: "group", group: "timings" },
  "timings.comment": { kind: "group", group: "timings" },
  "timings._blocked_queueing": { kind: "group", group: "timings" },
  "timings._blocked_proxy": { kind: "group", group: "timings" },
  "timings._workerStart": { kind: "group", group: "timings" },
  "timings._workerReady": { kind: "group", group: "timings" },
  "timings._workerFetchStart": { kind: "group", group: "timings" },
  "timings._workerRespondWithSettled": { kind: "group", group: "timings" },
};

/**
 * Body candidates from both sources: the recording's stored bytes first (byte-exact, from disk), then DevTools'
 * (possibly cut at its bodyLimit). When neither has a candidate, the recording's reason wins unless it is not-recorded.
 */
export function bodyPlan(
  recording: BodyCandidates | null,
  devtools: BodyCandidates | null,
): BodyCandidates {
  const candidates: BodySource[] = [];
  if (recording?.kind === "candidates") candidates.push(...recording.list);
  if (devtools?.kind === "candidates") candidates.push(...devtools.list);
  if (candidates.length > 0) {
    return { kind: "candidates", list: candidates as unknown as NonEmpty<BodySource> };
  }
  if (recording === null) return devtools ?? { kind: "none", reason: "not-recorded" };
  if (devtools === null) return recording;
  if (recording.kind === "none") {
    return recording.reason === "not-recorded" ? devtools : recording;
  }
  return { kind: "empty" };
}

/** True when the pair has a DevTools side and the recording offers no candidate. */
export function devtoolsBodyWanted(pair: Pair, recording: Material | null): boolean {
  if (pair.kind === "recording-only") return false;
  if (pair.kind === "devtools-only") return true;
  return recording === null || recording.body.kind !== "candidates";
}

/** What a listing row alone says about a request, used when its source throws while loading the rest. */
export function stubMaterial(item: SourceItem): Material {
  return {
    entry: buildHarEntry({
      startedDateTime: isoDateTimeFromEpochMs(item.startedAt),
      request: { method: item.method, url: toHarUrl(item.url) ?? (item.url as HarRequest["url"]) },
      response: { status: 0, content: { size: -1, mimeType: "" } },
    }),
    body: { kind: "none", reason: "source-error" },
    upload: { kind: "none", reason: "source-error" },
    lostGroups: {
      "request-head": "source-error",
      "response-head": "source-error",
      timings: "source-error",
    },
  };
}

export interface MergedEntry {
  /** Built from FIELD_RULES only. response.content has no text, size or comment yet: the writer fills them. */
  readonly entry: HarEntry;
  readonly body: BodyCandidates;
  readonly upload: BodyCandidates;
  readonly sources: Pair["kind"];
  readonly navigation: boolean;
  readonly inProgress: boolean;
  /** The source the response head came from, which is not FIELD_GROUPS' first when that source failed to load. */
  readonly responseHeadFrom: SourceName;
  readonly headersMissing?: MissingReason | "never-stored" | undefined;
  readonly headersNeverStored?: boolean | undefined;
  readonly timingsMissing?: MissingReason | undefined;
}

const SPEC_TIME_PHASES = ["blocked", "dns", "connect", "send", "wait", "receive"] as const;

function orderForRule(rule: FieldRule): readonly SourceName[] {
  if (rule.kind === "first-of") return rule.order;
  if (rule.kind === "group") return FIELD_GROUPS[rule.group].order;
  return [];
}

function sourceByName(
  name: SourceName,
  recording: Material | null,
  devtools: Material | null,
): Material | null {
  return name === "recording" ? recording : devtools;
}

function pickFromRule<T>(
  field: HarEntryField,
  recording: Material | null,
  devtools: Material | null,
  read: (entry: HarEntry) => T | undefined,
): T | undefined {
  for (const name of orderForRule(FIELD_RULES[field])) {
    const mat = sourceByName(name, recording, devtools);
    if (mat === null) continue;
    const val = read(mat.entry);
    if (val !== undefined) return val;
  }
  return undefined;
}

function hasUsableGroup(group: FieldGroup, mat: Material): boolean {
  if (mat.lostGroups?.[group] !== undefined) return false;
  if (group === "request-head") return mat.entry.request.headers.length > 0;
  if (group === "response-head") return mat.entry.response.headers.length > 0;
  return SPEC_TIME_PHASES.some((phase) => {
    const v = mat.entry.timings[phase];
    return v !== undefined && v >= 0;
  });
}

function groupMissingReason(group: FieldGroup, mat: Material): MissingReason {
  const lost = mat.lostGroups?.[group];
  if (lost !== undefined) return lost;
  return mat.body.kind === "none" ? mat.body.reason : "source-error";
}

function pickGroupSource(
  group: FieldGroup,
  recording: Material | null,
  devtools: Material | null,
): SourceName {
  for (const name of FIELD_GROUPS[group].order) {
    const mat = sourceByName(name, recording, devtools);
    if (mat !== null && hasUsableGroup(group, mat)) return name;
  }
  for (const name of FIELD_GROUPS[group].order) {
    if (sourceByName(name, recording, devtools) !== null) return name;
  }
  throw new Error(`Merged entry requires at least one source for ${group}`);
}

function sumTimings(timings: HarTimings): number {
  let total = 0;
  for (const phase of SPEC_TIME_PHASES) {
    const v = timings[phase];
    if (v !== undefined && v >= 0) total += v;
  }
  return total;
}

function buildMergedRequest(reqMat: Material, uploadMat: Material | null): HarRequest {
  const req = reqMat.entry.request;
  // Carry postData mimeType/params metadata if present so runExport knows the upload's MIME type.
  const metaPostData = req.postData ?? uploadMat?.entry.request.postData;
  return {
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion ?? "",
    cookies: req.cookies ?? [],
    headers: req.headers ?? [],
    queryString: req.queryString ?? [],
    ...(metaPostData !== undefined
      ? {
          postData: {
            mimeType: metaPostData.mimeType,
            params: metaPostData.params ?? [],
            text: "",
          },
        }
      : {}),
    headersSize: req.headersSize ?? -1,
    bodySize: -1,
  };
}

function buildMergedResponse(
  resMat: Material,
  recording: Material | null,
  devtools: Material | null,
): HarResponse {
  const res = resMat.entry.response;
  const bodySize =
    pickFromRule("response.bodySize", recording, devtools, (e) => e.response.bodySize) ?? -1;
  const transferSize = pickFromRule(
    "response._transferSize",
    recording,
    devtools,
    (e) => e.response._transferSize,
  );
  const error = pickFromRule("response._error", recording, devtools, (e) => e.response._error);
  return {
    status: res.status ?? 0,
    statusText: res.statusText ?? "",
    httpVersion: res.httpVersion ?? "",
    cookies: res.cookies ?? [],
    headers: res.headers ?? [],
    content: {
      size: -1,
      mimeType: res.content?.mimeType ?? "",
    },
    redirectURL: res.redirectURL ?? "",
    headersSize: res.headersSize ?? -1,
    bodySize,
    ...(transferSize !== undefined ? { _transferSize: transferSize } : {}),
    ...(error !== undefined ? { _error: error } : {}),
  };
}

function buildMergedTimings(timingsMat: Material): HarTimings {
  const t = timingsMat.entry.timings;
  return {
    ...(t.blocked !== undefined ? { blocked: t.blocked } : {}),
    ...(t.dns !== undefined ? { dns: t.dns } : {}),
    ...(t.connect !== undefined ? { connect: t.connect } : {}),
    send: t.send ?? -1,
    wait: t.wait ?? -1,
    receive: t.receive ?? -1,
    ...(t.ssl !== undefined ? { ssl: t.ssl } : {}),
    ...(t.comment !== undefined ? { comment: t.comment } : {}),
    ...(t._blocked_queueing !== undefined ? { _blocked_queueing: t._blocked_queueing } : {}),
    ...(t._blocked_proxy !== undefined ? { _blocked_proxy: t._blocked_proxy } : {}),
    ...(t._workerStart !== undefined ? { _workerStart: t._workerStart } : {}),
    ...(t._workerReady !== undefined ? { _workerReady: t._workerReady } : {}),
    ...(t._workerFetchStart !== undefined ? { _workerFetchStart: t._workerFetchStart } : {}),
    ...(t._workerRespondWithSettled !== undefined
      ? { _workerRespondWithSettled: t._workerRespondWithSettled }
      : {}),
  };
}

export function mergeEntry(
  pair: Pair,
  recording: Material | null,
  devtools: Material | null,
): MergedEntry {
  const pick = (group: FieldGroup): Material =>
    sourceByName(pickGroupSource(group, recording, devtools), recording, devtools)!;
  const reqMat = pick("request-head");
  const resMat = pick("response-head");
  const timingsMat = pick("timings");

  const startedDateTime = pickFromRule(
    "startedDateTime",
    recording,
    devtools,
    (e) => e.startedDateTime,
  )!;
  const timings = buildMergedTimings(timingsMat);
  const serverIPAddress = pickFromRule(
    "serverIPAddress",
    recording,
    devtools,
    (e) => e.serverIPAddress,
  );
  const connection = pickFromRule("connection", recording, devtools, (e) => e.connection);
  const _securityState = pickFromRule(
    "_securityState",
    recording,
    devtools,
    (e) => e._securityState,
  );
  const _priority = pickFromRule("_priority", recording, devtools, (e) => e._priority);
  const _initiator = pickFromRule("_initiator", recording, devtools, (e) => e._initiator);
  const _resourceType = pickFromRule("_resourceType", recording, devtools, (e) => e._resourceType);
  const _fromCache = pickFromRule("_fromCache", recording, devtools, (e) => e._fromCache);
  const _connectionId = pickFromRule("_connectionId", recording, devtools, (e) => e._connectionId);
  const _webSocketMessages = pickFromRule(
    "_webSocketMessages",
    recording,
    devtools,
    (e) => e._webSocketMessages,
  );

  const beforeRequest = pickFromRule(
    "cache.beforeRequest",
    recording,
    devtools,
    (e) => e.cache.beforeRequest,
  );
  const afterRequest = pickFromRule(
    "cache.afterRequest",
    recording,
    devtools,
    (e) => e.cache.afterRequest,
  );
  const cacheComment = pickFromRule("cache.comment", recording, devtools, (e) => e.cache.comment);

  const entry: HarEntry = {
    startedDateTime,
    time: sumTimings(timings),
    request: buildMergedRequest(reqMat, recording),
    response: buildMergedResponse(resMat, recording, devtools),
    cache: {
      ...(beforeRequest !== undefined ? { beforeRequest } : {}),
      ...(afterRequest !== undefined ? { afterRequest } : {}),
      ...(cacheComment !== undefined ? { comment: cacheComment } : {}),
    },
    timings,
    ...(serverIPAddress !== undefined && serverIPAddress !== "" ? { serverIPAddress } : {}),
    ...(connection !== undefined ? { connection } : {}),
    ...(_securityState !== undefined ? { _securityState } : {}),
    ...(_priority !== undefined ? { _priority } : {}),
    ...(_initiator !== undefined ? { _initiator } : {}),
    ...(_resourceType !== undefined ? { _resourceType } : {}),
    ...(_fromCache !== undefined ? { _fromCache } : {}),
    ...(_connectionId !== undefined ? { _connectionId } : {}),
    ...(_webSocketMessages !== undefined ? { _webSocketMessages } : {}),
  };

  const navigation =
    pair.kind === "both"
      ? pair.recording.navigation || pair.devtools.navigation
      : pair.kind === "recording-only"
        ? pair.recording.navigation
        : pair.devtools.navigation;
  const inProgress =
    pair.kind === "both"
      ? pair.recording.inProgress || pair.devtools.inProgress
      : pair.kind === "recording-only"
        ? pair.recording.inProgress
        : pair.devtools.inProgress;

  const headersNeverStored = Boolean(reqMat.headersNeverStored || resMat.headersNeverStored);
  const groupHeadersMissing =
    (!hasUsableGroup("request-head", reqMat)
      ? groupMissingReason("request-head", reqMat)
      : undefined) ??
    (!hasUsableGroup("response-head", resMat)
      ? groupMissingReason("response-head", resMat)
      : undefined);
  const headersMissing =
    groupHeadersMissing ?? (headersNeverStored ? ("never-stored" as const) : undefined);
  const timingsMissing = !hasUsableGroup("timings", timingsMat)
    ? groupMissingReason("timings", timingsMat)
    : undefined;

  return {
    entry,
    body: bodyPlan(recording?.body ?? null, devtools?.body ?? null),
    upload: bodyPlan(recording?.upload ?? null, devtools?.upload ?? null),
    sources: pair.kind,
    navigation,
    inProgress,
    responseHeadFrom: pickGroupSource("response-head", recording, devtools),
    ...(headersMissing !== undefined ? { headersMissing } : {}),
    ...(headersNeverStored && headersMissing !== "never-stored"
      ? { headersNeverStored: true }
      : {}),
    ...(timingsMissing !== undefined ? { timingsMissing } : {}),
  };
}
