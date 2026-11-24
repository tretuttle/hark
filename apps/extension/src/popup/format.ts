// Numbers as the popup prints them. Fixed to en-US so a count reads the same in every screenshot and test.

const COUNT = new Intl.NumberFormat("en-US");

export const count = (n: number): string => COUNT.format(n);

export const plural = (n: number, one: string, many: string): string =>
  `${count(n)} ${n === 1 ? one : many}`;

/** Decimal units, as file managers on Linux and macOS show them. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function bytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** A local `datetime-local` value, minute precision. */
export function localMinute(ms: number): string {
  const d = new Date(ms);
  const two = (v: number) => String(v).padStart(2, "0");
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

const MIB = 1_048_576;

/** A storage limit, counted in 1024s as limits are set: whole GB, else MB. */
export const limitLabel = (n: number): string =>
  n % (1024 * MIB) === 0 ? `${String(n / (1024 * MIB))} GB` : `${String(Math.round(n / MIB))} MB`;
