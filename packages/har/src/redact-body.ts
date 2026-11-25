import { safeDecodeQueryComponent } from "./internal.ts";
import type { HarPostDataParam } from "./model.ts";
import type { HarRedactionRule } from "./rules.ts";

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = Uint8Array.from(BASE64_CHARS, (c) => c.charCodeAt(0));
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();
const STRING_BATCH = 8_192;

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += STRING_BATCH) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + STRING_BATCH, bytes.length)));
  }
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function decodeBase64(encoded: string): Uint8Array | null {
  const clean = encoded.replace(/\s+/gu, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) return null;
  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean.charCodeAt(i);
    const c1 = clean.charCodeAt(i + 1);
    const c2 = clean.charCodeAt(i + 2);
    const c3 = clean.charCodeAt(i + 3);
    const v0 = c0 < 128 ? BASE64_LOOKUP[c0]! : -1;
    const v1 = c1 < 128 ? BASE64_LOOKUP[c1]! : -1;
    const isLast = i + 4 === clean.length;
    const v2 = isLast && pad === 2 ? 0 : c2 < 128 ? BASE64_LOOKUP[c2]! : -1;
    const v3 = isLast && pad >= 1 ? 0 : c3 < 128 ? BASE64_LOOKUP[c3]! : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return null;
    const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[o++] = (n >> 16) & 0xff;
    if (!(isLast && pad === 2)) out[o++] = (n >> 8) & 0xff;
    if (!(isLast && pad >= 1)) out[o++] = n & 0xff;
  }
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  const groups = Math.ceil(bytes.length / 3);
  const out = new Uint8Array(groups * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = BASE64_CODES[n >> 18]!;
    out[o++] = BASE64_CODES[(n >> 12) & 63]!;
    out[o++] = BASE64_CODES[(n >> 6) & 63]!;
    out[o++] = BASE64_CODES[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const a = bytes[i]!;
    const b = rest === 2 ? bytes[i + 1]! : 0;
    out[o++] = BASE64_CODES[a >> 2]!;
    out[o++] = BASE64_CODES[((a & 3) << 4) | (b >> 4)]!;
    out[o++] = rest === 2 ? BASE64_CODES[(b & 15) << 2]! : 61;
    out[o++] = 61;
  }
  return bytesToBinaryString(out);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  const units = new Uint16Array(bytes.length);
  let n = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      units[n++] = b;
      i += 1;
      continue;
    }
    let need: number;
    let cp: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0x0f;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 0x07;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      return null;
    }
    if (i + need >= bytes.length) return null;
    for (let k = 1; k <= need; k += 1) {
      const c = bytes[i + k]!;
      if (c < (k === 1 ? lower : 0x80) || c > (k === 1 ? upper : 0xbf)) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      units[n++] = 0xd800 + (v >> 10);
      units[n++] = 0xdc00 + (v & 0x3ff);
    } else {
      units[n++] = cp;
    }
    i += need + 1;
  }
  let out = "";
  for (let k = 0; k < n; k += STRING_BATCH) {
    out += String.fromCharCode(...units.subarray(k, Math.min(k + STRING_BATCH, n)));
  }
  return out;
}

function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export type BodyRuleFinder = (name: string) => HarRedactionRule | undefined;

export type BodyRedactionOutcome =
  | { readonly kind: "unchanged"; readonly params?: readonly HarPostDataParam[] }
  | {
      readonly kind: "redacted";
      readonly text: string;
      readonly rules: readonly HarRedactionRule[];
      readonly params?: readonly HarPostDataParam[];
    }
  | { readonly kind: "unparseable" };

function redactJsonValue(
  value: unknown,
  findRule: BodyRuleFinder,
  replacement: string,
  rules: HarRedactionRule[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, findRule, replacement, rules));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const rule = findRule(key);
      if (rule !== undefined) {
        rules.push(rule);
        // Use defineProperty so keys like "__proto__" remain own data properties without mutating prototype.
        Object.defineProperty(out, key, {
          value: replacement,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        Object.defineProperty(out, key, {
          value: redactJsonValue(child, findRule, replacement, rules),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return value;
}

export function redactJsonBodyText(
  rawText: string,
  encoding: string | undefined,
  findRule: BodyRuleFinder,
  replacement: string,
): BodyRedactionOutcome {
  const isBase64 = encoding?.toLowerCase() === "base64";
  let decoded = rawText;
  if (isBase64) {
    const bytes = decodeBase64(rawText);
    if (bytes === null) return { kind: "unparseable" };
    const utf8 = decodeUtf8(bytes);
    if (utf8 === null) return { kind: "unparseable" };
    decoded = utf8;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { kind: "unparseable" };
  }
  const rules: HarRedactionRule[] = [];
  const redacted = redactJsonValue(parsed, findRule, replacement, rules);
  if (rules.length === 0) return { kind: "unchanged" };
  const serialized = JSON.stringify(redacted);
  return {
    kind: "redacted",
    text: isBase64 ? encodeBase64(encodeUtf8(serialized)) : serialized,
    rules,
  };
}

export function redactFormBodyText(
  rawText: string,
  encoding: string | undefined,
  findRule: BodyRuleFinder,
  replacement: string,
): BodyRedactionOutcome {
  const isBase64 = encoding?.toLowerCase() === "base64";
  let decoded = rawText;
  if (isBase64) {
    const bytes = decodeBase64(rawText);
    if (bytes === null) return { kind: "unparseable" };
    const utf8 = decodeUtf8(bytes);
    if (utf8 === null) return { kind: "unparseable" };
    decoded = utf8;
  }
  const encodedReplacement = encodeURIComponent(replacement);
  const outSegments: string[] = [];
  const params: HarPostDataParam[] = [];
  const rules: HarRedactionRule[] = [];

  for (const segment of decoded.split("&")) {
    if (segment.length === 0) {
      outSegments.push(segment);
      continue;
    }
    const eq = segment.indexOf("=");
    const rawName = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? "" : segment.slice(eq + 1);
    const name = safeDecodeQueryComponent(rawName);
    const value = safeDecodeQueryComponent(rawValue);
    const rule = findRule(name);
    if (rule !== undefined) {
      rules.push(rule);
      outSegments.push(`${rawName}=${encodedReplacement}`);
      params.push({ name, value: replacement });
    } else {
      outSegments.push(segment);
      params.push({ name, value });
    }
  }
  if (rules.length === 0) return { kind: "unchanged", params };
  const serialized = outSegments.join("&");
  return {
    kind: "redacted",
    text: isBase64 ? encodeBase64(encodeUtf8(serialized)) : serialized,
    params,
    rules,
  };
}

interface MultipartDelimiter {
  readonly lineStart: number;
  readonly bodyStart: number;
  readonly isClose: boolean;
}

function findMultipartDelimiters(text: string, boundary: string): MultipartDelimiter[] {
  const dashBoundary = `--${boundary}`;
  const delimiters: MultipartDelimiter[] = [];
  let searchFrom = 0;

  while (searchFrom <= text.length) {
    const idx = text.indexOf(dashBoundary, searchFrom);
    if (idx === -1) break;
    const atLineStart = idx === 0 || text[idx - 1] === "\n";
    if (!atLineStart) {
      searchFrom = idx + 1;
      continue;
    }
    const lineStart =
      idx > 0 && text[idx - 1] === "\n" && text[idx - 2] === "\r" ? idx - 2 : idx > 0 ? idx - 1 : 0;
    let p = idx + dashBoundary.length;
    if (text.startsWith("--", p)) {
      p += 2;
      while (p < text.length && (text[p] === " " || text[p] === "\t")) p += 1;
      if (p === text.length || text[p] === "\n" || (text[p] === "\r" && text[p + 1] === "\n")) {
        delimiters.push({ lineStart, bodyStart: text.length, isClose: true });
        break;
      }
      searchFrom = idx + 1;
      continue;
    }
    while (p < text.length && (text[p] === " " || text[p] === "\t")) p += 1;
    if (text[p] === "\r" && text[p + 1] === "\n") {
      delimiters.push({ lineStart, bodyStart: p + 2, isClose: false });
      searchFrom = p + 2;
    } else if (text[p] === "\n") {
      delimiters.push({ lineStart, bodyStart: p + 1, isClose: false });
      searchFrom = p + 1;
    } else {
      searchFrom = idx + 1;
    }
  }
  return delimiters;
}

function partFieldName(headerText: string): string | null {
  const unfolded = headerText.replace(/\r?\n[ \t]+/gu, " ");
  for (const line of unfolded.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-disposition") continue;
    const value = line.slice(colon + 1);
    const match = /(?:^|;)\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/iu.exec(value);
    if (!match) return null;
    if (match[1] !== undefined) {
      return match[1].replace(/\\(.)/gu, "$1");
    }
    return match[2] ?? null;
  }
  return null;
}

function findHeaderBodySplit(text: string, start: number, end: number): number | null {
  if (text.startsWith("\r\n", start) && start + 2 <= end) return start + 2;
  if (text.startsWith("\n", start) && start + 1 <= end) return start + 1;
  const crlf2 = text.indexOf("\r\n\r\n", start);
  const lf2 = text.indexOf("\n\n", start);
  const hasCrlf = crlf2 !== -1 && crlf2 + 4 <= end;
  const hasLf = lf2 !== -1 && lf2 + 2 <= end;
  if (hasCrlf && (!hasLf || crlf2 <= lf2)) return crlf2 + 4;
  if (hasLf) return lf2 + 2;
  return null;
}

export function redactMultipartBodyText(
  rawText: string,
  mimeType: string,
  encoding: string | undefined,
  findRule: BodyRuleFinder,
  replacement: string,
): BodyRedactionOutcome {
  const boundaryMatch = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(mimeType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "";
  if (boundary === "") return { kind: "unparseable" };

  const isBase64 = encoding?.toLowerCase() === "base64";
  let decoded = rawText;
  let bodyReplacement = replacement;
  if (isBase64) {
    const bytes = decodeBase64(rawText);
    if (bytes === null) return { kind: "unparseable" };
    // Preserve binary file parts 1:1 via latin1 byte-char mapping while encoding UTF-8 replacement bytes.
    decoded = bytesToBinaryString(bytes);
    bodyReplacement = bytesToBinaryString(encodeUtf8(replacement));
  }

  const delimiters = findMultipartDelimiters(decoded, boundary);
  if (delimiters.length === 0) return { kind: "unparseable" };

  const cuts: { readonly start: number; readonly end: number }[] = [];
  const rules: HarRedactionRule[] = [];

  for (let i = 0; i < delimiters.length; i += 1) {
    const current = delimiters[i]!;
    if (current.isClose) break;
    const partStart = current.bodyStart;
    const partEnd = i + 1 < delimiters.length ? delimiters[i + 1]!.lineStart : decoded.length;
    const bodyStart = findHeaderBodySplit(decoded, partStart, partEnd);
    if (bodyStart === null) continue;
    const headerText = decoded.slice(partStart, bodyStart);
    const name = partFieldName(headerText);
    if (name === null) continue;
    const rule = findRule(name);
    if (rule !== undefined) {
      rules.push(rule);
      cuts.push({ start: bodyStart, end: partEnd });
    }
  }

  if (rules.length === 0) return { kind: "unchanged" };

  let out = "";
  let cursor = 0;
  for (const cut of cuts) {
    out += decoded.slice(cursor, cut.start) + bodyReplacement;
    cursor = cut.end;
  }
  out += decoded.slice(cursor);

  return {
    kind: "redacted",
    text: isBase64 ? encodeBase64(binaryStringToBytes(out)) : out,
    rules,
  };
}
