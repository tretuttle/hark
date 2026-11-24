// Every body byte string is written through one decision: text only when the bytes are valid UTF-8 and the declared
// charset agrees, otherwise base64 of the exact bytes. Both sources and both body places come here as bytes.

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = Uint8Array.from(BASE64_CHARS, (c) => c.charCodeAt(0));
const BASE64_VALUES: readonly number[] = Array.from({ length: 128 }, (_, code) =>
  BASE64_CHARS.indexOf(String.fromCharCode(code)),
);
const STRING_BATCH = 8_192;
const UTF8_CHARSETS = new Set(["utf-8", "utf8", "us-ascii", "ascii"]);

export interface WrittenText {
  readonly text: string;
  readonly encoding: "base64" | null;
}

/** The declared charset of a MIME type, lowercased, or null when it names none. */
export function charsetOf(mimeType: string): string | null {
  const match = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/iu.exec(mimeType);
  if (!match?.[1]) return null;
  const value = match[1]
    .replace(/^["']|["']$/gu, "")
    .trim()
    .toLowerCase();
  return value === "" ? null : value;
}

function charCodesToString(codes: Uint16Array | Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += STRING_BATCH) {
    out += String.fromCharCode(...codes.subarray(i, Math.min(i + STRING_BATCH, length)));
  }
  return out;
}

/** WHATWG UTF-8 decode without replacement: the text, or null when any sequence is invalid or unfinished. */
function decodeUtf8Exact(bytes: Uint8Array): string | null {
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
  return charCodesToString(units, n);
}

function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false;
  return true;
}

/**
 * The one encoding decision, for bytes all of which are in hand. `charset` is what the bytes are declared to be. A
 * body that streams past one window is base64 without this call, because its later bytes are not seen in time.
 */
export function chooseEncoding(bytes: Uint8Array, charset: string | null): WrittenText {
  if (charset === null || UTF8_CHARSETS.has(charset) || isAscii(bytes)) {
    const text = decodeUtf8Exact(bytes);
    if (text !== null) return { text, encoding: null };
  }
  return { text: base64Whole(bytes), encoding: "base64" };
}

/** Base64 with padding. */
function base64Whole(bytes: Uint8Array): string {
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
    out[o++] = rest === 2 ? BASE64_CODES[(b & 15) << 2]! : 0x3d;
    out[o++] = 0x3d;
  }
  return charCodesToString(out, o);
}

/** Streams base64 across chunk boundaries: whole 3-byte groups out, up to 2 bytes carried. */
export interface Base64Stream {
  push(bytes: Uint8Array): string;
  end(): string;
}

export function base64Stream(): Base64Stream {
  let carry = new Uint8Array(0);
  return {
    push(bytes) {
      const total = carry.length + bytes.length;
      const whole = total - (total % 3);
      const joined = new Uint8Array(total);
      joined.set(carry, 0);
      joined.set(bytes, carry.length);
      carry = joined.slice(whole);
      return base64Whole(joined.subarray(0, whole));
    },
    end() {
      const out = base64Whole(carry);
      carry = new Uint8Array(0);
      return out;
    },
  };
}

/** DevTools' base64 slices, cut anywhere, as the bytes they encode. */
export async function* bytesFromBase64Slices(
  slices: AsyncIterable<string>,
): AsyncIterable<Uint8Array> {
  let pending: number[] = [];
  for await (const slice of slices) {
    const out = new Uint8Array(Math.ceil((slice.length + 4) / 4) * 3);
    let o = 0;
    for (let i = 0; i < slice.length; i += 1) {
      const code = slice.charCodeAt(i);
      const value = code < 128 ? BASE64_VALUES[code]! : -1;
      if (value < 0) continue;
      pending.push(value);
      if (pending.length === 4) {
        const n = (pending[0]! << 18) | (pending[1]! << 12) | (pending[2]! << 6) | pending[3]!;
        out[o++] = n >> 16;
        out[o++] = (n >> 8) & 255;
        out[o++] = n & 255;
        pending = [];
      }
    }
    if (o > 0) yield out.slice(0, o);
  }
  if (pending.length >= 2) {
    const n = (pending[0]! << 18) | (pending[1]! << 12) | ((pending[2] ?? 0) << 6);
    yield Uint8Array.from(pending.length === 2 ? [n >> 16] : [n >> 16, (n >> 8) & 255]);
  }
}

/**
 * DevTools' decoded text slices as UTF-8. A surrogate pair cut between two slices is joined; a lone surrogate becomes
 * U+FFFD and is counted in `lossy`, because a JS string that holds one has no UTF-8 form.
 */
export function bytesFromTextSlices(slices: AsyncIterable<string>): {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly lossy: () => number;
} {
  let lossy = 0;
  async function* run(): AsyncIterable<Uint8Array> {
    let high = -1;
    for await (const slice of slices) {
      const out = new Uint8Array(slice.length * 3 + 4);
      let o = 0;
      const put = (...bytes: number[]): void => {
        for (const b of bytes) out[o++] = b;
      };
      for (let i = 0; i < slice.length; i += 1) {
        const unit = slice.charCodeAt(i);
        if (high >= 0) {
          const pendingHigh = high;
          high = -1;
          if (unit >= 0xdc00 && unit <= 0xdfff) {
            const cp = 0x10000 + ((pendingHigh - 0xd800) << 10) + (unit - 0xdc00);
            put(
              0xf0 | (cp >> 18),
              0x80 | ((cp >> 12) & 63),
              0x80 | ((cp >> 6) & 63),
              0x80 | (cp & 63),
            );
            continue;
          }
          put(0xef, 0xbf, 0xbd);
          lossy += 1;
        }
        if (unit < 0x80) out[o++] = unit;
        else if (unit < 0x800) put(0xc0 | (unit >> 6), 0x80 | (unit & 63));
        else if (unit >= 0xd800 && unit <= 0xdbff) high = unit;
        else if (unit >= 0xdc00 && unit <= 0xdfff) {
          put(0xef, 0xbf, 0xbd);
          lossy += 1;
        } else put(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 63), 0x80 | (unit & 63));
      }
      if (o > 0) yield out.slice(0, o);
    }
    if (high >= 0) {
      lossy += 1;
      yield Uint8Array.from([0xef, 0xbf, 0xbd]);
    }
  }
  return { bytes: run(), lossy: () => lossy };
}
