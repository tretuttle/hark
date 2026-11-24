const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeAsciiBase64(text: string): string {
  const bytes = text.split("").map((char) => char.charCodeAt(0));
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : 0;
    const c = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63] ?? "";
    out += B64[(triple >> 12) & 63] ?? "";
    out += index + 1 < bytes.length ? (B64[(triple >> 6) & 63] ?? "") : "=";
    out += index + 2 < bytes.length ? (B64[triple & 63] ?? "") : "=";
  }
  return out;
}

export function decodeAsciiBase64(input: string): string {
  const clean = input.replace(/\s+/gu, "");
  let text = "";
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4);
    const sextets = chunk.split("").map((char) => (char === "=" ? 0 : B64.indexOf(char)));
    const a = sextets[0] ?? 0;
    const b = sextets[1] ?? 0;
    const c = sextets[2] ?? 0;
    const d = sextets[3] ?? 0;
    text += String.fromCharCode((a << 2) | (b >> 4));
    if (chunk[2] !== undefined && chunk[2] !== "=") {
      text += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    }
    if (chunk[3] !== undefined && chunk[3] !== "=") {
      text += String.fromCharCode(((c & 3) << 6) | d);
    }
  }
  return text;
}
