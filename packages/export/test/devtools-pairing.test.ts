import { describe, expect, it } from "vite-plus/test";
import {
  exchangeId,
  parseChannelKey,
  runIdAt,
  toMinute,
  type EpochMs,
  type Site,
} from "@hark/recording/ids";
import { pairItems } from "../src/merge.ts";
import type { SourceItem, SourceRef } from "../src/source.ts";

const RUN_1 = runIdAt(1_700_000_000_000 as EpochMs);
const RUN_2 = runIdAt(1_700_000_060_000 as EpochMs);
const SAME_CHANNEL = parseChannelKey("42")!;
const MINUTE = toMinute(1_700_000_000_000 as EpochMs);
const SITE = "https://example.com" as Site;

describe("cross-restart channelId collision isolation", () => {
  it("never pairs a current-run DevTools item whose channelId equals an older run's archived line", () => {
    const olderItem: SourceItem = {
      source: "recording",
      key: exchangeId(RUN_1, SAME_CHANNEL),
      startedAt: 1_700_000_001_000 as EpochMs,
      startedMinute: MINUTE,
      url: "https://example.com/old-run",
      method: "GET",
      tab: { run: RUN_1, browserId: 1 },
      site: SITE,
      navigation: true,
      fetchOrXhr: false,
      inProgress: false,
      ref: 0 as unknown as SourceRef,
    };

    const currentDevtoolsItem: SourceItem = {
      source: "devtools",
      key: exchangeId(RUN_2, SAME_CHANNEL),
      startedAt: 1_700_000_060_000 as EpochMs,
      startedMinute: toMinute(1_700_000_060_000 as EpochMs),
      url: "https://example.com/new-run",
      method: "GET",
      tab: { run: RUN_2, browserId: 2 },
      site: SITE,
      navigation: true,
      fetchOrXhr: false,
      inProgress: false,
      ref: 0 as unknown as SourceRef,
    };

    const paired = pairItems([olderItem], [currentDevtoolsItem]);
    expect(paired.pairs.map((p) => p.kind)).toEqual(["recording-only", "devtools-only"]);

    const sameRunMatched = pairItems(
      [{ ...olderItem, key: exchangeId(RUN_2, SAME_CHANNEL) }],
      [currentDevtoolsItem],
    );
    expect(sameRunMatched.pairs.map((p) => p.kind)).toEqual(["both"]);
  });

  it("keys with the same channel in different runs remain distinct", () => {
    expect(parseChannelKey("42")).toBe(SAME_CHANNEL);
    expect(exchangeId(RUN_1, SAME_CHANNEL)).not.toBe(exchangeId(RUN_2, SAME_CHANNEL));
  });
});
