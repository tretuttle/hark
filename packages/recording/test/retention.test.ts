import { describe, expect, it } from "vite-plus/test";

import type { ByteCount, EpochMs, LogSegmentId, PackId } from "../src/ids.ts";
import * as retention from "../src/retention.ts";
import type {
  RetentionFile,
  RetentionInventory,
  RetentionRef,
  RetentionStep,
} from "../src/retention.ts";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "../src/settings.ts";
import { importAltered, type SourceChange } from "./alter.ts";
import { random } from "./random.ts";

type Planner = Pick<typeof retention, "planRetention" | "applyRetention">;

const MiB = 1_048_576;
const GiB = 1024 * MiB;
const DAY = 86_400_000;
const NOW = 1_794_800_000_000 as EpochMs;
const sum = (files: readonly RetentionFile[]) => files.reduce((a, f) => a + f.bytes, 0);
const file = (
  ref: RetentionRef,
  bytes: number,
  ageMs: number,
  extra: Partial<RetentionFile> = {},
): RetentionFile => ({
  ref,
  bytes: bytes as ByteCount,
  newestAt: (NOW - ageMs) as EpochMs,
  open: false,
  pinned: false,
  ...extra,
});
const pack = (name: string, bytes: number, ageMs: number, extra?: Partial<RetentionFile>) =>
  file({ kind: "pack", pack: name as PackId }, bytes, ageMs, extra);
const segment = (name: string, bytes: number, ageMs: number, extra?: Partial<RetentionFile>) =>
  file({ kind: "segment", segment: name as LogSegmentId }, bytes, ageMs, extra);
const named = (f: RetentionFile) =>
  f.ref.kind === "pack"
    ? f.ref.pack
    : f.ref.kind === "segment"
      ? f.ref.segment
      : `${f.ref.site}/${f.ref.id}`;

interface Scenario {
  readonly id: string;
  readonly inventory: () => RetentionInventory;
  readonly holds: (after: RetentionInventory, steps: readonly RetentionStep[]) => boolean;
}

// Many open files, pins beside a newer file, and the age rule, under the default caps.
const SCENARIOS: readonly Scenario[] = [
  {
    id: "100 active sites, open files counted",
    inventory: () => {
      const bodies: RetentionFile[] = [];
      const details: RetentionFile[] = [];
      for (let s = 0; s < 100; s++) {
        bodies.push(pack(`s${s}/r1-open`, 8 * MiB, 1_000, { open: true }));
        details.push(segment(`s${s}/r1-open`, 2 * MiB, 1_000, { open: true }));
      }
      for (let i = 0; i < 700; i++) bodies.push(pack(`old/r0-${i}`, 8 * MiB, (i + 1) * 60_000));
      for (let i = 0; i < 600; i++) details.push(segment(`old/r0-${i}`, 2 * MiB, (i + 1) * 60_000));
      return { now: NOW, bodies, details };
    },
    holds: (after) =>
      sum(after.bodies) <= 5 * GiB &&
      sum(after.details) <= GiB &&
      after.bodies.filter((f) => f.open).length === 100,
  },
  {
    id: "pinned old packs beside a 1-second-old pack",
    inventory: () => ({
      now: NOW,
      bodies: [
        ...Array.from({ length: 80 }, (_, i) =>
          pack(`siteA/r0-${i}`, 64 * MiB, 5 * DAY, { pinned: true }),
        ),
        pack("siteB/r1-c0", 100 * MiB, 1_000),
      ],
      details: [],
    }),
    holds: (after, steps) =>
      after.bodies.some((f) => named(f) === "siteB/r1-c0") &&
      steps.some((s) => s.kind === "blocked-by-pin"),
  },
  {
    id: "the age limit deletes old unpinned files only",
    inventory: () => ({
      now: NOW,
      bodies: [
        pack("a/r0-0", MiB, 15 * DAY),
        pack("a/r0-1", MiB, 15 * DAY, { pinned: true }),
        pack("a/r1-0", MiB, DAY),
      ],
      details: [],
    }),
    holds: (after) =>
      JSON.stringify(after.bodies.map(named)) === JSON.stringify(["a/r0-1", "a/r1-0"]),
  },
];

const scenarioFails = (planner: Planner, s: Scenario): boolean => {
  const inventory = s.inventory();
  const steps = planner.planRetention(inventory, DEFAULT_USER_SETTINGS);
  const after = planner.applyRetention(inventory, steps);
  const again = planner
    .planRetention(after, DEFAULT_USER_SETTINGS)
    .filter((x) => x.kind === "delete");
  return !s.holds(after, steps) || again.length > 0;
};

const orderOf = (a: RetentionFile, b: RetentionFile) =>
  a.newestAt - b.newestAt || (named(a) < named(b) ? -1 : 1);

/**
 * The contract over any inventory: no delete touches an open or pinned file; no file newer than a pinned one is
 * deleted for size; once rotations settle, each class is within its cap unless a pin blocks the walk; a second plan
 * deletes nothing. Returns the first broken rule, or null.
 */
function violation(
  planner: Planner,
  start: RetentionInventory,
  settings: UserSettings,
): string | null {
  let inventory = start;
  for (let pass = 0; pass < 200; pass++) {
    const steps = planner.planRetention(inventory, settings);
    for (const [cls, cap] of [
      ["bodies", settings.retention.maxBodyBytes],
      ["details", settings.retention.maxDetailBytes],
    ] as const) {
      const files = inventory[cls];
      const byName = new Map(files.map((f) => [JSON.stringify(f.ref), f]));
      const mine = steps.filter((s) => byName.has(JSON.stringify(s.ref)));
      const deleted = mine
        .filter((s) => s.kind === "delete")
        .map((s) => byName.get(JSON.stringify(s.ref))!);
      if (deleted.some((f) => f.open || f.pinned)) return `${cls}: deleted an open or pinned file`;
      const pinned = files.filter((f) => f.pinned);
      const bySize = mine
        .filter((s) => s.kind === "delete" && s.why === "size")
        .map((s) => byName.get(JSON.stringify(s.ref))!);
      if (bySize.some((d) => pinned.some((p) => orderOf(p, d) < 0)))
        return `${cls}: deleted a file newer than a pinned one`;
      const settled = !steps.some((s) => s.kind === "rotate");
      const after = planner.applyRetention(inventory, steps)[cls];
      if (settled && sum(after) > cap && !mine.some((s) => s.kind === "blocked-by-pin"))
        return `${cls}: ${sum(after)} bytes over a cap of ${cap}`;
    }
    const after = planner.applyRetention(inventory, steps);
    if (!steps.some((s) => s.kind === "rotate")) {
      return planner.planRetention(after, settings).some((s) => s.kind === "delete")
        ? "a second plan deletes again"
        : null;
    }
    inventory = after;
  }
  return "rotations never settled";
}

function generated(seed: number): {
  readonly inventory: RetentionInventory;
  readonly settings: UserSettings;
} {
  const r = random(seed);
  const make = (kind: "pack" | "segment", count: number, scale: number) =>
    Array.from({ length: count }, (_, i) => {
      const extra = { open: r.chance(0.12), pinned: r.chance(0.12) };
      const name = `site${r.int(5)}/r${r.int(3)}-${i}`;
      const age = r.chance(0.2) ? r.int(30) * DAY : r.int(DAY);
      return kind === "pack"
        ? pack(name, 1 + r.int(scale), age, extra)
        : segment(name, 1 + r.int(scale), age, extra);
    });
  const bodies = make("pack", r.int(60), 8 * MiB);
  const details = make("segment", r.int(60), 2 * MiB);
  const settings: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    retention: {
      maxBodyBytes: r.int(sum(bodies) + 1) as ByteCount,
      maxDetailBytes: r.int(sum(details) + 1) as ByteCount,
      maxAgeDays: 1 + r.int(20),
    },
  };
  return { inventory: { now: NOW, bodies, details }, settings };
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const firstGeneratedFailure = (planner: Planner): string | null => {
  for (const seed of SEEDS) {
    const { inventory, settings } = generated(seed);
    const broken = violation(planner, inventory, settings);
    if (broken !== null) return `seed ${seed}: ${broken}`;
  }
  return null;
};

const BROKEN_RULES: readonly SourceChange[] = [
  {
    id: "skip-past-pins",
    from: 'steps.push({ kind: "blocked-by-pin", ref: f.ref, overBy: (total - cap) as ByteCount });\n      break;',
    to: "continue;",
  },
  {
    id: "open-files-not-counted",
    from: "let total = sorted.reduce((sum, f) => sum + f.bytes, 0);",
    to: "let total = sorted.filter((f) => !f.open).reduce((sum, f) => sum + f.bytes, 0);",
  },
  {
    id: "age-ignores-pins",
    from: "if (!f.open && !f.pinned && now - f.newestAt",
    to: "if (!f.open && now - f.newestAt",
  },
];

describe("planRetention", () => {
  it.each(SCENARIOS)("$id", (s) => {
    expect(scenarioFails(retention, s)).toBe(false);
  });

  it("never exceeds its caps and a pin never causes newer data to be deleted first, over generated inventories", () => {
    expect(firstGeneratedFailure(retention)).toBeNull();
  });

  it.each(BROKEN_RULES)("with $id, a scenario and the generated check fail", async (m) => {
    const planner = await importAltered<Planner>("retention.ts", m);
    expect(SCENARIOS.some((s) => scenarioFails(planner, s))).toBe(true);
    expect(firstGeneratedFailure(planner)).not.toBeNull();
  });
});
