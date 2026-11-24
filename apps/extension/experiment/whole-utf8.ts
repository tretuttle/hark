// Where a piece of UTF-8 read from the middle of a file may end, so the text decoded from it is the file's own.

/** How many of `buffer`'s first `bytes` bytes end on a whole UTF-8 sequence: a sequence cut at the end is left out. */
export const wholeSequences = (buffer: Uint8Array, bytes: number): number => {
  let start = bytes;
  while (start > 0 && ((buffer[start - 1] ?? 0) & 0xc0) === 0x80) start -= 1;
  if (start === 0) return bytes;
  const lead = buffer[start - 1] ?? 0;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start - 1 + length > bytes ? start - 1 : bytes;
};
