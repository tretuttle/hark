import { describe, expect, it } from "vite-plus/test";

import type { ByteCount, RunId, Site } from "../src/ids.ts";
import {
  LAYOUT,
  logSegmentPath,
  logSummaryPath,
  parseArchiveName,
  siteDirName,
} from "../src/layout.ts";
import { decodeSummary } from "../src/log.ts";
import * as reconcile from "../src/reconcile.ts";
import {
  cloneDisk,
  cloneCommitted,
  Crash,
  emptyDisk,
  emptyCommitted,
  excludedOn,
  execute,
  Run,
  snapshotOf,
  Steps,
  wholeLines,
  type Disk,
  type Committed,
} from "./archive-model.ts";
import { CRASH_ROWS } from "./crash-rows.ts";
import { importAltered, type SourceChange } from "./alter.ts";
import { generatedSites } from "./generated-sites.ts";
import { random } from "./random.ts";

type Planner = Pick<typeof reconcile, "planReconcile" | "applyPlan">;

const crashRowsFailing = (planner: Planner): readonly number[] =>
  CRASH_ROWS.filter((row) => {
    const plan = planner.planReconcile(row.snapshot);
    const again = planner.planReconcile(planner.applyPlan(row.snapshot, plan));
    return JSON.stringify(plan.map((s) => s.kind)) !== JSON.stringify(row.plan) || again.length > 0;
  }).map((row) => row.n);

// Changes that each break one rule of the planner.
const BROKEN_RULES: readonly SourceChange[] = [
  {
    id: "no-invalid-summary-step",
    from: "if (!e.valid) steps.push(",
    to: "if (false) steps.push(",
  },
  {
    id: "summary-presence-means-summarized",
    from: "summaries.filter((e) => e.valid).map",
    to: "summaries.map",
  },
  {
    id: "summarize-before-truncate",
    from: "  for (const e of oldUnsummarized) {\n    if (e.validBytes < e.bytes)",
    to: '  for (const e of oldUnsummarized) steps.push({ kind: "summarize-log", segment: e.name.segment });\n  for (const e of oldUnsummarized) {\n    if (e.validBytes < e.bytes)',
  },
  {
    id: "deletes-current-run-parts",
    from: 'if (e.name.kind === "part" && isOld(snapshot, e.name.run))',
    to: 'if (e.name.kind === "part")',
  },
  {
    id: "keeps-tmp-files",
    from: 'if (e.name.kind === "tmp" && isOld(snapshot, e.name.of === "summary" ? e.name.run : null))',
    to: "if (false)",
  },
  {
    id: "seal-pack-step-back",
    from: "  for (const { path, at } of snapshot.unfinishedExports) {",
    to: '  for (const e of snapshot.entries) if (e.name.kind === "pack" && isOld(snapshot, e.name.run)) steps.push({ kind: "seal-pack", path: e.path } as never);\n  for (const { path, at } of snapshot.unfinishedExports) {',
  },
  {
    id: "orphan-check-ignores-exclusion",
    from: '  for (const e of live) {\n    if (e.name.kind === "body"',
    to: '  for (const e of snapshot.entries) {\n    if (e.name.kind === "body"',
  },
  {
    id: "summary-check-ignores-exclusion",
    from: "const summaries = live.filter(isSummary);",
    to: "const summaries = snapshot.entries.filter(isSummary);",
  },
];

describe("the crash table", () => {
  it.each(CRASH_ROWS)("row $n, $diedDuring: plans $plan and replans to []", (row) => {
    const plan = reconcile.planReconcile(row.snapshot);
    expect(plan.map((s) => s.kind)).toEqual(row.plan);
    expect(reconcile.planReconcile(reconcile.applyPlan(row.snapshot, plan))).toEqual([]);
  });

  it("a plan lists its steps in RECONCILE_STEPS order", () => {
    const order = Object.keys(reconcile.RECONCILE_STEPS);
    for (const row of CRASH_ROWS) {
      const positions = reconcile.planReconcile(row.snapshot).map((s) => order.indexOf(s.kind));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("row 13 when the part was replaced: leaves someone else's file, and plans nothing where nothing is", () => {
    const row13 = CRASH_ROWS.find((row) => row.n === 13)!;
    const path = "/home/u/Downloads/a.har.part";
    const other = { ...row13.snapshot, unfinishedExports: [{ path, at: "other" as const }] };
    const gone = { ...row13.snapshot, unfinishedExports: [{ path, at: "gone" as const }] };
    expect(reconcile.planReconcile(other)).toEqual([{ kind: "leave-export-part", path }]);
    expect(
      reconcile.planReconcile(reconcile.applyPlan(other, [{ kind: "leave-export-part", path }])),
    ).toEqual([]);
    expect(reconcile.planReconcile(gone)).toEqual([]);
  });

  it.each(BROKEN_RULES)("with $id, at least one row fails", async (m) => {
    expect(crashRowsFailing(await importAltered<Planner>("reconcile.ts", m))).not.toEqual([]);
  });
});

const dirOf = (site: Site) => `${LAYOUT.sitesDir}/${siteDirName(site)}`;
type Random = ReturnType<typeof random>;

/** Seeds per family. HARK_RECOVERY_CASES raises the main family for a long local run; CI keeps the default. */
const CASES = Number(process.env["HARK_RECOVERY_CASES"] ?? 1500);
const EXCLUSION_SEEDS = Math.ceil(CASES / 10);
/** A long local run outlasts the suite's 60-second default, so the generated tests scale theirs with CASES. */
const GENERATED_TIMEOUT = Math.max(60_000, CASES * 20);

/** A plan touches an excluded site only through delete-excluded-site: its files are going, whatever their state. */
function misplanned(plan: readonly reconcile.ReconcileStep[], disk: Disk): string | null {
  const gone = excludedOn(disk).map(dirOf);
  for (const step of plan) {
    if (step.kind === "delete-excluded-site") continue;
    const target = "path" in step ? step.path : logSegmentPath(step.segment).join("/");
    if (gone.some((dir) => target.startsWith(`${dir}/`)))
      return `${step.kind} plans ${"path" in step ? step.path : step.segment}, a file of an excluded site`;
  }
  return null;
}

/**
 * What recovery must leave, checked against the disk and the model's own record, never against the plan: nothing of
 * an excluded site, no old part, tmp file, orphan body or unfinished export; every old segment ends at a line and has
 * a valid summary; this run's files untouched; every committed line of a kept segment, and the body it names, kept.
 */
function broken(
  planner: Planner,
  disk: Disk,
  committed: Committed,
  current: RunId,
  currentPart: string | null,
): string | null {
  const replan = planner.planReconcile(snapshotOf(disk, current));
  if (replan.length > 0)
    return `the second plan is not empty: ${replan.map((s) => s.kind).join(", ")}`;
  const excluded = excludedOn(disk);
  const files = [...disk.files.keys()];
  for (const site of excluded) {
    if (disk.siteDirs.has(dirOf(site)) || files.some((p) => p.startsWith(`${dirOf(site)}/`)))
      return `${site} is excluded but still on disk`;
  }
  if (currentPart !== null && !disk.files.has(currentPart)) return "this run's part was deleted";
  const named = new Set<string>();
  for (const path of files) {
    const name = parseArchiveName(path.split("/"));
    if (name === null) continue;
    if (name.kind === "part" && name.run !== current) return `old part ${path} left`;
    if (name.kind === "tmp") return `tmp ${path} left`;
    if (name.kind === "log") {
      const text = disk.files.get(path) ?? "";
      if (text !== "" && !text.endsWith("\n")) return `${path} ends mid-line`;
      const summary = disk.files.get(logSummaryPath(name.segment).join("/"));
      if (summary === undefined || decodeSummary(summary, text.length as ByteCount) === null)
        return `${path} has no valid summary`;
      for (const line of wholeLines(text).decoded) {
        const { body } = line.exchange.kind === "answered" ? line.exchange : { body: null };
        if (body?.kind === "stored" && body.at.kind === "file")
          named.add(`${dirOf(body.at.site)}/bodies/${body.at.id}.body`);
      }
    }
    if (name.kind === "summary" && !disk.files.has(logSegmentPath(name.segment).join("/")))
      return `summary ${path} has no segment`;
  }
  for (const path of files)
    if (parseArchiveName(path.split("/"))?.kind === "body" && !named.has(path))
      return `orphan body ${path} left`;
  if (
    disk.journal.size > 0 ||
    [...disk.exports].some((p) => p.endsWith(".part") && committed.journaled.has(p))
  )
    return "an unfinished export is left";
  for (const path of committed.theirs)
    if (!disk.theirs.has(path)) return `someone else's file at ${path} was deleted`;
  const gone = (path: string) =>
    committed.retained.has(path) || excluded.some((site) => path.startsWith(`${dirOf(site)}/`));
  for (const [path, lines] of committed.lines) {
    if (!gone(path) && disk.files.get(path) !== lines.join(""))
      return `committed lines of ${path} changed`;
  }
  for (const [body, segment] of committed.namedBodies) {
    if (!gone(segment) && !gone(body) && !disk.files.has(body))
      return `body ${body} of a committed line was deleted`;
  }
  return null;
}

/** Recovery at the start of `current`, interrupted part way at random, then run again to the end. */
function recover(planner: Planner, disk: Disk, current: RunId, r: Random): string | null {
  const first = planner.planReconcile(snapshotOf(disk, current));
  const wrong = misplanned(first, disk);
  if (wrong !== null) return wrong;
  try {
    execute(
      disk,
      first,
      new Steps(
        r.chance(0.4) ? r.int(8) : Number.POSITIVE_INFINITY,
        r.chance(0.5) ? r.int(1000) / 1000 : null,
      ),
      r,
    );
    disk.journal.clear();
    return null;
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
  }
  const second = planner.planReconcile(snapshotOf(disk, current));
  execute(disk, second, new Steps(Number.POSITIVE_INFINITY, null), r);
  // As the parent does once recovery ran: every line is now acted on, so the journal is deleted.
  disk.journal.clear();
  return misplanned(second, disk);
}

function liveRun(run: Run, r: Random, actions: number, sites: readonly Site[]): void {
  for (let i = 0; i < actions; i++) {
    const live = sites.filter((s) => !run.excluded.has(s));
    const site = r.pick(live);
    const roll = r.int(100);
    if (roll < 15) run.startTee(site, 1 + r.int(50));
    else if (roll < 30) run.finishTee(r);
    else if (roll < 50) run.memoryBody(site, 1 + r.int(40));
    else if (roll < 65) run.plainLine(site, r.pick(["answered", "unanswered"]));
    else if (roll < 75) run.seal(site);
    else if (roll < 79) run.touchSettings();
    else if (roll < 83 && live.length > 1) run.exclude(site, r);
    else if (roll < 90) run.exportFile(r.chance(0.3));
    else run.retain(r);
  }
  run.quit(sites);
}

/** Three runs over generated sites, each ending in a crash at a random step (sometimes torn) or a clean quit. */
function generatedCase(planner: Planner, seed: number): string | null {
  const r = random(seed);
  const sites = generatedSites(r, 2 + r.int(3));
  const disk = emptyDisk();
  const committed = emptyCommitted();
  for (let n = 1; n <= 3; n++) {
    const run = new Run(
      `r${n}` as RunId,
      disk,
      committed,
      new Steps(
        r.chance(0.8) ? r.int(120) : Number.POSITIVE_INFINITY,
        r.chance(0.5) ? r.int(1000) / 1000 : null,
      ),
    );
    try {
      liveRun(run, r, 5 + r.int(40), sites);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
    const summaries = [...disk.files.keys()].filter(
      (p) => parseArchiveName(p.split("/"))?.kind === "summary",
    );
    if (summaries.length > 0 && r.chance(0.25)) {
      const lost = r.pick(summaries);
      disk.files.set(lost, "\0".repeat(disk.files.get(lost)?.length ?? 0));
    }
    const next = `r${n + 1}` as RunId;
    const currentPart = r.chance(0.3) ? `${LAYOUT.incomingDir}/${next}.1.part` : null;
    if (currentPart !== null) disk.files.set(currentPart, "early");
    const problem =
      recover(planner, disk, next, r) ?? broken(planner, disk, committed, next, currentPart);
    if (problem !== null)
      return `seed ${seed}, after run ${n}, sites ${sites.join(" ")}: ${problem}`;
    if (currentPart !== null) disk.files.delete(currentPart);
  }
  return null;
}

/**
 * One recorded run over generated sites, then an exclusion stopped before each of its steps in turn (settings .tmp,
 * rename, every file of the site in a random order, the directory), each followed by recovery.
 */
function exclusionCases(
  planner: Planner,
  seed: number,
): { readonly cases: number; readonly problem: string | null } {
  const r = random(seed);
  const sites = generatedSites(r, 2 + r.int(3));
  const disk = emptyDisk();
  const committed = emptyCommitted();
  const first = new Run("r1" as RunId, disk, committed, new Steps(Number.POSITIVE_INFINITY, null));
  liveRun(first, r, 10 + r.int(40), sites);
  const victim = r.pick(sites);
  const probe = new Steps(Number.POSITIVE_INFINITY, null);
  new Run("r2" as RunId, cloneDisk(disk), cloneCommitted(committed), probe).exclude(victim, r);
  for (let at = 0; at <= probe.taken; at++) {
    const order = random(seed * 1_000 + at);
    const d = cloneDisk(disk);
    const t = cloneCommitted(committed);
    const tear = order.chance(0.5) ? order.int(1000) / 1000 : null;
    try {
      new Run("r2" as RunId, d, t, new Steps(at, tear)).exclude(victim, order);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
    const problem =
      recover(planner, d, "r3" as RunId, order) ?? broken(planner, d, t, "r3" as RunId, null);
    if (problem !== null)
      return {
        cases: at + 1,
        problem: `seed ${seed}, exclusion of ${victim} stopped before step ${at} of ${probe.taken}: ${problem}`,
      };
  }
  return { cases: probe.taken + 1, problem: null };
}

const firstFailure = (planner: Planner, seeds: number): string | null => {
  for (let seed = 1; seed <= seeds; seed++) {
    const problem = generatedCase(planner, seed);
    if (problem !== null) return problem;
  }
  return null;
};

describe("recovery after generated crashes", () => {
  it(
    `over ${CASES} generated cases, plan, apply, plan again is always empty, and no committed line or the body it names is lost`,
    () => {
      expect(firstFailure(reconcile, CASES)).toBeNull();
    },
    GENERATED_TIMEOUT,
  );

  it(
    `over ${EXCLUSION_SEEDS} generated archives, an exclusion stopped before any one of its steps recovers`,
    () => {
      let cases = 0;
      for (let seed = 1; seed <= EXCLUSION_SEEDS; seed++) {
        const result = exclusionCases(reconcile, seed);
        expect(result.problem).toBeNull();
        cases += result.cases;
      }
      console.info(`exclusion cases: ${cases} interrupt points over ${EXCLUSION_SEEDS} archives`);
    },
    GENERATED_TIMEOUT,
  );

  // leave-export-part changes nothing on disk; the replaced row 13 test above holds it.
  it.each(Object.keys(reconcile.RECONCILE_STEPS).filter((kind) => kind !== "leave-export-part"))(
    "without the %s rule a generated crash is left unrecovered",
    async (kind) => {
      const planner = await importAltered<Planner>("reconcile.ts", {
        id: `no-${kind}`,
        from: `steps.push({ kind: "${kind}"`,
        to: `void ({ kind: "${kind}"`,
      });
      expect(firstFailure(planner, CASES)).not.toBeNull();
    },
  );
});
