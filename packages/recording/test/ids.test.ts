import { describe, expect, it } from "vite-plus/test";

import {
  exchangeId,
  parseChannelKey,
  parseExchangeId,
  parsePositiveMinutes,
  parseRunId,
  parseSite,
  parseTabId,
  runIdAt,
  toMinute,
  type ChannelKey,
  type EpochMs,
  type RunId,
} from "../src/ids.ts";
import { importAltered } from "./alter.ts";

describe("parsers reject malformed input", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2 ** 31 - 1, 2 ** 31 - 1],
    [-1, null],
    [1.5, null],
    ["1", null],
    [Number.NaN, null],
    [2 ** 31, null],
    [null, null],
  ])("tab id %s parses to %s", (raw, want) => {
    expect(parseTabId(raw)).toBe(want);
  });

  it.each([
    [1, 1],
    [15, 15],
    [525_600, 525_600],
    [0, null],
    [-15, null],
    [2.5, null],
    [525_601, null],
    ["15", null],
  ])("minutes %s parse to %s", (raw, want) => {
    expect(parsePositiveMinutes(raw)).toBe(want);
  });

  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["::1", "::1"],
    ["2001:db8::8a2e:370:7334", "2001:db8::8a2e:370:7334"],
    ["::", "::"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"],
    ["::ffff:192.0.2.1", "::ffff:192.0.2.1"],
    ["64:ff9b::1:2:3:4.5.6.7", "64:ff9b::1:2:3:4.5.6.7"],
    ["127.0.0.1:8080", null],
    ["dead:80", null],
    [":::", null],
    ["127.0.0.1:80:80", null],
    ["..:..:..", null],
    ["1::2::3", null],
    ["1:2:3::4:5::6:7:8", null],
    ["1:2:3:4:5:6:7", null],
    ["1:2:3:4:5:6:7:8:9", null],
    ["1:2:3:4:5:6:7::8", null],
    ["12345::1", null],
    ["1.2.3.4::", null],
    ["::1.2.3.256", null],
    ["", null],
    ["https://example.com/", null],
    ["example.com/path", null],
    ["exa mple.com", null],
    ["-example.com", null],
    ["example..com", null],
    ["bücher.example", null],
    [
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    ],
    [`${"a".repeat(64)}.com`, null],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`, null],
    [42, null],
  ])("site %j parses to %j", (raw, want) => {
    expect(parseSite(raw)).toBe(want);
  });

  // Each change loosens one IPv6 check; the parser then takes a host with a port or a malformed address.
  it.each([
    { id: "ipv6-any-width", from: "width === 8", to: "width <= 8" },
    { id: "ipv6-many-compressions", from: "if (halves.length > 2) return false;", to: "" },
    { id: "ipv6-any-tail", from: "if (ipv4 && !IPV4.test(tail)) return false;", to: "" },
  ])("with $id, a host that is not an address is accepted", async (m) => {
    const altered = await importAltered<{ parseSite: typeof parseSite }>("ids.ts", m);
    const accepted = ["127.0.0.1:8080", "dead:80", "1:2:3::4:5::6:7:8", "::1.2.3.256"].filter(
      (host) => altered.parseSite(host) !== null,
    );
    expect(accepted).not.toEqual([]);
  });
});

describe("exchange ids carry the run", () => {
  it("round-trips through parseExchangeId", () => {
    const run = runIdAt(1_794_800_000_000 as EpochMs);
    expect(run).toBe("mwipkv7k");
    const id = exchangeId(run, "15032385539" as ChannelKey);
    expect(id).toBe("mwipkv7k.15032385539");
    expect(parseExchangeId(id)).toEqual({ run, channel: "15032385539" });
  });

  it("the same channel id in two runs gives two ids", () => {
    const channel = "15032385539" as ChannelKey;
    expect(exchangeId("mhz01" as RunId, channel)).not.toBe(exchangeId("mhz02" as RunId, channel));
  });

  it.each([
    "mhz02",
    "mhz02.",
    ".15",
    "mhz02.015",
    "MHZ02.15",
    "mhz02.15.1",
    "mhz02.-1",
    "mhz-02.15",
    "mhz02.123456789012345678901",
  ])("%j is not an exchange id", (raw) => {
    expect(parseExchangeId(raw)).toBeNull();
  });

  it("run and channel parsers accept only their own shapes", () => {
    expect(parseRunId("mhz02")).toBe("mhz02");
    expect(parseRunId("mhz-02")).toBeNull();
    expect(parseChannelKey("0")).toBe("0");
    expect(parseChannelKey("007")).toBeNull();
  });
});

describe("toMinute", () => {
  it.each([
    [1_794_800_000_000, 1_794_799_980_000],
    [1_794_799_980_000, 1_794_799_980_000],
    [1_794_799_980_000 + 59_999, 1_794_799_980_000],
  ])("%d starts minute %d", (at, minute) => {
    expect(toMinute(at as EpochMs)).toBe(minute);
  });
});
