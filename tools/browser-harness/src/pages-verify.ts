// Checks what the history and options pages did, from observations taken outside the page: the server's request
// log and per-sequence SHA-256, files on disk, and the page's own DOM. Each returns its problems; an empty list means
// the behaviour held.

import * as NodeCrypto from "node:crypto";
import type { TruthServer } from "./export-verify.ts";

export type EmptySelection = {
  /** The "Export as one file" button with nothing ticked. */
  readonly buttonDisabled: boolean;
  readonly jobsBefore: number;
  /** After a click on that button. */
  readonly jobsAfter: number;
  /** startExport called with an empty session list, as a page that skipped its own check would. */
  readonly apiRefused: boolean;
};

export function checkEmptySelection(o: EmptySelection): string[] {
  const problems: string[] = [];
  if (!o.buttonDisabled) problems.push("the export button is enabled with nothing ticked");
  if (o.jobsAfter !== o.jobsBefore)
    problems.push(
      `a click with nothing ticked started ${String(o.jobsAfter - o.jobsBefore)} export(s)`,
    );
  if (!o.apiRefused) problems.push("startExport accepted an empty session list");
  return problems;
}

/** What the page and the disk show at one moment of an exclusion. */
export type ExclusionMoment = {
  /** Confirmations on screen. */
  readonly prompts: number;
  readonly onDisk: boolean;
  /** In listSites. */
  readonly listed: boolean;
};

export type Exclusion = {
  /** After the first click on Exclude site. */
  readonly asked: ExclusionMoment;
  /** After Cancel: the ask must have guarded the data. */
  readonly cancelled: ExclusionMoment;
  /** After Exclude site again and its one confirmation. */
  readonly confirmed: ExclusionMoment & { readonly inSettings: boolean };
  /** After the site was visited again. */
  readonly revisited: Pick<ExclusionMoment, "onDisk" | "listed">;
};

export function checkExclusion(site: string, o: Exclusion): string[] {
  const problems: string[] = [];
  if (o.asked.prompts !== 1)
    problems.push(`${site}: asked ${String(o.asked.prompts)} times, not once`);
  if (!o.asked.onDisk || !o.asked.listed)
    problems.push(`${site}: data was deleted before the user confirmed`);
  if (o.cancelled.prompts !== 0) problems.push(`${site}: the question stayed after Cancel`);
  if (!o.cancelled.onDisk || !o.cancelled.listed)
    problems.push(`${site}: Cancel did not keep the data`);
  if (o.confirmed.prompts !== 0) problems.push(`${site}: asked again after the confirmation`);
  if (o.confirmed.onDisk) problems.push(`${site}: its data is still on disk`);
  if (o.confirmed.listed) problems.push(`${site}: still listed in history`);
  if (!o.confirmed.inSettings) problems.push(`${site}: not in the excluded sites`);
  if (o.revisited.onDisk || o.revisited.listed)
    problems.push(`${site}: recorded again after it was excluded`);
  return problems;
}

/** A control name that would turn the recording off, pause it, or switch it. */
const RECORDING_SWITCH =
  /\b(pause|stop|turn off|turn on|disable|enable|resume|start)\b.{0,20}\brecord|\brecord\w*\b.{0,20}\b(off|on|pause|stop)\b/iu;

export type StatusBlock = {
  readonly text: string;
  /** Accessible names of every control on the page. */
  readonly controls: readonly string[];
};

export function checkStatusBlock(o: StatusBlock): string[] {
  const problems: string[] = [];
  if (!/recording runs whenever the browser is open and cannot be turned off/iu.test(o.text))
    problems.push(`the status block does not say recording cannot be turned off: "${o.text}"`);
  for (const name of o.controls)
    if (RECORDING_SWITCH.test(name)) problems.push(`a control can switch the recording: "${name}"`);
  return problems;
}

/** The settings a user changed, as one flat record so a page reading and settings.json compare field by field. */
export type SettingsReading = {
  readonly maxBodyBytes: number;
  readonly maxAgeDays: number;
  readonly media: string;
  readonly secretStorage: string;
  readonly bodies: string;
  readonly secrets: string;
  readonly excludedSites: readonly string[];
};

export function compareSettings(
  where: string,
  expected: SettingsReading,
  actual: SettingsReading | null,
): string[] {
  if (actual === null) return [`${where}: no settings`];
  return (Object.keys(expected) as (keyof SettingsReading)[])
    .filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
    .map(
      (key) =>
        `${where}: ${key} is ${JSON.stringify(actual[key])}, set to ${JSON.stringify(expected[key])}`,
    );
}

/** settings.json as the parent wrote it, read with no code of the product. */
export function settingsOnDisk(text: string | null): SettingsReading | null {
  if (text === null) return null;
  const raw = JSON.parse(text) as {
    readonly user: {
      readonly retention: { readonly maxBodyBytes: number; readonly maxAgeDays: number };
      readonly media: string;
      readonly secretStorage: string;
      readonly exportDefaults: { readonly bodies: string; readonly secrets: string };
      readonly excludedSites: readonly string[];
    };
  };
  return {
    maxBodyBytes: raw.user.retention.maxBodyBytes,
    maxAgeDays: raw.user.retention.maxAgeDays,
    media: raw.user.media,
    secretStorage: raw.user.secretStorage,
    bodies: raw.user.exportDefaults.bodies,
    secrets: raw.user.exportDefaults.secrets,
    excludedSites: [...raw.user.excludedSites].sort(),
  };
}

export type FolderChoice = {
  /** The refusal the page shows, or null. */
  readonly shown: string | null;
  /** exportFolder in settings.json after the choice. */
  readonly saved: { readonly kind: string; readonly path?: string } | null;
};

/** A folder inside the profile is refused with a reason that names the profile, and nothing is saved. */
export function checkFolderRefused(o: FolderChoice, before: FolderChoice["saved"]): string[] {
  const problems: string[] = [];
  if (o.shown === null) problems.push("no refusal was shown for a folder inside the profile");
  else if (!/profile/iu.test(o.shown)) problems.push(`the refusal gives no reason: "${o.shown}"`);
  if (JSON.stringify(o.saved) !== JSON.stringify(before))
    problems.push(`the refused folder was saved: ${JSON.stringify(o.saved)}`);
  return problems;
}

/** Where a popup problem row's link landed. */
export type ProblemLink = {
  readonly section: string;
  /** The opened tab's URL fragment. */
  readonly hash: string | null;
  readonly found: boolean;
  /** Its top is inside the viewport, so the user sees it without scrolling. */
  readonly inView: boolean;
  readonly text: string;
};

export function checkProblemLink(o: ProblemLink): string[] {
  const problems: string[] = [];
  if (o.hash !== `#${o.section}`) problems.push(`${o.section}: the link opened ${String(o.hash)}`);
  if (!o.found) problems.push(`${o.section}: the settings page has no such section`);
  else {
    if (!o.inView) problems.push(`${o.section}: the section is not scrolled into view`);
    if (!/what you can do/iu.test(o.text))
      problems.push(`${o.section}: the section does not say what the user can do`);
    if (o.text.trim().split(/\s+/u).length < 20)
      problems.push(`${o.section}: the section explains nothing: "${o.text}"`);
  }
  return problems;
}

type CapEntry = {
  readonly request: { readonly url: string };
  readonly response: {
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly content: { readonly text?: string; readonly encoding?: string };
  };
  readonly _harExport?: { readonly bodyMissing?: string };
};

export type CapAtStart = {
  readonly cap: number;
  /** Packs and body files on disk after the restart, measured by the harness. */
  readonly bodyBytesOnDisk: number;
  /** The allowance one flush batch may add over the cap. */
  readonly slack: number;
  /** An "everything" export taken after the restart. */
  readonly har: string;
  readonly server: TruthServer;
};

export type CapVerdict = {
  readonly exact: number;
  readonly removed: number;
  readonly problems: string[];
};

/**
 * A lowered cap applied at the next start without losing what an export reads: the archive is under the cap, every
 * request the server logged is still exported, and each body is either byte-exact or reported as removed by the
 * storage limit. Some bodies must be removed, or the cap did nothing; some must be exact, or the cap removed too much.
 */
export function checkCapAtStart(o: CapAtStart): CapVerdict {
  const problems: string[] = [];
  if (o.bodyBytesOnDisk > o.cap + o.slack)
    problems.push(
      `${String(o.bodyBytesOnDisk)} body bytes on disk after the restart, cap ${String(o.cap)}`,
    );
  const entries = (JSON.parse(o.har) as { readonly log: { readonly entries: readonly CapEntry[] } })
    .log.entries;
  const seen = new Set<number>();
  let exact = 0;
  let removed = 0;
  for (const entry of entries) {
    if (new URL(entry.request.url).host !== o.server.host) continue;
    const seq = Number(entry.response.headers.find((h) => h.name.toLowerCase() === "x-seq")?.value);
    seen.add(seq);
    const sent = o.server.server.getSequenceTruth(seq);
    if (sent === undefined) {
      problems.push(`${entry.request.url}: no server record for X-Seq ${String(seq)}`);
      continue;
    }
    const { text, encoding } = entry.response.content;
    if (entry._harExport?.bodyMissing === "removed-by-retention") removed += 1;
    else if ((sent.decodedLength ?? 0) === 0) exact += text === undefined || text === "" ? 1 : 0;
    else if (text === undefined)
      problems.push(
        `${sent.path} #${String(seq)}: body missing, ${JSON.stringify(entry._harExport ?? null)}`,
      );
    else {
      const bytes = Buffer.from(text, encoding === "base64" ? "base64" : "utf8");
      const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (sha === sent.decodedSha256) exact += 1;
      else problems.push(`${sent.path} #${String(seq)}: wrong body bytes`);
    }
  }
  for (const served of o.server.server.getRequestLog())
    if (!seen.has(served.seq))
      problems.push(`lost ${served.method} ${served.url} #${String(served.seq)}`);
  if (removed === 0) problems.push("no body was removed, so the lower cap did not apply");
  if (exact === 0) problems.push("no body is left byte-exact");
  return { exact, removed, problems };
}
