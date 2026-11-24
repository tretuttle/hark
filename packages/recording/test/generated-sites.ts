// Sites of every shape parseSite accepts, for generated tests: DNS names from 1 to 253 characters over every allowed
// character class, names whose directory name is cut (long, or long once `_` is escaped), Windows device names, and
// IPv6 hosts. Every value is checked against parseSite, so the generator cannot drift from the rules it covers.

import { parseSite, type Site } from "../src/ids.ts";
import type { random } from "./random.ts";

type Random = ReturnType<typeof random>;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
/** Character classes a DNS label may use; `-` never at a label's edge. */
const CLASSES: readonly string[] = [LETTERS, DIGITS, "_", `${LETTERS}${DIGITS}_`];
const DEVICE_NAMES: readonly string[] = ["con", "prn", "aux", "nul", "com1", "lpt9"];
const MAX_SITE = 253;

function label(r: Random, length: number): string {
  const edge = r.pick(CLASSES);
  const inner = `${r.pick(CLASSES)}-`;
  let text = "";
  for (let i = 0; i < length; i++) {
    const pool = i === 0 || i === length - 1 ? edge : inner;
    text += pool[r.int(pool.length)];
  }
  return text;
}

/** A DNS name of exactly `length` characters, labels of 1 to 63. */
function dnsName(r: Random, length: number): string {
  let text = label(r, 1 + r.int(63));
  while (text.length < length) text += `.${label(r, 1 + r.int(63))}`;
  text = text.slice(0, length);
  return /[.-]$/.test(text) ? `${text.slice(0, -1)}a` : text;
}

function hexGroup(r: Random): string {
  return (r.int(0x10000) >> (4 * r.int(4))).toString(16);
}

function ipv6(r: Random): string {
  const ipv4Tail = r.chance(0.2);
  const groups = Array.from({ length: ipv4Tail ? 6 : 8 }, () => hexGroup(r));
  const tail = ipv4Tail ? [Array.from({ length: 4 }, () => r.int(256)).join(".")] : [];
  if (r.chance(0.6)) {
    const from = r.int(groups.length + 1);
    const to = from + r.int(groups.length - from + 1);
    const head = groups.slice(0, from).join(":");
    const rest = [...groups.slice(to), ...tail].join(":");
    if (to - from >= 1) return `${head}::${rest}`;
  }
  return [...groups, ...tail].join(":");
}

/** Lengths weighted toward the edges that matter: 1, the 64-character directory cut, and the 253 maximum. */
function siteLength(r: Random): number {
  const roll = r.int(10);
  if (roll < 3) return 1 + r.int(MAX_SITE);
  if (roll < 6) return 50 + r.int(30);
  if (roll < 7) return MAX_SITE - r.int(5);
  return 1 + r.int(20);
}

function generatedSite(r: Random): Site {
  for (;;) {
    const shape = r.int(10);
    const raw =
      shape === 0
        ? ipv6(r)
        : shape === 1
          ? `${r.pick(DEVICE_NAMES)}${r.chance(0.5) ? `.${dnsName(r, 1 + r.int(20))}` : ""}`
          : dnsName(r, siteLength(r));
    const site = parseSite(raw);
    if (site !== null && site === raw) return site;
  }
}

/** `count` distinct sites; sometimes two share a long prefix, so their cut directory names differ only by the hash. */
export function generatedSites(r: Random, count: number): readonly Site[] {
  const sites = new Set<Site>();
  while (sites.size < count) {
    const site = generatedSite(r);
    sites.add(site);
    const twin = parseSite(`${site.slice(0, -1)}${site.endsWith("a") ? "b" : "a"}`);
    if (site.length > 60 && twin !== null && sites.size < count && r.chance(0.5)) sites.add(twin);
  }
  return [...sites];
}
