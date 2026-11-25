import type { HarEntry } from "@hark/har/model";
import { exchangeId, type ChannelKey, type EpochMs } from "@hark/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import { buildEntry } from "../src/entry-writer.ts";
import {
  FIELD_GROUPS,
  FIELD_RULES,
  bodyPlan,
  devtoolsBodyWanted,
  mergeEntry,
  pairItems,
} from "../src/merge.ts";
import type { BodyCandidates, DevtoolsBodyRef, SourceItem } from "../src/source.ts";
import {
  EX_ID,
  OLD_RUN_ID,
  PACK_AT,
  RUN_ID,
  T0,
  makeHarEntry,
  makeMaterial,
  makeSourceItem,
} from "./fixtures.ts";
import { importAltered } from "./alter.ts";

const DT_REF = "dt-body" as unknown as DevtoolsBodyRef;

describe("pairItems joins on ExchangeId only", () => {
  it("pairs matching keys, keeps older run separate even with the same channel id, and counts null keys", () => {
    const channel = "15032385539" as ChannelKey;
    const oldKey = exchangeId(OLD_RUN_ID, channel);
    const curKey = exchangeId(RUN_ID, channel);

    const oldRec = makeSourceItem({
      source: "recording",
      key: oldKey,
      startedAt: (T0 - 10_000) as EpochMs,
      url: "https://app.example/old",
    });
    const curRec = makeSourceItem({
      source: "recording",
      key: curKey,
      startedAt: (T0 + 20) as EpochMs,
      url: "https://app.example/cur",
    });
    const curDt = makeSourceItem({
      source: "devtools",
      key: curKey,
      startedAt: (T0 + 35) as EpochMs,
      url: "https://app.example/cur",
    });
    const dtNoKey = makeSourceItem({
      source: "devtools",
      key: null,
      startedAt: (T0 + 5) as EpochMs,
      url: "https://app.example/nokey",
    });
    const dtOnly = makeSourceItem({
      source: "devtools",
      key: exchangeId(RUN_ID, "999" as ChannelKey),
      startedAt: (T0 + 10) as EpochMs,
      url: "https://app.example/private",
    });

    const result = pairItems([curRec, oldRec], [curDt, dtNoKey, dtOnly]);
    expect(result.unpaired).toBe(1);
    expect(result.pairs.map((p) => p.kind)).toEqual([
      "recording-only",
      "devtools-only",
      "devtools-only",
      "both",
    ]);
    expect(result.pairs[0]).toEqual({ kind: "recording-only", recording: oldRec });
    expect(result.pairs[3]).toEqual({ kind: "both", recording: curRec, devtools: curDt });
  });

  it("writes one entry per key: within a source the settled row wins and the rest are counted", () => {
    const key = exchangeId(RUN_ID, "9" as ChannelKey);
    const live = makeSourceItem({ source: "recording", key, inProgress: true });
    const settled = makeSourceItem({
      source: "recording",
      key,
      url: "https://app.example/settled",
    });
    const dtLive = makeSourceItem({ source: "devtools", key, inProgress: true });
    const dtLater = makeSourceItem({
      source: "devtools",
      key,
      inProgress: true,
      url: "https://app.example/later",
    });
    const keyless = makeSourceItem({ source: "devtools", key: null });
    const result = pairItems([live, settled, live], [dtLive, dtLater, keyless, keyless]);
    expect(result.pairs).toEqual([
      { kind: "both", recording: settled, devtools: dtLive },
      { kind: "devtools-only", devtools: keyless },
      { kind: "devtools-only", devtools: keyless },
    ]);
    expect(result.duplicates).toEqual({ recording: 2, devtools: 1 });
    expect(result.unpaired).toBe(2);
  });

  it("marks a pair in progress when either side is still live", () => {
    const rec = makeSourceItem({ source: "recording", inProgress: true });
    const dt = makeSourceItem({ source: "devtools" });
    const entry = makeHarEntry();
    const merged = (r: SourceItem, d: SourceItem) =>
      mergeEntry(
        { kind: "both", recording: r, devtools: d },
        makeMaterial(entry),
        makeMaterial(entry),
      ).inProgress;
    expect(merged(rec, dt)).toBe(true);
    expect(merged(dt, rec)).toBe(true);
    expect(merged({ ...rec, inProgress: false }, dt)).toBe(false);
  });

  it("with a time-window fallback added, exchanges from two runs pair into one entry", async () => {
    const altered = await importAltered<{ pairItems: typeof pairItems }>("merge.ts", {
      id: "time-window-fallback",
      from: '  for (const item of devtools.kept) {\n    if (item.key === null || dtByKey.has(item.key))\n      pairs.push({ kind: "devtools-only", devtools: item });\n  }',
      to: `  for (const dt of devtools.kept) {
    if (dt.key !== null && !dtByKey.has(dt.key)) continue;
    const idx = pairs.findIndex((p) => p.kind === "recording-only" && Math.abs(p.recording.startedAt - dt.startedAt) <= 50 && p.recording.url === dt.url);
    if (idx >= 0) {
      const rec = (pairs[idx] as { readonly recording: typeof dt }).recording;
      pairs[idx] = { kind: "both", recording: rec, devtools: dt };
    } else {
      pairs.push({ kind: "devtools-only", devtools: dt });
    }
  }`,
    });

    const oldRec = makeSourceItem({
      source: "recording",
      key: exchangeId(OLD_RUN_ID, "1" as ChannelKey),
      startedAt: T0,
      url: "https://app.example/same",
    });
    const dtNew = makeSourceItem({
      source: "devtools",
      key: exchangeId(RUN_ID, "2" as ChannelKey),
      startedAt: (T0 + 10) as EpochMs,
      url: "https://app.example/same",
    });
    const res = altered.pairItems([oldRec], [dtNew]);
    // The fallback pairs them into one "both" instead of two separate entries.
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]!.kind).toBe("both");
  });
});

describe("mergeEntry and FIELD_RULES", () => {
  it("takes groups atomically from the winning source and never leaks a losing source's field", () => {
    const recItem = makeSourceItem({ source: "recording", key: EX_ID, startedAt: T0 });
    const dtItem = makeSourceItem({
      source: "devtools",
      key: EX_ID,
      startedAt: (T0 + 22) as EpochMs,
    });

    const recEntry: HarEntry = makeHarEntry({
      url: "https://app.example/rec-url",
      startedAt: T0,
      status: 200,
      statusText: "RecOK",
      mimeType: "text/plain",
      headers: [{ name: "X-From", value: "rec" }],
      timings: { blocked: 10, dns: 20, connect: 30, ssl: 99, send: 1, wait: 2, receive: 3 },
      serverIPAddress: "10.0.0.1",
      connection: "rec-conn",
      _resourceType: "fetch",
      _fromCache: "disk",
      bodySize: 555,
      _transferSize: 666,
    });
    const dtEntry: HarEntry = makeHarEntry({
      url: "https://app.example/dt-url",
      startedAt: (T0 + 22) as EpochMs,
      status: 201,
      statusText: "Created",
      mimeType: "application/json",
      headers: [{ name: "X-From", value: "dt" }],
      timings: { blocked: 1, dns: -1, connect: -1, send: 4, wait: 5, receive: 6 },
      serverIPAddress: "10.0.0.2",
      connection: "dt-conn",
      _securityState: "secure",
      _priority: "High",
      _connectionId: "conn-9",
      _resourceType: "xhr",
      _fromCache: "memory",
      bodySize: -1,
      _transferSize: 10,
    });

    const merged = mergeEntry(
      { kind: "both", recording: recItem, devtools: dtItem },
      makeMaterial(recEntry),
      makeMaterial(dtEntry),
    );

    // first-of recording, devtools
    expect(merged.entry.startedDateTime).toBe(recEntry.startedDateTime);
    expect(merged.entry.serverIPAddress).toBe("10.0.0.1");
    expect(merged.entry._resourceType).toBe("fetch");
    expect(merged.entry._fromCache).toBe("disk");
    expect(merged.entry.response.bodySize).toBe(555);
    expect(merged.entry.response._transferSize).toBe(666);

    // first-of devtools, recording / devtools only
    expect(merged.entry.connection).toBe("dt-conn");
    expect(merged.entry._securityState).toBe("secure");
    expect(merged.entry._priority).toBe("High");
    expect(merged.entry._connectionId).toBe("conn-9");

    // group request-head, response-head, timings (devtools wins; ssl undefined on dt does NOT leak from rec)
    expect(merged.entry.request.url).toBe("https://app.example/dt-url");
    expect(merged.entry.request.headers).toEqual([{ name: "X-From", value: "dt" }]);
    expect(merged.entry.response.status).toBe(201);
    expect(merged.entry.response.statusText).toBe("Created");
    expect(merged.entry.response.content.mimeType).toBe("application/json");
    expect(merged.entry.timings.blocked).toBe(1);
    expect(merged.entry.timings.ssl).toBeUndefined();
    expect(merged.entry.time).toBe(1 + 4 + 5 + 6);
  });

  it("with the startedDateTime rule's order flipped, mergeEntry takes the DevTools start time", async () => {
    const flippedStarted = await importAltered<{ mergeEntry: typeof mergeEntry }>("merge.ts", {
      id: "flip-startedDateTime-order",
      from: '  startedDateTime: {\n    kind: "first-of",\n    order: ["recording", "devtools"],',
      to: '  startedDateTime: {\n    kind: "first-of",\n    order: ["devtools", "recording"],',
    });
    const recItem = makeSourceItem({ source: "recording", key: EX_ID, startedAt: T0 });
    const dtItem = makeSourceItem({
      source: "devtools",
      key: EX_ID,
      startedAt: (T0 + 22) as EpochMs,
    });
    const res = flippedStarted.mergeEntry(
      { kind: "both", recording: recItem, devtools: dtItem },
      makeMaterial(makeHarEntry({ startedAt: T0 })),
      makeMaterial(makeHarEntry({ startedAt: (T0 + 22) as EpochMs })),
    );
    expect(res.entry.startedDateTime).not.toBe(makeHarEntry({ startedAt: T0 }).startedDateTime);

    expect(Object.keys(FIELD_GROUPS)).toEqual(["request-head", "response-head", "timings"]);
    expect(Object.keys(FIELD_RULES).length).toBe(58);
  });

  it("fills headers and timings from recording when devtools lost them, and flags when both lack them", () => {
    const recItem = makeSourceItem({ source: "recording", key: EX_ID, startedAt: T0 });
    const dtItem = makeSourceItem({ source: "devtools", key: EX_ID, startedAt: T0 });
    const fullRec = makeMaterial(
      makeHarEntry({
        headers: [{ name: "X-Rec", value: "1" }],
        timings: { blocked: 0, dns: 1, connect: 2, ssl: 0, send: 3, wait: 4, receive: 5 },
      }),
    );
    const deadDtEntry = makeHarEntry({
      status: 200,
      headers: [],
      timings: { send: -1, wait: -1, receive: -1 },
    });
    const deadDt = {
      entry: {
        ...deadDtEntry,
        request: { ...deadDtEntry.request, headers: [] },
        response: { ...deadDtEntry.response, headers: [] },
      },
      body: { kind: "none" as const, reason: "devtools-discarded" as const },
      upload: { kind: "empty" as const },
      lostGroups: {
        "request-head": "devtools-discarded" as const,
        "response-head": "devtools-discarded" as const,
        timings: "devtools-discarded" as const,
      },
    };

    const filled = mergeEntry(
      { kind: "both", recording: recItem, devtools: dtItem },
      fullRec,
      deadDt,
    );
    expect(filled.entry.request.headers).toEqual([{ name: "X-Rec", value: "1" }]);
    expect(filled.entry.response.headers).toEqual([
      { name: "Content-Type", value: "application/json" },
    ]);
    expect(filled.entry.timings.wait).toBe(4);
    expect(filled.headersMissing).toBeUndefined();
    expect(filled.timingsMissing).toBeUndefined();

    const bothMissing = mergeEntry({ kind: "devtools-only", devtools: dtItem }, null, deadDt);
    expect(bothMissing.headersMissing).toBe("devtools-discarded");
    expect(bothMissing.timingsMissing).toBe("devtools-discarded");
    const written = buildEntry(
      bothMissing,
      "page_0" as never,
      {
        outcome: { kind: "missing", reason: "devtools-discarded" },
        text: null,
        encoding: null,
        size: -1,
        wireBytes: null,
        check: null,
      },
      {
        outcome: { kind: "empty" },
        text: null,
        encoding: null,
        size: 0,
        wireBytes: null,
        check: null,
      },
      [],
    );
    expect(written._harExport?.["headersMissing"]).toBe("devtools-discarded");
    expect(written._harExport?.["timingsMissing"]).toBe("devtools-discarded");
    expect(written.comment).toContain("no longer in DevTools");

    const neverStoredRec = {
      ...fullRec,
      headersNeverStored: true as const,
    };
    const mergedNeverStored = mergeEntry(
      { kind: "recording-only", recording: recItem },
      neverStoredRec,
      null,
    );
    expect(mergedNeverStored.headersMissing).toBe("never-stored");
    const writtenNeverStored = buildEntry(
      mergedNeverStored,
      "page_0" as never,
      {
        outcome: { kind: "empty" },
        text: null,
        encoding: null,
        size: 0,
        wireBytes: null,
        check: null,
      },
      {
        outcome: { kind: "empty" },
        text: null,
        encoding: null,
        size: 0,
        wireBytes: null,
        check: null,
      },
      [],
    );
    expect(writtenNeverStored._harExport?.["headersMissing"]).toBe("never-stored");
    expect(writtenNeverStored.comment).toContain("secret header values never stored");
  });
});

describe("bodyPlan and devtoolsBodyWanted", () => {
  const stored: BodyCandidates = {
    kind: "candidates",
    list: [{ kind: "stored", at: PACK_AT, wireEncoding: null, check: "length-matched" }],
  };
  const dtCand: BodyCandidates = {
    kind: "candidates",
    list: [{ kind: "devtools", ref: DT_REF, encoding: null, length: 14 }],
  };

  it("orders recording candidates before devtools and preserves recording reason except not-recorded", () => {
    expect(bodyPlan(stored, dtCand)).toEqual({
      kind: "candidates",
      list: [stored.list[0], dtCand.list[0]],
    });
    expect(
      bodyPlan(
        { kind: "none", reason: "removed-by-retention" },
        { kind: "none", reason: "devtools-discarded" },
      ),
    ).toEqual({
      kind: "none",
      reason: "removed-by-retention",
    });
    expect(
      bodyPlan(
        { kind: "none", reason: "not-recorded" },
        { kind: "none", reason: "devtools-truncated" },
      ),
    ).toEqual({
      kind: "none",
      reason: "devtools-truncated",
    });
    expect(bodyPlan({ kind: "none", reason: "not-recorded" }, { kind: "empty" })).toEqual({
      kind: "empty",
    });
  });

  it("devtoolsBodyWanted skips body fetch only when recording already offers candidates", () => {
    const rec = makeSourceItem({ source: "recording", key: EX_ID });
    const dt = makeSourceItem({ source: "devtools", key: EX_ID });
    expect(devtoolsBodyWanted({ kind: "recording-only", recording: rec }, null)).toBe(false);
    expect(devtoolsBodyWanted({ kind: "devtools-only", devtools: dt }, null)).toBe(true);
    expect(
      devtoolsBodyWanted(
        { kind: "both", recording: rec, devtools: dt },
        makeMaterial(makeHarEntry(), stored),
      ),
    ).toBe(false);
    expect(
      devtoolsBodyWanted(
        { kind: "both", recording: rec, devtools: dt },
        makeMaterial(makeHarEntry(), { kind: "none", reason: "removed-by-retention" }),
      ),
    ).toBe(true);
  });
});
