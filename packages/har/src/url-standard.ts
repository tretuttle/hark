// The WHATWG URL Standard's parsing rules, as far as redaction needs them. Indices point into the
// original string so a part can be cut out with every other byte untouched. Each step is one pass.
// Narrower than the standard: a non-ASCII host name is taken as valid (no IDNA tables here).

export interface UrlSpan {
  readonly start: number;
  readonly end: number;
}

export interface UrlParts {
  // The scheme without its colon, lowercased.
  readonly scheme: string;
  // Index just after the scheme's colon.
  readonly afterScheme: number;
  // Username, password and the `@` after them, present only when the URL has a non-empty username
  // or password.
  readonly credentials: UrlSpan | null;
  // Host and port, when the URL has an authority.
  readonly host: UrlSpan | null;
  // Path, including an opaque path such as the body of a `data:` URL.
  readonly path: UrlSpan;
  readonly opaquePath: boolean;
  // `?` and the query after it, and `#` and the fragment after it.
  readonly query: UrlSpan | null;
  readonly fragment: UrlSpan | null;
}

const SPECIAL_SCHEMES = new Set(["ftp", "file", "http", "https", "ws", "wss"]);

function isTabOrNewline(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isSchemeCode(code: number): boolean {
  return (
    isAsciiAlpha(code) || isAsciiDigit(code) || code === 0x2b || code === 0x2d || code === 0x2e
  );
}

// The characters of `value` between `start` and `end`, with ASCII tab and newline removed, as the
// standard removes them before parsing.
function cleaned(value: string, start: number, end: number): string {
  const pieces: string[] = [];
  let from = start;
  for (let index = start; index < end; index += 1) {
    if (isTabOrNewline(value.charCodeAt(index))) {
      pieces.push(value.slice(from, index));
      from = index + 1;
    }
  }
  pieces.push(value.slice(from, end));
  return pieces.join("");
}

// The standard reports credentials when the text before the last `@` is anything other than
// nothing or a single `:` (an empty username and an empty password).
function holdsCredentials(value: string, start: number, end: number): boolean {
  let seen = 0;
  let onlyColon = true;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (!isTabOrNewline(code)) {
      seen += 1;
      onlyColon = code === 0x3a;
      if (seen > 1) {
        return true;
      }
    }
  }
  return seen === 1 && !onlyColon;
}

const FORBIDDEN_HOST = new Set([
  0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e,
  0x7c,
]);

function isForbiddenDomainCode(code: number): boolean {
  return FORBIDDEN_HOST.has(code) || code <= 0x1f || code === 0x25 || code === 0x7f;
}

function parseIpv4Number(input: string): number | null {
  if (input.length === 0) {
    return null;
  }
  let radix = 10;
  let digits = input;
  if (digits.length >= 2 && digits[0] === "0" && (digits[1] === "x" || digits[1] === "X")) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length >= 2 && digits[0] === "0") {
    radix = 8;
    digits = digits.slice(1);
  }
  if (digits.length === 0) {
    return 0;
  }
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/u : radix === 8 ? /^[0-7]+$/u : /^[0-9]+$/u;
  if (!pattern.test(digits)) {
    return null;
  }
  return Number.parseInt(digits, radix);
}

function endsInANumber(input: string): boolean {
  const parts = input.split(".");
  if (parts.at(-1) === "") {
    if (parts.length === 1) {
      return false;
    }
    parts.pop();
  }
  const last = parts.at(-1) ?? "";
  if (last.length > 0 && /^[0-9]+$/u.test(last)) {
    return true;
  }
  return parseIpv4Number(last) !== null;
}

function isValidIpv4(input: string): boolean {
  const parts = input.split(".");
  if (parts.at(-1) === "" && parts.length > 1) {
    parts.pop();
  }
  if (parts.length > 4) {
    return false;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Number(part);
    if (value === null) {
      return false;
    }
    numbers.push(value);
  }
  for (let index = 0; index < numbers.length - 1; index += 1) {
    if (numbers[index]! > 255) {
      return false;
    }
  }
  return numbers.at(-1)! < 256 ** (5 - numbers.length);
}

// https://url.spec.whatwg.org/#concept-ipv6-parser
function isValidIpv6(input: string): boolean {
  let pieceIndex = 0;
  let compress = -1;
  let pointer = 0;
  const at = (offset = 0) => input.charCodeAt(pointer + offset);
  const isHex = (code: number) =>
    isAsciiDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
  if (at() === 0x3a) {
    if (at(1) !== 0x3a) {
      return false;
    }
    pointer += 2;
    pieceIndex += 1;
    compress = pieceIndex;
  }
  while (pointer < input.length) {
    if (pieceIndex === 8) {
      return false;
    }
    if (at() === 0x3a) {
      if (compress !== -1) {
        return false;
      }
      pointer += 1;
      pieceIndex += 1;
      compress = pieceIndex;
      continue;
    }
    let length = 0;
    while (length < 4 && pointer < input.length && isHex(at())) {
      pointer += 1;
      length += 1;
    }
    if (pointer < input.length && at() === 0x2e) {
      if (length === 0) {
        return false;
      }
      pointer -= length;
      if (pieceIndex > 6) {
        return false;
      }
      let numbersSeen = 0;
      while (pointer < input.length) {
        let value = -1;
        if (numbersSeen > 0) {
          if (at() === 0x2e && numbersSeen < 4) {
            pointer += 1;
          } else {
            return false;
          }
        }
        if (pointer >= input.length || !isAsciiDigit(at())) {
          return false;
        }
        while (pointer < input.length && isAsciiDigit(at())) {
          const digit = at() - 0x30;
          if (value === -1) {
            value = digit;
          } else if (value === 0) {
            return false;
          } else {
            value = value * 10 + digit;
          }
          if (value > 255) {
            return false;
          }
          pointer += 1;
        }
        numbersSeen += 1;
        if (numbersSeen === 2 || numbersSeen === 4) {
          pieceIndex += 1;
        }
      }
      if (numbersSeen !== 4) {
        return false;
      }
      break;
    } else if (pointer < input.length && at() === 0x3a) {
      pointer += 1;
      if (pointer >= input.length) {
        return false;
      }
    } else if (pointer < input.length) {
      return false;
    }
    pieceIndex += 1;
  }
  return compress !== -1 ? pieceIndex <= 8 : pieceIndex === 8;
}

// Decodes UTF-8 bytes, with U+FFFD for any malformed sequence, as the standard does.
function utf8Decode(bytes: readonly number[]): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    const length =
      byte < 0x80 ? 1 : byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 ? 2 : 0;
    let code =
      length === 1 ? byte : length === 2 ? byte & 0x1f : length === 3 ? byte & 0x0f : byte & 0x07;
    let valid = length > 0 && index + length <= bytes.length;
    for (let offset = 1; valid && offset < length; offset += 1) {
      const next = bytes[index + offset]!;
      valid = (next & 0xc0) === 0x80;
      code = (code << 6) | (next & 0x3f);
    }
    const minimum = length === 2 ? 0x80 : length === 3 ? 0x800 : length === 4 ? 0x10000 : 0;
    if (!valid || code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += "\uFFFD";
      index += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    index += length;
  }
  return out;
}

// Percent-decodes `input`. Characters that are not part of an escape are kept as they are.
function percentDecode(input: string): string {
  if (!input.includes("%")) {
    return input;
  }
  let out = "";
  let pending: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const hex = input.slice(index + 1, index + 3);
    if (input.charCodeAt(index) === 0x25 && /^[0-9a-fA-F]{2}$/u.test(hex)) {
      pending.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    out += utf8Decode(pending) + input[index];
    pending = [];
  }
  return out + utf8Decode(pending);
}

// https://url.spec.whatwg.org/#concept-host-parser
function isValidHost(host: string, special: boolean): boolean {
  if (host.startsWith("[")) {
    return host.endsWith("]") && isValidIpv6(host.slice(1, -1));
  }
  if (!special) {
    for (let index = 0; index < host.length; index += 1) {
      if (FORBIDDEN_HOST.has(host.charCodeAt(index))) {
        return false;
      }
    }
    return true;
  }
  const domain = percentDecode(host);
  if (domain === null) {
    return true;
  }
  if (domain.length === 0 || domain.includes("�")) {
    return false;
  }
  const ascii = domain.toLowerCase();
  for (let index = 0; index < ascii.length; index += 1) {
    if (isForbiddenDomainCode(ascii.charCodeAt(index))) {
      return false;
    }
  }
  return endsInANumber(ascii) ? isValidIpv4(ascii) : true;
}

function isValidPort(port: string): boolean {
  return port.length === 0 || (/^[0-9]+$/u.test(port) && Number(port) <= 65535);
}

// Splits path, query and fragment from `from` to `end`, skipping tab and newline.
function tailParts(
  value: string,
  from: number,
  end: number,
): { path: UrlSpan; query: UrlSpan | null; fragment: UrlSpan | null } {
  let queryStart = -1;
  let fragmentStart = -1;
  for (let index = from; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x23) {
      fragmentStart = index;
      break;
    }
    if (code === 0x3f && queryStart === -1) {
      queryStart = index;
    }
  }
  const pathEnd = queryStart !== -1 ? queryStart : fragmentStart !== -1 ? fragmentStart : end;
  return {
    path: { start: from, end: pathEnd },
    query:
      queryStart === -1
        ? null
        : { start: queryStart, end: fragmentStart === -1 ? end : fragmentStart },
    fragment: fragmentStart === -1 ? null : { start: fragmentStart, end },
  };
}

// Parses `value` as an absolute URL with no base. Returns null when the standard returns failure.
export function parseUrl(value: string): UrlParts | null {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  let index = start;
  const skip = () => {
    while (index < end && isTabOrNewline(value.charCodeAt(index))) {
      index += 1;
    }
  };
  skip();
  if (index >= end || !isAsciiAlpha(value.charCodeAt(index))) {
    return null;
  }
  while (index < end) {
    const code = value.charCodeAt(index);
    if (code === 0x3a) {
      break;
    }
    if (!isTabOrNewline(code) && !isSchemeCode(code)) {
      return null;
    }
    index += 1;
  }
  if (index >= end) {
    return null;
  }
  const scheme = cleaned(value, start, index).toLowerCase();
  const afterScheme = index + 1;
  index = afterScheme;
  skip();
  const special = SPECIAL_SCHEMES.has(scheme);
  const at = () => value.charCodeAt(index);
  const isSlash = (code: number) => code === 0x2f || (special && code === 0x5c);

  if (scheme === "file") {
    if (index < end && isSlash(at())) {
      index += 1;
      skip();
      if (index < end && isSlash(at())) {
        index += 1;
        const hostStart = index;
        while (index < end && !isSlash(at()) && at() !== 0x3f && at() !== 0x23) {
          index += 1;
        }
        const buffer = cleaned(value, hostStart, index);
        const driveLetter = /^[A-Za-z][:|]$/u.test(buffer);
        if (!driveLetter && buffer.length > 0 && !isValidHost(buffer, true)) {
          return null;
        }
        return {
          scheme,
          afterScheme,
          credentials: null,
          host: driveLetter ? null : { start: hostStart, end: index },
          opaquePath: false,
          ...tailParts(value, driveLetter ? hostStart : index, end),
        };
      }
    }
    return {
      scheme,
      afterScheme,
      credentials: null,
      host: null,
      opaquePath: false,
      ...tailParts(value, afterScheme, end),
    };
  }

  let hasAuthority = false;
  if (special) {
    while (index < end && (isSlash(at()) || isTabOrNewline(at()))) {
      index += 1;
    }
    hasAuthority = true;
  } else if (index < end && at() === 0x2f) {
    index += 1;
    skip();
    if (index < end && at() === 0x2f) {
      index += 1;
      hasAuthority = true;
    } else {
      return {
        scheme,
        afterScheme,
        credentials: null,
        host: null,
        opaquePath: false,
        ...tailParts(value, afterScheme, end),
      };
    }
  }

  if (!hasAuthority) {
    return {
      scheme,
      afterScheme,
      credentials: null,
      host: null,
      opaquePath: true,
      ...tailParts(value, afterScheme, end),
    };
  }

  const authorityStart = index;
  let lastAt = -1;
  while (index < end) {
    const code = at();
    if (code === 0x2f || code === 0x3f || code === 0x23 || (special && code === 0x5c)) {
      break;
    }
    if (code === 0x40) {
      lastAt = index;
    }
    index += 1;
  }
  const authorityEnd = index;
  const hostStart = lastAt === -1 ? authorityStart : lastAt + 1;
  const hostAndPort = cleaned(value, hostStart, authorityEnd);
  if (lastAt !== -1 && hostAndPort.length === 0) {
    return null;
  }
  let insideBrackets = false;
  let colon = -1;
  for (let position = 0; position < hostAndPort.length; position += 1) {
    const code = hostAndPort.charCodeAt(position);
    if (code === 0x5b) {
      insideBrackets = true;
    } else if (code === 0x5d) {
      insideBrackets = false;
    } else if (code === 0x3a && !insideBrackets) {
      colon = position;
      break;
    }
  }
  const host = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
  const port = colon === -1 ? "" : hostAndPort.slice(colon + 1);
  if (colon === 0 || (special && host.length === 0)) {
    return null;
  }
  if (host.length > 0 && !isValidHost(host, special)) {
    return null;
  }
  if (!isValidPort(port)) {
    return null;
  }
  const hasCredentials = lastAt !== -1 && holdsCredentials(value, authorityStart, lastAt);
  return {
    scheme,
    afterScheme,
    credentials: hasCredentials ? { start: authorityStart, end: lastAt + 1 } : null,
    host: { start: hostStart, end: authorityEnd },
    opaquePath: false,
    ...tailParts(value, authorityEnd, end),
  };
}
