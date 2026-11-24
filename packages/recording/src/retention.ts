// What to delete, oldest first, whole files only. Every file counts toward its cap, open or sealed; open files are
// never deleted, only rotated. The size walk stops at the first pinned file instead of skipping it, so a pin never
// causes newer data to be deleted first. Age deletes skip pinned and open files. Lines outlive the bodies
// they point at, and the export derives "removed by retention".

import type { ByteCount, EpochMs, ExchangeId, LogSegmentId, PackId, Site } from "./ids.ts";
import type { UserSettings } from "./settings.ts";

export type RetentionRef =
  | { readonly kind: "pack"; readonly pack: PackId }
  | { readonly kind: "body-file"; readonly site: Site; readonly id: ExchangeId }
  | { readonly kind: "segment"; readonly segment: LogSegmentId };

export interface RetentionFile {
  readonly ref: RetentionRef;
  readonly bytes: ByteCount;
  /** Newest write or, for a body file, its line's time. Ties break on the ref's name, so the order is total. */
  readonly newestAt: EpochMs;
  /** The current run still appends to it. Counted, never deleted. */
  readonly open: boolean;
  /** An export listed it and has not released its pin. */
  readonly pinned: boolean;
}

export interface RetentionInventory {
  readonly now: EpochMs;
  /** Packs and body files, every site. */
  readonly bodies: readonly RetentionFile[];
  /** Log segments with their summaries, every site. */
  readonly details: readonly RetentionFile[];
}

export type RetentionStep =
  | { readonly kind: "delete"; readonly ref: RetentionRef; readonly why: "age" | "size" }
  /** Over the cap and the next oldest file is open: seal it now so the next pass can weigh it. */
  | { readonly kind: "rotate"; readonly ref: RetentionRef }
  /** Over the cap and the next oldest file is pinned: wait for the export to release it. Deletes nothing newer. */
  | { readonly kind: "blocked-by-pin"; readonly ref: RetentionRef; readonly overBy: ByteCount };

const DAY_MS = 86_400_000;
const refName = (r: RetentionRef): string =>
  r.kind === "pack"
    ? `p:${String(r.pack)}`
    : r.kind === "body-file"
      ? `b:${String(r.site)}/${String(r.id)}`
      : `s:${String(r.segment)}`;
const oldestFirst = (a: RetentionFile, b: RetentionFile): number =>
  a.newestAt - b.newestAt || (refName(a.ref) < refName(b.ref) ? -1 : 1);

function planClass(
  files: readonly RetentionFile[],
  cap: ByteCount,
  maxAgeDays: number,
  now: EpochMs,
): RetentionStep[] {
  const steps: RetentionStep[] = [];
  const sorted = [...files].sort(oldestFirst);
  let total = sorted.reduce((sum, f) => sum + f.bytes, 0);
  const gone = new Set<string>();
  for (const f of sorted) {
    if (!f.open && !f.pinned && now - f.newestAt > maxAgeDays * DAY_MS) {
      steps.push({ kind: "delete", ref: f.ref, why: "age" });
      gone.add(refName(f.ref));
      total -= f.bytes;
    }
  }
  for (const f of sorted) {
    if (total <= cap) break;
    if (gone.has(refName(f.ref))) continue;
    if (f.pinned) {
      steps.push({ kind: "blocked-by-pin", ref: f.ref, overBy: (total - cap) as ByteCount });
      break;
    }
    if (f.open) {
      steps.push({ kind: "rotate", ref: f.ref });
      break;
    }
    steps.push({ kind: "delete", ref: f.ref, why: "size" });
    total -= f.bytes;
  }
  return steps;
}

/** Deterministic. A second run on the inventory after the deletes has no delete step. */
export function planRetention(
  inventory: RetentionInventory,
  settings: UserSettings,
): readonly RetentionStep[] {
  return [
    ...planClass(
      inventory.bodies,
      settings.retention.maxBodyBytes,
      settings.retention.maxAgeDays,
      inventory.now,
    ),
    ...planClass(
      inventory.details,
      settings.retention.maxDetailBytes,
      settings.retention.maxAgeDays,
      inventory.now,
    ),
  ];
}

/** The deletes and rotations applied to an inventory, as the store performs them. */
export function applyRetention(
  inventory: RetentionInventory,
  steps: readonly RetentionStep[],
): RetentionInventory {
  const deleted = new Set(steps.filter((s) => s.kind === "delete").map((s) => refName(s.ref)));
  const rotated = new Set(steps.filter((s) => s.kind === "rotate").map((s) => refName(s.ref)));
  const keep = (files: readonly RetentionFile[]): readonly RetentionFile[] =>
    files
      .filter((f) => !deleted.has(refName(f.ref)))
      .map((f) => (rotated.has(refName(f.ref)) ? { ...f, open: false } : f));
  return { ...inventory, bodies: keep(inventory.bodies), details: keep(inventory.details) };
}

/** Files an in-flight export listed. The store marks them pinned in the inventory until `release`. */
export interface Pins {
  readonly packs: ReadonlySet<PackId>;
  readonly bodyFiles: ReadonlySet<ExchangeId>;
  readonly segments: ReadonlySet<LogSegmentId>;
}
