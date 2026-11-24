import { describe, expect, it } from "vite-plus/test";

import { isHarUrl, type HarDocument } from "../src/model.ts";
import { redactHar, redactUrl } from "../src/redact.ts";
import type { HarRedactionRule } from "../src/rules.ts";

// The reference is the platform's own URL Standard parser, used only in this test: the package
// itself has no browser or Node globals.
interface PlatformUrl {
  href: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
}
const PlatformUrlClass = (globalThis as unknown as { URL: new (value: string) => PlatformUrl }).URL;

function platformUrl(value: string): PlatformUrl | null {
  try {
    return new PlatformUrlClass(value);
  } catch {
    return null;
  }
}

const WRAPPERS = new Set(["blob:", "view-source:", "jar:", "filesystem:"]);
const MAX_DEPTH = 3;
const REDACTED_URL = "https://redacted.invalid/";
const USERINFO_ONLY: readonly HarRedactionRule[] = [
  { id: "url:userinfo", target: "url-userinfo", names: [], matchAll: true },
];

function hasCredentials(url: PlatformUrl): boolean {
  return url.username !== "" || url.password !== "";
}

function isOpaque(url: PlatformUrl): boolean {
  return !url.href.startsWith(`${url.protocol}//`) && !url.pathname.startsWith("/");
}

// The platform parser's view of a value: not a URL, or a URL possibly inside wrappers, with the
// text before the innermost URL.
type View =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "url";
      readonly prefix: string;
      readonly raw: string;
      readonly url: PlatformUrl;
    };

function view(value: string): View {
  let prefix = "";
  let raw = value;
  let url = platformUrl(raw);
  for (let depth = 0; url !== null && WRAPPERS.has(url.protocol) && isOpaque(url); depth += 1) {
    if (depth === MAX_DEPTH) {
      return { kind: "invalid" };
    }
    const colon = raw.indexOf(":");
    const inner = platformUrl(raw.slice(colon + 1));
    if (inner === null) {
      break;
    }
    prefix += raw.slice(0, colon + 1);
    raw = raw.slice(colon + 1);
    url = inner;
  }
  return url === null ? { kind: "invalid" } : { kind: "url", prefix, raw, url };
}

// True when `output` is `input` with one contiguous run of characters removed.
function isOneCut(input: string, output: string): boolean {
  if (output.length >= input.length) {
    return false;
  }
  let head = 0;
  while (head < output.length && input[head] === output[head]) {
    head += 1;
  }
  return input.endsWith(output.slice(head));
}

// Under `standard` with only the userinfo rule: a URL with credentials loses exactly them, and
// any other value a URL field holds stays byte for byte, or is replaced when it is not a URL.
function standardProblem(value: string, output: string, field: "url" | "title"): string | null {
  const seen = view(value);
  if (seen.kind === "invalid") {
    const expected = field === "url" ? REDACTED_URL : value;
    return output === expected ? null : `not a URL, expected ${expected}`;
  }
  if (!hasCredentials(seen.url)) {
    return output === value ? null : "no credentials, but changed";
  }
  if (!output.startsWith(seen.prefix)) {
    return "wrapper prefix changed";
  }
  const inner = output.slice(seen.prefix.length);
  const expected = new PlatformUrlClass(seen.raw);
  expected.username = "";
  expected.password = "";
  const actual = platformUrl(inner);
  if (actual === null || hasCredentials(actual)) {
    return "credentials remain";
  }
  if (actual.href !== expected.href || !isOneCut(seen.raw, inner)) {
    return `more than the credentials changed: ${actual.href} vs ${expected.href}`;
  }
  return null;
}

// Under `shareable`: no credentials, query or fragment remain, an opaque path is reduced to its
// scheme, the host and path stay, and a value that is not a URL is replaced.
function shareableProblem(value: string, output: string): string | null {
  const seen = view(value);
  if (seen.kind === "invalid") {
    return output === REDACTED_URL ? null : "not a URL, but not replaced";
  }
  if (!output.startsWith(seen.prefix)) {
    return "wrapper prefix changed";
  }
  const actual = platformUrl(output.slice(seen.prefix.length));
  if (actual === null) {
    return "output is not a URL";
  }
  if (hasCredentials(actual) || actual.search !== "" || actual.hash !== "") {
    return "credentials, query or fragment remain";
  }
  if (actual.protocol !== seen.url.protocol || actual.host !== seen.url.host) {
    return "scheme or host changed";
  }
  if (isOpaque(seen.url) ? actual.pathname !== "redacted" : actual.pathname !== seen.url.pathname) {
    return "path not as the level states";
  }
  return null;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMES = [
  "https",
  "HTTP",
  "ws",
  "wss",
  "ftp",
  "file",
  "moz-extension",
  "web+x",
  "a.b-c",
  "data",
  "mailto",
  "about",
  "javascript",
];
const SEPARATORS = [":", "://", ":/", ":///", ":\\\\", ":/\\", ": //", ":\t//", "://\n"];
const USERINFO = [
  "",
  "u@",
  "u:p@",
  ":p@",
  "u:@",
  ":@",
  "@",
  "a@b:c@",
  "u%40x:p@",
  "u:p%40",
  "us\ter:p@",
  "u:http://p@",
  "user:SECRET%40",
  "u@1:SECRET%40",
  "%5BREDACTED%5D@",
];
const HOSTS = [
  "example.com",
  "EXAMPLE.com",
  "",
  "[::1]",
  "[::1",
  "[fe80::1%25eth0]",
  "1.2.3.4",
  "1.2.3",
  "0x7f.1",
  "256.1.1.1",
  "%41pp.example",
  "a%zz.b",
  "a b",
  "münchen.テスト",
  "xn--mnchen-3ya.example",
  "a..b",
  "h:80",
  "h:99999",
  "h:abc",
  "%C3%BC.example",
  "%FF.example",
];
const TAILS = [
  "",
  "/",
  "/p?q=1#f",
  "?q#f",
  "#f",
  "\\x@y",
  "%2F@handle",
  "/@handle",
  " - user@example.com",
  "&e=u@x",
  "/a b",
  "/login?origin=https://first.example&email=alice@example.com",
];
const WRAPPER_PREFIXES = [
  "blob:",
  "view-source:",
  "jar:",
  "filesystem:",
  "BLOB:",
  "feed:",
  "web+abc:",
];
const EDGE_CASES = [
  "https://user:SECRET%40example.com/path",
  "https://u@1:SECRET%40example.com/path",
  "https://example.com - user@example.com",
  "https://example.com\\@handle",
  "https://example.com%2F@handle",
  "https://outer.example/?origin=https://example.com&email=user@example.com",
  "[https://example.com](mailto:user@example.com)",
  "blob:https://@example.com/path",
  "blob:https://%5BREDACTED%5D@example.com/path",
  "blob:null/0d1f-11",
  "view-source:blob:https://u:p@h.example/",
  "Contact user@example.com for support",
  "Clone git@github.com:org/repo",
];
const TEXT_ALPHABET = [
  "a",
  "Z",
  ":",
  "/",
  "\\",
  "@",
  "%",
  "4",
  "0",
  "?",
  "#",
  " ",
  "\t",
  "[",
  "]",
  ".",
  "é",
  "h",
  "t",
  "p",
  "s",
];

function buildCases(count: number): readonly string[] {
  const random = seededRandom(20261116);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const cases: string[] = [...EDGE_CASES];
  const url = () =>
    `${pick(SCHEMES)}${pick(SEPARATORS)}${pick(USERINFO)}${pick(HOSTS)}${pick(TAILS)}`;
  while (cases.length < count) {
    const roll = random();
    if (roll < 0.6) {
      cases.push(url());
    } else if (roll < 0.8) {
      let value = url();
      const depth = 1 + Math.floor(random() * 4);
      for (let level = 0; level < depth; level += 1) {
        value = `${pick(WRAPPER_PREFIXES)}${value}${pick(["", "", "!/inner.js"])}`;
      }
      cases.push(value);
    } else {
      const length = Math.floor(random() * 40);
      cases.push(Array.from({ length }, () => pick(TEXT_ALPHABET)).join(""));
    }
  }
  return cases;
}

function documentWith(values: readonly string[]): HarDocument {
  const entry = (url: string) => ({
    startedDateTime: "2026-11-16T09:00:00.000Z",
    time: 1,
    request: {
      method: "GET",
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "text/plain" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  });
  return {
    log: {
      version: "1.2",
      creator: { name: "c", version: "1" },
      pages: values.map((title, index) => ({
        startedDateTime: "2026-11-16T09:00:00.000Z",
        id: `p${String(index)}`,
        title,
        pageTimings: {},
      })),
      entries: values.map(entry),
    },
  } as unknown as HarDocument;
}

describe("URL redaction against the URL Standard", () => {
  const cases = buildCases(50_000);

  it("generates at least 50,000 strings, including wrappers beyond the stated depth", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50_000);
    const views = cases.map(view);
    expect(
      views.filter((item) => item.kind === "url" && hasCredentials(item.url)).length,
    ).toBeGreaterThan(5_000);
    expect(views.filter((item) => item.kind === "invalid").length).toBeGreaterThan(5_000);
    expect(views.some((item) => item.kind === "url" && item.prefix.split(":").length > 2)).toBe(
      true,
    );
  });

  it("removes exactly the credentials the standard finds, and changes nothing else (standard)", () => {
    const { document, report } = redactHar(documentWith(cases), {
      level: "standard",
      rules: USERINFO_ONLY,
    });
    const problems: string[] = [];
    cases.forEach((value, index) => {
      const url = standardProblem(value, document.log.entries[index]!.request.url, "url");
      if (url !== null) {
        problems.push(`request.url ${JSON.stringify(value)}: ${url}`);
      }
      // A title is examined as a URL only when it has no space or control character.
      const title = document.log.pages![index]!.title;
      const titleProblem = /[\u0000-\u0020\u007f]/u.test(value)
        ? title === value
          ? null
          : "text changed"
        : standardProblem(value, title, "title");
      if (titleProblem !== null) {
        problems.push(`title ${JSON.stringify(value)}: ${titleProblem}`);
      }
    });
    expect(problems.slice(0, 20)).toEqual([]);
    const replaced = report.records.filter(
      (record) => record.place === "wrong-type" && record.field === "request.url",
    );
    expect(replaced.reduce((sum, record) => sum + record.count, 0)).toBe(
      cases.filter((value) => view(value).kind === "invalid").length,
    );
  });

  it("keeps only scheme, host and path of every URL, and replaces every value that is not one (shareable)", () => {
    const { document } = redactHar(documentWith(cases), { level: "shareable" });
    const problems: string[] = [];
    cases.forEach((value, index) => {
      const problem = shareableProblem(value, document.log.entries[index]!.request.url);
      if (problem !== null) {
        problems.push(`${JSON.stringify(value)}: ${problem}`);
      }
      if (document.log.pages![index]!.title !== "") {
        problems.push(`title ${JSON.stringify(value)} kept under shareable`);
      }
    });
    expect(problems.slice(0, 20)).toEqual([]);
  });
});

describe("listed query values", () => {
  it("replaces the value of a listed name, decoded, in a URL or a URL inside a wrapper", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "https://a.example/?access_token=s1&page=2",
        "https://a.example/?access_token=%5BREDACTED%5D&page=2",
      ],
      ["https://a.example/?%61ccess_token=s2", "https://a.example/?%61ccess_token=%5BREDACTED%5D"],
      ["data:?access_token=s3&q=1#f", "data:?access_token=%5BREDACTED%5D&q=1#f"],
      ["blob:https://a.example/x?token=s4", "blob:https://a.example/x?token=%5BREDACTED%5D"],
      ["https://a.example/?q=1#access_token=kept", "https://a.example/?q=1#access_token=kept"],
    ];
    for (const [input, expected] of cases) {
      expect(redactUrl(input).url, input).toBe(expected);
    }
    expect(isHarUrl(redactUrl("/relative?access_token=s5").url)).toBe(true);
  });
});

describe("time on hostile input", () => {
  const SHAPES: ReadonlyArray<readonly [string, (length: number) => string]> = [
    ["a://", (length) => "a://".repeat(length / 4)],
    ["a://u@", (length) => "a://u@".repeat(length / 6)],
    ["@", (length) => "@".repeat(length)],
    ["https:// then @", (length) => `https://${"@".repeat(length)}host`],
    ["blob:https:// then @", (length) => `blob:https://${"@".repeat(length)}host`],
    ["blob: repeated", (length) => `${"blob:".repeat(length / 5)}https://u:p@a.example/x`],
    ["scheme characters", (length) => "a".repeat(length)],
    ["slashes", (length) => `https:${"/".repeat(length)}h`],
    ["brackets", (length) => `https://[${":".repeat(length)}]/`],
  ];

  function timeOf(value: string): number {
    const start = Date.now();
    redactUrl(value);
    redactUrl(value, { level: "shareable" });
    isHarUrl(value);
    return Date.now() - start;
  }

  it("grows in proportion to the input, from 1 MB to 5 MB, with no stack overflow", () => {
    const slow: string[] = [];
    for (const [name, shape] of SHAPES) {
      const one = Math.min(timeOf(shape(1_000_000)), timeOf(shape(1_000_000)));
      const five = timeOf(shape(5_000_000));
      if (five > Math.max(15 * one, 50)) {
        slow.push(`${name}: ${one.toFixed(1)} ms at 1 MB, ${five.toFixed(1)} ms at 5 MB`);
      }
    }
    expect(slow).toEqual([]);
  });
});
