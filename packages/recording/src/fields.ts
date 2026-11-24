// Readers for JSON this package wrote earlier and reads back from disk: log lines and segment summaries. A reader
// either returns the typed value or throws Rejected, which the decoder at the boundary turns into null.

import type { ByteCount, EpochMs } from "./ids.ts";

class Rejected extends Error {}

export type Fields = { readonly [key: string]: unknown };

export const reject = (): never => {
  throw new Rejected("rejected");
};

export const isFields = (raw: unknown): raw is Fields =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);
export const fields = (raw: unknown): Fields => (isFields(raw) ? raw : reject());
export const text = (raw: unknown): string => (typeof raw === "string" ? raw : reject());
export const integer = (raw: unknown): number =>
  typeof raw === "number" && Number.isSafeInteger(raw) ? raw : reject();
export const finite = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : reject();
export const byteCount = (raw: unknown): ByteCount =>
  integer(raw) >= 0 ? (raw as ByteCount) : reject();
export const epochMs = (raw: unknown): EpochMs => finite(raw) as EpochMs;
export const list = <T>(raw: unknown, item: (value: unknown) => T): readonly T[] =>
  Array.isArray(raw) ? raw.map(item) : reject();
export const nullable =
  <T>(item: (value: unknown) => T) =>
  (raw: unknown): T | null =>
    raw === null ? null : item(raw);
export const parsed =
  <T>(parse: (raw: string) => T | null) =>
  (raw: unknown): T =>
    parse(text(raw)) ?? reject();

/** Every member of a string union as a runtime list; the record makes a missing member a type error. */
export const members = <T extends string>(record: { readonly [K in T]: true }): readonly T[] =>
  Object.keys(record) as T[];
export const member =
  <T extends string>(values: readonly T[]) =>
  (raw: unknown): T =>
    values.find((v) => v === raw) ?? reject();

/** JSON with every code unit above 0x7e written as a \u escape, so byte offsets equal string offsets. */
const NON_ASCII = new RegExp("[\\u007f-\\uffff]", "g");
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    NON_ASCII,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export function readJson<T>(raw: string, read: (value: unknown) => T): T | null {
  try {
    return read(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Rejected) return null;
    throw error;
  }
}
