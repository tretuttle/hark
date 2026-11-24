// Checks an exported HAR against the fixture servers' own record of what they sent: every entry's body must hash to
// the server's decoded SHA-256 for its X-Seq, and the entries must be exactly the requests the servers logged. The
// extension's own reader is never the reference.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as HarValidator from "har-validator";
import type { FixtureServer } from "./server.ts";

/** One fixture server as the export check sees it: the host its URLs use, and its record of what it sent. */
export type TruthServer = {
  readonly host: string;
  readonly server: Pick<FixtureServer, "getSequenceTruth" | "getRequestLog">;
};

type Entry = {
  readonly request: { readonly url: string };
  readonly response: {
    readonly status: number;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly content: { readonly size: number; readonly text?: string; readonly encoding?: string };
  };
  readonly _harExport?: { readonly bodyState?: string; readonly reason?: string };
};

type Document = {
  readonly log: {
    readonly entries: readonly Entry[];
    readonly pages: readonly { readonly title: string }[];
  };
};

export type ExportExpectation = {
  readonly servers: readonly TruthServer[];
  /** Hosts whose whole request log must be in the file, and no other server's requests. */
  readonly hosts: readonly string[];
  /** What the popup said this preset would export. */
  readonly previewCount: number;
  /** Text put in the navigation URL; it may appear nowhere in the file. */
  readonly secret: string;
};

export type ExportVerdict = {
  readonly entries: number;
  readonly exact: number;
  readonly problems: readonly string[];
};

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const bodyBytes = (content: Entry["response"]["content"]): Buffer | null => {
  if (content.text === undefined) return null;
  return content.encoding === "base64"
    ? Buffer.from(content.text, "base64")
    : Buffer.from(content.text, "utf8");
};

const seqOf = (entry: Entry): number =>
  Number(entry.response.headers.find((h) => h.name.toLowerCase() === "x-seq")?.value);

export function checkExport(text: string, expected: ExportExpectation): ExportVerdict {
  const problems: string[] = [];
  let document: Document;
  try {
    document = JSON.parse(text) as Document;
  } catch (error) {
    return { entries: 0, exact: 0, problems: [`not JSON: ${String(error)}`] };
  }
  const { entries, pages } = document.log;
  if (text.includes(expected.secret)) {
    const at = text.indexOf(expected.secret);
    problems.push(`the secret is in the file: ...${text.slice(Math.max(0, at - 80), at)}`);
  }
  if (entries.length > 0 && pages.length === 0) problems.push("entries but no log.pages");
  if (entries.length !== expected.previewCount)
    problems.push(
      `${String(entries.length)} entries, the popup said ${String(expected.previewCount)}`,
    );

  const seen = new Set<string>();
  let exact = 0;
  for (const entry of entries) {
    const host = new URL(entry.request.url).host;
    const server = expected.servers.find((s) => s.host === host);
    const seq = seqOf(entry);
    const key = `${host}#${String(seq)}`;
    if (server === undefined || !expected.hosts.includes(host)) {
      problems.push(`unexpected entry ${entry.request.url}`);
      continue;
    }
    const truth = server.server.getSequenceTruth(seq);
    if (truth === undefined) {
      problems.push(`${entry.request.url}: no server record for X-Seq ${String(seq)}`);
      continue;
    }
    if (seen.has(key)) problems.push(`${key} exported twice`);
    seen.add(key);
    const { content } = entry.response;
    const bytes = bodyBytes(content);
    const wanted = truth.decodedLength ?? 0;
    if (bytes === null && wanted > 0) {
      problems.push(
        `${truth.path} #${String(seq)}: body missing (${JSON.stringify(entry._harExport ?? null)})`,
      );
      continue;
    }
    const got = bytes ?? Buffer.alloc(0);
    if (wanted > 0 && sha256(got) !== truth.decodedSha256)
      problems.push(`${truth.path} #${String(seq)}: wrong body bytes`);
    else if (content.size !== wanted || got.length !== wanted)
      problems.push(
        `${truth.path} #${String(seq)}: content.size ${String(content.size)}, ${String(got.length)} bytes, server sent ${String(wanted)} decoded`,
      );
    else exact += 1;
  }
  for (const host of expected.hosts) {
    const server = expected.servers.find((s) => s.host === host);
    for (const served of server?.server.getRequestLog() ?? []) {
      if (!seen.has(`${host}#${String(served.seq)}`))
        problems.push(`missing ${served.method} ${host}${served.url} #${String(served.seq)}`);
    }
  }
  return { entries: entries.length, exact, problems };
}

/** har-validator 5.1.5's verdict: null when valid, else its first errors. */
export async function validateHar(text: string): Promise<string | null> {
  try {
    await HarValidator.har(JSON.parse(text));
    return null;
  } catch (error) {
    const errors = (error as { errors?: unknown }).errors;
    return JSON.stringify(errors ?? String(error)).slice(0, 400);
  }
}

const require = NodeModule.createRequire(import.meta.url);

/**
 * har-to-k6 0.13.0 on a file. It exits 0 even when it rejects the file and writes nothing, so the result is whether
 * the output file exists and is not empty.
 */
export function convertsWithK6(harFile: string, workDir: string): boolean {
  const bin = NodePath.join(
    NodePath.dirname(require.resolve("har-to-k6/package.json")),
    "bin",
    "har-to-k6.js",
  );
  const out = NodePath.join(workDir, `${NodePath.basename(harFile)}.k6.js`);
  NodeChildProcess.spawnSync(process.execPath, [bin, harFile, "-o", out], { stdio: "ignore" });
  const ok = NodeFS.existsSync(out) && NodeFS.statSync(out).size > 0;
  NodeFS.rmSync(out, { force: true });
  return ok;
}

/** Deliberately broken copies of an export: `checkExport` reports each one. */
export const EXPORT_FAULTS: readonly {
  readonly name: string;
  readonly alter: (document: Document) => Document;
}[] = [
  {
    name: "a flipped byte in one body",
    alter: (doc) => {
      const index = doc.log.entries.findIndex((e) => (e.response.content.text ?? "").length > 0);
      return withEntry(doc, index, (entry) => {
        const bytes = bodyBytes(entry.response.content) ?? Buffer.alloc(1);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        const content = {
          ...entry.response.content,
          text: bytes.toString("base64"),
          encoding: "base64",
        };
        return { ...entry, response: { ...entry.response, content } };
      });
    },
  },
  {
    name: "one entry left out",
    alter: (doc) => ({ log: { ...doc.log, entries: doc.log.entries.slice(1) } }),
  },
  {
    name: "a gzip body's size written as its wire size",
    alter: (doc) => {
      const index = doc.log.entries.findIndex((e) => e.request.url.includes("/fixtures/gzip"));
      return withEntry(doc, index, (entry) => {
        const wire = entry.response.headers.find((h) => h.name.toLowerCase() === "content-length");
        const content = { ...entry.response.content, size: Number(wire?.value ?? -1) };
        return { ...entry, response: { ...entry.response, content } };
      });
    },
  },
];

const withEntry = (doc: Document, index: number, change: (entry: Entry) => Entry): Document => {
  if (index < 0) throw new Error("no entry to change");
  return {
    log: {
      ...doc.log,
      entries: doc.log.entries.map((entry, i) => (i === index ? change(entry) : entry)),
    },
  };
};

/** The secret back in a page title, where a redaction that missed titles would leave it. */
export const withSecretInTitle = (text: string, secret: string): string => {
  const doc = JSON.parse(text) as Document;
  const pages = doc.log.pages.map((page, i) =>
    i === 0 ? { ...page, title: `${page.title}&s=${secret}` } : page,
  );
  return JSON.stringify({ log: { ...doc.log, pages } });
};

/** A data: row, which har-to-k6 rejects with the whole file while exiting 0. */
export const withDataRow = (text: string): string => {
  const doc = JSON.parse(text) as Document;
  const first = doc.log.entries[0];
  if (first === undefined) throw new Error("no entry to copy");
  const row = { ...first, request: { ...first.request, url: "data:text/plain,x" } };
  return JSON.stringify({ log: { ...doc.log, entries: [...doc.log.entries, row] } });
};

/** A document har-validator must refuse: the log without its creator. */
export const withoutCreator = (text: string): string => {
  const { log } = JSON.parse(text) as { log: Record<string, unknown> };
  const { creator: _creator, ...rest } = log;
  return JSON.stringify({ log: rest });
};

/** One API call a page can make with a tab id, and whether it must come back as a state or as a refusal. */
export type TabCase = {
  readonly name: string;
  readonly expect: "state" | "refused";
  /** For a state: the field the answer must carry, as JSON. */
  readonly state?: { readonly read: (value: unknown) => unknown; readonly equals: unknown };
};

export type TabObservation = {
  readonly case: TabCase;
  readonly called:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: string };
};

/** A tab id that names no tab is a state, never an error; a negative id is refused by the parser or schema. */
export function checkTabCases(observations: readonly TabObservation[]): readonly string[] {
  const problems: string[] = [];
  for (const { case: c, called } of observations) {
    if (c.expect === "refused") {
      if (called.ok)
        problems.push(`${c.name}: answered ${JSON.stringify(called.value)}, expected a refusal`);
      continue;
    }
    if (!called.ok) {
      problems.push(`${c.name}: threw ${called.error}`);
      continue;
    }
    const got = c.state === undefined ? undefined : c.state.read(called.value);
    if (c.state !== undefined && JSON.stringify(got) !== JSON.stringify(c.state.equals))
      problems.push(
        `${c.name}: ${JSON.stringify(got)}, expected ${JSON.stringify(c.state.equals)}`,
      );
  }
  return problems;
}

const MIB = 1_048_576;
/** One body chunk (3 MiB) as base64 is 4 MiB; the sink may still hold one batch of 1 MiB when cancel arrives. */
export const CANCEL_BOUND_BYTES = 4 * MIB + MIB;

export type CancelObservation = {
  readonly state: string;
  readonly audit: {
    readonly bytesAtCancel: number;
    readonly bytesAtStop: number | null;
    readonly keptFile?: string | null;
  } | null;
  /** Files in the export folder named like this export. */
  readonly left: readonly string[];
  readonly journal: string;
  /** Unnamed files the browser still has open in the export folder, once the run stopped. */
  readonly openUnnamed: number;
};

export function checkCancel(o: CancelObservation): readonly string[] {
  const problems: string[] = [];
  if (o.state !== "cancelled") problems.push(`ended ${o.state}, not cancelled`);
  if (o.audit === null || o.audit.bytesAtStop === null) problems.push("no cancel audit");
  else if (o.audit.bytesAtStop - o.audit.bytesAtCancel > CANCEL_BOUND_BYTES)
    problems.push(
      `wrote ${String(o.audit.bytesAtStop - o.audit.bytesAtCancel)} bytes after cancel, more than one chunk (${String(CANCEL_BOUND_BYTES)})`,
    );
  if (o.left.length > 0) problems.push(`left behind: ${o.left.join(", ")}`);
  if ((o.audit?.keptFile ?? null) !== null) problems.push(`kept ${String(o.audit?.keptFile)}`);
  if (o.openUnnamed > 0) problems.push(`${String(o.openUnnamed)} unnamed export file still open`);
  // An unnamed export journals nothing; a named part's start line must be ended.
  const lines = o.journal.split("\n").filter((line) => line.length > 0);
  const startedParts = lines.filter((l) => l.startsWith('{"started"')).length;
  const endedParts = lines.filter((l) => l.startsWith('{"ended"')).length;
  if (startedParts !== endedParts)
    problems.push(
      `journal has ${String(startedParts)} started and ${String(endedParts)} ended lines`,
    );
  return problems;
}

export type AfterCrashObservation = {
  /** The kinds of step the next start's recovery ran. */
  readonly steps: readonly string[];
  /** Files named like the export in its folder, after the next start. */
  readonly left: readonly string[];
  /** A named part, which the journal names; an unnamed file leaves nothing to journal. */
  readonly journaled: boolean;
};

/**
 * An export killed mid-write leaves nothing named after the next start. The next start deletes a journaled part; an
 * unnamed file needs no step at all.
 */
export function checkAfterCrash(o: AfterCrashObservation): readonly string[] {
  const deleted = o.steps.includes("delete-export-part");
  return [
    ...(deleted === o.journaled
      ? []
      : [
          `recovery ran ${JSON.stringify(o.steps)}, ${o.journaled ? "no" : "a"} delete-export-part`,
        ]),
    ...(o.left.length === 0 ? [] : [`left after the next start: ${o.left.join(", ")}`]),
  ];
}

/** How one cause must end: a named failure kind, done under a given name, or cancelled. */
export type RowOutcome =
  | { readonly kind: "write-failed"; readonly failure: string; readonly unconfirmed?: true }
  | {
      readonly kind: "done";
      readonly fileName: string;
      /** The route's kind the page must see, and why the parent says it took the named route. */
      readonly route?: "link" | "named";
      readonly because?: string;
    }
  | { readonly kind: "cancelled" };

export type RowObservation = {
  readonly expect: RowOutcome;
  readonly state: unknown;
  /** Everything the API handed the page after the export: the job, listExports and getPopup, serialized. */
  readonly served: string;
  /** The route the parent kept for the export, read through the harness topic. */
  readonly route: unknown;
  /** Folders whose paths may never reach a page: the profile, the export folder, the data home. */
  readonly paths: readonly string[];
  /** Files named like this export, in the export folder and the profile, after it ended. */
  readonly files: readonly string[];
  /** Files outside the export folder that an attack pointed at, hashed before and after. */
  readonly untouched: readonly {
    readonly path: string;
    readonly before: string;
    readonly after: string;
  }[];
  /** `exports.jsonl` after the export ended. */
  readonly journal: string;
  /** Paths the row put in place before the export started, so never the export's: no journal line may name one. */
  readonly theirs: readonly string[];
  /** How long the export took to end after the row's held call was let go or its cancel was asked, and the limit. */
  readonly timing: { readonly tookMs: number; readonly withinMs: number } | null;
  /** Files under the profile and the archive that are new or changed, except the row's own, and whether each holds export bytes. */
  readonly outside: readonly { readonly path: string; readonly exportBytes: boolean }[];
  /**
   * A finished export's file, read back from the folder: its length, its SHA-256, and what the fixtures check found
   * wrong in it, every fixture body against its pinned SHA-256. null when there is no file to read.
   */
  readonly written: FileRead | null;
  /** The unnamed file while the link waited, read through /proc/<pid>/fd from outside; null where there was none. */
  readonly source: { readonly bytes: number; readonly sha256: string } | null;
};

export type FileRead = {
  readonly bytes: number;
  readonly sha256: string;
  readonly fixtures: readonly string[];
};

/** Parts the journal says started and never ended: what the next start would act on. */
function openJournalEntries(journal: string): readonly string[] {
  const open = new Set<string>();
  for (const line of journal.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { started?: unknown; ended?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      open.add(`unreadable line ${line}`);
      continue;
    }
    if (typeof entry.started === "string") open.add(entry.started);
    if (typeof entry.ended === "string") open.delete(entry.ended);
  }
  return [...open];
}

const FAILURE_KEYS: readonly string[] = ["kind", "needBytes", "freeBytes"];

/**
 * A cause ends as its row says. A failure is a named kind and numbers, never `other`, and leaves no file; a finished
 * export leaves exactly its file. No path or URL holding one reaches the page, and nothing outside the folder changed.
 */
export function checkRow(o: RowObservation): readonly string[] {
  const problems: string[] = [];
  const state = o.state as {
    kind?: string;
    fileName?: string;
    failure?: Record<string, unknown>;
    route?: unknown;
    unconfirmed?: unknown;
  };
  const kept = (o.route ?? {}) as { route?: unknown; because?: unknown };
  const failure = state.failure ?? {};
  if (o.timing !== null && o.timing.tookMs > o.timing.withinMs)
    problems.push(
      `ended ${String(o.timing.tookMs)} ms after the row let it go, more than ${String(o.timing.withinMs)}`,
    );
  if (o.expect.kind === "cancelled") {
    if (state.kind !== "cancelled")
      problems.push(`ended ${JSON.stringify(o.state)}, expected cancelled`);
    if (o.files.length > 0) problems.push(`left behind: ${o.files.join(", ")}`);
  } else if (o.expect.kind === "write-failed") {
    if (state.kind !== "write-failed" || failure["kind"] !== o.expect.failure)
      problems.push(`ended ${JSON.stringify(o.state)}, expected write-failed ${o.expect.failure}`);
    if (state.unconfirmed !== o.expect.unconfirmed)
      problems.push(
        `unconfirmed ${String(state.unconfirmed)}, expected ${String(o.expect.unconfirmed)}`,
      );
    if (
      failure["kind"] === "disk-full" &&
      !(Number(failure["freeBytes"]) < Number(failure["needBytes"]))
    )
      problems.push(`disk-full without a need above the free bytes: ${JSON.stringify(failure)}`);
    if (o.files.length > 0) problems.push(`left behind: ${o.files.join(", ")}`);
  } else {
    if (state.kind !== "done" || state.fileName !== o.expect.fileName)
      problems.push(`ended ${JSON.stringify(o.state)}, expected done as ${o.expect.fileName}`);
    if (o.files.join() !== o.expect.fileName) problems.push(`files: ${o.files.join(", ")}`);
    if (
      o.expect.route !== undefined &&
      (state.route !== o.expect.route || kept.route !== o.expect.route)
    )
      problems.push(
        `route ${String(state.route)} on the page and ${JSON.stringify(o.route)} kept, expected ${o.expect.route}`,
      );
    if (o.expect.because !== undefined && kept.because !== o.expect.because)
      problems.push(
        `took the named route because ${String(kept.because)}, expected ${o.expect.because}`,
      );
    // Done is a claim about the file's bytes: the fixture's bodies, and the unnamed file's when there was one.
    if (o.written === null) problems.push("the finished file could not be read back");
    else {
      problems.push(...o.written.fixtures.map((problem) => `the finished file: ${problem}`));
      if (
        o.source !== null &&
        (o.source.bytes !== o.written.bytes || o.source.sha256 !== o.written.sha256)
      )
        problems.push(
          `the finished file (${String(o.written.bytes)} bytes, ${o.written.sha256.slice(0, 12)}) is not the unnamed file (${String(o.source.bytes)} bytes, ${o.source.sha256.slice(0, 12)})`,
        );
    }
  }
  if (state.route !== undefined && state.route !== "link" && state.route !== "named")
    problems.push(`the page's route is ${JSON.stringify(state.route)}, not a route's kind`);
  // Why a route was taken stays in the parent: no field of it reaches a page.
  for (const key of ['"because"', '"errno"'])
    if (o.served.includes(key)) problems.push(`${key} reached the page`);
  const extra = Object.keys(failure).filter((key) => !FAILURE_KEYS.includes(key));
  if (extra.length > 0) problems.push(`the failure carries ${extra.join(", ")}`);
  for (const path of o.paths)
    if (o.served.includes(path)) problems.push(`a path reached the page: ${path}`);
  // URLs that hold a local path. The bare word "jar:" is in the redaction report's own description.
  for (const scheme of ["file://", "jar:file:"])
    if (o.served.includes(scheme)) problems.push(`a ${scheme} URL reached the page`);
  for (const file of o.untouched)
    if (file.before !== file.after) problems.push(`${file.path} changed`);
  for (const file of o.outside)
    if (file.exportBytes) problems.push(`${file.path}, outside the folder, holds export bytes`);
  for (const path of openJournalEntries(o.journal))
    problems.push(`the journal leaves ${path} open`);
  for (const path of o.theirs)
    if (o.journal.includes(JSON.stringify(path)))
      problems.push(`the journal names ${path}, not the export's`);
  return problems;
}

/** Every file present before the row, and every file the row put in place, is as it was after the next start. */
export function checkNextStart(
  kept: readonly { readonly path: string; readonly before: string; readonly after: string }[],
): readonly string[] {
  return kept
    .filter((file) => file.before !== file.after)
    .map((file) => `${file.path} was ${file.before}, after the next start ${file.after}`);
}
