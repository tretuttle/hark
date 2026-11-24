import { describe, expect, it } from "vite-plus/test";
import { NETWORK_SCHEMES, classifyUrl } from "../src/source.ts";
import { importAltered } from "./alter.ts";

describe("classifyUrl", () => {
  it.each([
    ["https://example.com/path?a=1#h", { kind: "network", url: "https://example.com/path?a=1#h" }],
    ["http://127.0.0.1:8080/api", { kind: "network", url: "http://127.0.0.1:8080/api" }],
    ["HTTP://[::1]:8080/v1", { kind: "network", url: "HTTP://[::1]:8080/v1" }],
    [
      "https://user:pass@example.com/cb?code=1",
      { kind: "network", url: "https://user:pass@example.com/cb?code=1" },
    ],
    ["data:image/png;base64,iVBORw0KGgo=", { kind: "not-network", scheme: "data:" }],
    ["DATA:text/plain,hello", { kind: "not-network", scheme: "data:" }],
    [
      "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000",
      { kind: "not-network", scheme: "blob:" },
    ],
    ["about:blank", { kind: "not-network", scheme: "about:" }],
    ["javascript:void(0)", { kind: "not-network", scheme: "javascript:" }],
    ["chrome://browser/content/browser.xhtml", { kind: "not-network", scheme: "chrome:" }],
    ["moz-extension://uuid/popup.html", { kind: "not-network", scheme: "moz-extension:" }],
    ["file:///etc/hosts", { kind: "not-network", scheme: "file:" }],
    ["", { kind: "malformed" }],
    ["   ", { kind: "malformed" }],
    ["not a url", { kind: "malformed" }],
    ["/relative/path", { kind: "malformed" }],
    ["//example.com/path", { kind: "malformed" }],
    ["http:", { kind: "malformed" }],
    ["http://", { kind: "malformed" }],
    ["http:///path", { kind: "malformed" }],
    ["http://:80/path", { kind: "malformed" }],
    ["http://user@/path", { kind: "malformed" }],
    ["http://[::1/path", { kind: "malformed" }],
    ["http://example.com:99999/path", { kind: "malformed" }],
    ["http://example.com:abc/path", { kind: "malformed" }],
    ["https://example.com/has space", { kind: "malformed" }],
    ["https://example.com/\n", { kind: "malformed" }],
    ["data:", { kind: "malformed" }],
    ["about:", { kind: "malformed" }],
  ])("classifies %j", (raw, expected) => {
    expect(classifyUrl(raw)).toEqual(expected);
  });

  it("NETWORK_SCHEMES holds only http: and https:", () => {
    expect(NETWORK_SCHEMES).toEqual(["http:", "https:"]);
  });

  it("with data: added to NETWORK_SCHEMES, a data: URL is not classified as not-network", async () => {
    const broken = await importAltered<{ classifyUrl: typeof classifyUrl }>("source.ts", {
      id: "data-in-network-schemes",
      from: 'export const NETWORK_SCHEMES: readonly string[] = ["http:", "https:"];',
      to: 'export const NETWORK_SCHEMES: readonly string[] = ["http:", "https:", "data:"];',
    });
    expect(broken.classifyUrl("data:text/plain,hi").kind).not.toBe("not-network");
  });
});
