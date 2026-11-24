import { describe, expect, it } from "vite-plus/test";
import { wholeSequences } from "./whole-utf8.ts";

describe("a piece of UTF-8 cut from the middle of a file", () => {
  const text = "aé€\u{1f600}z";
  const bytes = new TextEncoder().encode(text);

  it("ends on a whole sequence at every cut, and the pieces decode to the text", () => {
    for (let size = 4; size <= bytes.length; size += 1) {
      let offset = 0;
      let decoded = "";
      while (offset < bytes.length) {
        const piece = bytes.subarray(offset, offset + size);
        const whole = piece.length < size ? piece.length : wholeSequences(piece, piece.length);
        expect(whole, `size ${String(size)} at ${String(offset)}`).toBeGreaterThan(0);
        decoded += new TextDecoder("utf-8", { fatal: true }).decode(piece.subarray(0, whole));
        offset += whole;
      }
      expect(decoded).toBe(text);
    }
  });

  it("leaves out only a sequence cut at the end", () => {
    expect(wholeSequences(bytes, 2)).toBe(1);
    expect(wholeSequences(bytes, 3)).toBe(3);
    expect(wholeSequences(bytes, 5)).toBe(3);
    expect(wholeSequences(bytes, 6)).toBe(6);
    expect(wholeSequences(bytes, 9)).toBe(6);
    expect(wholeSequences(bytes, 10)).toBe(10);
  });
});
