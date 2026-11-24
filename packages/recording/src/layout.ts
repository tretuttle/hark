// Every name under the archive root, and the rule for where the root may be. Nothing else builds an archive path.
// The host joins these names onto the root with PathUtils; this module is pure.

import {
  exchangeId,
  parseExchangeId,
  parseRunId,
  parseSite,
  type ExchangeId,
  type LogSegmentId,
  type PackId,
  type RunId,
  type Site,
  type SiteDir,
} from "./ids.ts";

/** AppConstants.platform values the product runs on. */
export type Platform = "win" | "linux" | "macosx";

/**
 * Where the archive's parent folder comes from. The XDG rule's `fallbackUnder` belongs to the fallback only, so the
 * variable's own value is never extended with .local/share, which would resolve ~/.local/share/.local/share.
 */
export type RootBase =
  | { readonly kind: "dir-key"; readonly key: string; readonly under: readonly string[] }
  | {
      readonly kind: "xdg-data-home";
      readonly env: "XDG_DATA_HOME";
      readonly fallbackKey: "Home";
      readonly fallbackUnder: readonly [".local", "share"];
    };

export interface ArchiveRootRow {
  readonly platform: Platform;
  readonly base: RootBase;
  readonly appFolder: string;
  /** POSIX mode for created directories and files; null on Windows, where the inherited ACL already names the readers. */
  readonly dirMode: number | null;
  readonly fileMode: number | null;
}

export const ARCHIVE_ROOTS: { readonly [P in Platform]: ArchiveRootRow } = {
  win: {
    platform: "win",
    base: { kind: "dir-key", key: "LocalAppData", under: [] },
    appFolder: "Hark",
    dirMode: null,
    fileMode: null,
  },
  macosx: {
    platform: "macosx",
    base: { kind: "dir-key", key: "ULibDir", under: ["Application Support"] },
    appFolder: "Hark",
    dirMode: 0o700,
    fileMode: 0o600,
  },
  linux: {
    platform: "linux",
    base: {
      kind: "xdg-data-home",
      env: "XDG_DATA_HOME",
      fallbackKey: "Home",
      fallbackUnder: [".local", "share"],
    },
    appFolder: "hark",
    dirMode: 0o700,
    fileMode: 0o600,
  },
};

/** XDG_DATA_HOME is used when set and absolute (the XDG spec ignores a relative value), else the fallback. */
export function rootSegments(
  row: ArchiveRootRow,
  env: (name: string) => string | null,
  dirKey: (key: string) => string,
): readonly string[] {
  const { base } = row;
  if (base.kind === "dir-key") return [dirKey(base.key), ...base.under, row.appFolder];
  const value = env(base.env);
  if (value !== null && value.startsWith("/"))
    return [value.replace(/(?<=.)\/+$/, ""), row.appFolder];
  return [dirKey(base.fallbackKey), ...base.fallbackUnder, row.appFolder];
}

declare const safeRoot: unique symbol;
/** A folder that passed guardFolder. The store's open and the export sink take only this brand. */
export type SafeFolder = string & { readonly [safeRoot]: true };

/**
 * Folders no archive or export may sit in or contain. resource:// substitutions cannot be enumerated in Gecko 160,
 * so the host resolves KNOWN_SUBSTITUTIONS with getSubstitution. The profile itself is always forbidden, which
 * covers any substitution that maps a folder inside it, such as an AutoConfig mapping of <profile>/chrome/.
 */
export interface ForbiddenRoots {
  readonly profile: string;
  readonly greDir: string;
  readonly appDir: string;
  readonly substitutions: readonly string[];
}
export const KNOWN_SUBSTITUTIONS: readonly string[] = [
  "gre",
  "app",
  "android",
  "devtools",
  "content-accessible",
];

export type FolderRefusal =
  | { readonly kind: "inside"; readonly forbidden: string }
  | { readonly kind: "contains"; readonly forbidden: string }
  /** A relative folder has no meaning in the parent process, so it is never resolved against a guess. */
  | { readonly kind: "not-absolute" };

interface AbsolutePath {
  readonly root: string;
  readonly segments: readonly string[];
}

const WIN_ROOT = /^(?:[a-z]:|\\\\[^\\]+\\[^\\]+)(?=\\|$)/i;

/** Lexical: `.` and `..` are resolved and repeated separators collapse, so `a/../b` cannot slip past a prefix check. */
function absolutePath(path: string, platform: Platform): AbsolutePath | null {
  const text = platform === "win" ? path.replaceAll("/", "\\") : path;
  const separator = platform === "win" ? "\\" : "/";
  const root =
    platform === "win" ? WIN_ROOT.exec(text)?.[0] : text.startsWith("/") ? "" : undefined;
  if (root === undefined) return null;
  const segments: string[] = [];
  for (const segment of text.slice(root.length).split(separator)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return { root, segments };
}

const isPrefix = (outer: readonly string[], inner: readonly string[]): boolean =>
  outer.length <= inner.length && outer.every((s, i) => s === inner[i]);

/**
 * Refuses a folder inside, or containing, any forbidden root. Case-insensitive on win and macosx, separator-aware.
 * Used for the archive root and every export folder the user chooses, so no export lands where a resource:// URL
 * can read it. The folder it returns is the normalized path it checked.
 */
export function guardFolder(
  candidate: string,
  forbidden: ForbiddenRoots,
  platform: Platform,
):
  | { readonly ok: true; readonly folder: SafeFolder }
  | { readonly ok: false; readonly refusal: FolderRefusal } {
  const folded = (p: AbsolutePath): readonly string[] => {
    const all = [p.root, ...p.segments];
    return platform === "linux" ? all : all.map((s) => s.toLowerCase());
  };
  const path = absolutePath(candidate, platform);
  if (path === null) return { ok: false, refusal: { kind: "not-absolute" } };
  const mine = folded(path);
  for (const root of [
    forbidden.profile,
    forbidden.greDir,
    forbidden.appDir,
    ...forbidden.substitutions,
  ]) {
    const other = absolutePath(root, platform);
    if (other === null) continue;
    const theirs = folded(other);
    if (isPrefix(theirs, mine)) return { ok: false, refusal: { kind: "inside", forbidden: root } };
    if (isPrefix(mine, theirs))
      return { ok: false, refusal: { kind: "contains", forbidden: root } };
  }
  const separator = platform === "win" ? "\\" : "/";
  const joined = `${path.root}${separator}${path.segments.join(separator)}`;
  return { ok: true, folder: joined as SafeFolder };
}

declare const archiveKey: unique symbol;
/**
 * The archive's directory name under the app folder: 128 random bits in lowercase hex, generated once and kept in the
 * profile. A page that can test whether a `file://` path exists cannot guess any path below it.
 */
export type ArchiveKey = string & { readonly [archiveKey]: true };

/** The profile file that keeps the key. Losing it starts a new, empty archive; the old one is left untouched. */
export const ARCHIVE_KEY_FILE = "hark.archive-key";
const ARCHIVE_KEY_BYTES = 16;
const ARCHIVE_KEY_TEXT = /^[0-9a-f]{32}$/;

export function archiveKeyFromBytes(bytes: Uint8Array): ArchiveKey {
  if (bytes.length !== ARCHIVE_KEY_BYTES)
    throw new RangeError(`an archive key is ${String(ARCHIVE_KEY_BYTES)} random bytes`);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") as ArchiveKey;
}

/** The key file's text, one trailing newline allowed. Anything else is null, and the host makes a new key. */
export function parseArchiveKey(raw: string): ArchiveKey | null {
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return ARCHIVE_KEY_TEXT.test(text) ? (text as ArchiveKey) : null;
}

const MAX_DIR_NAME = 64;
const CUT_KEEP = 55;
const PLAIN_BYTE = /^[a-z0-9.-]$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const c = char.codePointAt(0) ?? 0;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }
  return bytes;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

const escapeByte = (byte: number): string => `_${byte.toString(16).padStart(2, "0")}`;

/**
 * A site as one directory name on every platform. Bytes outside [a-z0-9.-] become `_xx`, as do the first byte of a
 * Windows device name and a trailing dot. A name over 64 characters keeps 55, then `~` and an FNV-1a hash of the
 * whole name; such a name cannot be read back, so parseSiteDir returns null for it.
 */
export function siteDirName(site: Site): SiteDir {
  const bytes = utf8(site);
  const deviceName = WINDOWS_DEVICE.test(site.split(".")[0] ?? "");
  const name = bytes
    .map((byte, i) => {
      const char = String.fromCharCode(byte);
      const mustEscape =
        !PLAIN_BYTE.test(char) ||
        (i === 0 && deviceName) ||
        (i === bytes.length - 1 && char === ".");
      return mustEscape ? escapeByte(byte) : char;
    })
    .join("");
  return (
    name.length <= MAX_DIR_NAME ? name : `${name.slice(0, CUT_KEEP)}~${fnv1a(name)}`
  ) as SiteDir;
}

/** The inverse of siteDirName for every name it produces whole. A cut, foreign or non-canonical name is null. */
export function parseSiteDir(dir: string): Site | null {
  let decoded = "";
  for (let i = 0; i < dir.length; i++) {
    const char = dir[i] ?? "";
    if (PLAIN_BYTE.test(char)) {
      decoded += char;
      continue;
    }
    const hex = dir.slice(i + 1, i + 3);
    if (char !== "_" || !/^[0-7][0-9a-f]$/.test(hex)) return null;
    decoded += String.fromCharCode(Number.parseInt(hex, 16));
    i += 2;
  }
  const site = parseSite(decoded);
  return site !== null && site === decoded && siteDirName(site) === dir ? site : null;
}

/**
 * `incoming/` sits at the archive level, not in a site directory, so deleting an excluded site's directory never
 * meets a file a tee still holds open. Every other file is closed between appends.
 */
export const LAYOUT = {
  settings: "settings.json",
  ledger: "ledger.json",
  exportsJournal: "exports.jsonl",
  incomingDir: "incoming",
  sitesDir: "sites",
  logDir: "log",
  packDir: "packs",
  bodyDir: "bodies",
  tmpSuffix: ".tmp",
} as const;

export function logSegmentId(site: Site, run: RunId, seq: number): LogSegmentId {
  return `${siteDirName(site)}/${run}-${seq}` as LogSegmentId;
}
export function packId(site: Site, run: RunId, seq: number): PackId {
  return `${siteDirName(site)}/${run}-${seq}` as PackId;
}

const splitScoped = (id: LogSegmentId | PackId): readonly [string, string] => {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
};

/** `sites/<site>/log/<run>-<seq>.jsonl`, sealed at LOG_SEAL_BYTES, after ROTATE_IDLE_MS idle, or at clean shutdown. */
export function logSegmentPath(segment: LogSegmentId): readonly string[] {
  const [dir, name] = splitScoped(segment);
  return [LAYOUT.sitesDir, dir, LAYOUT.logDir, `${name}.jsonl`];
}
/** `sites/<site>/log/<run>-<seq>.summary.json`. Written to `.summary.json.tmp`, then renamed: present means whole. */
export function logSummaryPath(segment: LogSegmentId): readonly string[] {
  const [dir, name] = splitScoped(segment);
  return [LAYOUT.sitesDir, dir, LAYOUT.logDir, `${name}.summary.json`];
}
/** `sites/<site>/packs/<run>-<seq>.pack`. Only the current run appends; an old run's pack is sealed by being old. */
export function packPath(pack: PackId): readonly string[] {
  const [dir, name] = splitScoped(pack);
  return [LAYOUT.sitesDir, dir, LAYOUT.packDir, `${name}.pack`];
}
/** `incoming/<run>.<channel>.part`. Its only writer is that channel's native tee. */
export function partPath(id: ExchangeId): readonly string[] {
  return [LAYOUT.incomingDir, `${id}.part`];
}
/** `sites/<site>/bodies/<run>.<channel>.body`. Renamed from the part after the tee closed it. */
export function bodyFilePath(site: Site, id: ExchangeId): readonly string[] {
  return [LAYOUT.sitesDir, siteDirName(site), LAYOUT.bodyDir, `${id}.body`];
}

/**
 * The site directory a name lives in. It is the file's link to its site: a directory name siteDirName cut to length
 * cannot be read back as a Site, so no name carries one.
 */
interface InSite {
  readonly dir: SiteDir;
}

export type ArchiveName =
  | ({ readonly kind: "site-dir" } & InSite)
  | ({
      readonly kind: "log";
      readonly segment: LogSegmentId;
      readonly run: RunId;
      readonly seq: number;
    } & InSite)
  | ({ readonly kind: "summary"; readonly segment: LogSegmentId; readonly run: RunId } & InSite)
  | ({
      readonly kind: "pack";
      readonly pack: PackId;
      readonly run: RunId;
      readonly seq: number;
    } & InSite)
  | { readonly kind: "part"; readonly id: ExchangeId; readonly run: RunId }
  | ({ readonly kind: "body"; readonly id: ExchangeId; readonly run: RunId } & InSite)
  /** settings.json.tmp or ledger.json.tmp: an interrupted root JSON write. It belongs to no run. */
  | { readonly kind: "tmp"; readonly of: "settings" | "ledger" }
  /** <segment>.summary.json.tmp: an interrupted summary write, of the segment's run. */
  | ({
      readonly kind: "tmp";
      readonly of: "summary";
      readonly segment: LogSegmentId;
      readonly run: RunId;
    } & InSite);

const SEQUENCED = /^([0-9a-z]+)-(0|[1-9][0-9]{0,8})$/;

function sequenced(stem: string): { readonly run: RunId; readonly seq: number } | null {
  const match = SEQUENCED.exec(stem);
  const run = match === null ? null : parseRunId(match[1] ?? "");
  return match === null || run === null ? null : { run, seq: Number(match[2]) };
}

function exchangeIn(stem: string | null): { readonly id: ExchangeId; readonly run: RunId } | null {
  const parsed = stem === null ? null : parseExchangeId(stem);
  return parsed === null ? null : { id: exchangeId(parsed.run, parsed.channel), run: parsed.run };
}

function siteDir(dir: string): InSite | null {
  return parseSiteDir(dir) !== null || /^[a-z0-9._-]{55}~[0-9a-f]{8}$/.test(dir)
    ? { dir: dir as SiteDir }
    : null;
}

function scopedId(raw: string): string | null {
  const slash = raw.indexOf("/");
  const parts = slash < 0 ? null : sequenced(raw.slice(slash + 1));
  return parts === null || siteDir(raw.slice(0, slash)) === null
    ? null
    : `${raw.slice(0, slash)}/${parts.run}-${parts.seq}`;
}
export function parseLogSegmentId(raw: string): LogSegmentId | null {
  return scopedId(raw) as LogSegmentId | null;
}
export function parsePackId(raw: string): PackId | null {
  return scopedId(raw) as PackId | null;
}

function inSiteFile(scope: InSite, folder: string, file: string): ArchiveName | null {
  const ending = (suffix: string): string | null =>
    file.endsWith(suffix) ? file.slice(0, -suffix.length) : null;
  if (folder === LAYOUT.bodyDir) {
    const id = exchangeIn(ending(".body"));
    return id === null ? null : { kind: "body", ...scope, ...id };
  }
  const parts = (suffix: string) => {
    const stem = ending(suffix);
    return stem === null ? null : sequenced(stem);
  };
  const id = (p: { readonly run: RunId; readonly seq: number }): string =>
    `${scope.dir}/${p.run}-${p.seq}`;
  if (folder === LAYOUT.packDir) {
    const p = parts(".pack");
    return p === null ? null : { kind: "pack", ...scope, pack: id(p) as PackId, ...p };
  }
  if (folder !== LAYOUT.logDir) return null;
  const log = parts(".jsonl");
  if (log !== null) return { kind: "log", ...scope, segment: id(log) as LogSegmentId, ...log };
  const summary = parts(".summary.json");
  if (summary !== null)
    return { kind: "summary", ...scope, segment: id(summary) as LogSegmentId, run: summary.run };
  const tmp = parts(`.summary.json${LAYOUT.tmpSuffix}`);
  return tmp === null
    ? null
    : { kind: "tmp", of: "summary", ...scope, segment: id(tmp) as LogSegmentId, run: tmp.run };
}

/** Foreign or malformed names return null and are left alone. Recovery never deletes what it cannot name. */
export function parseArchiveName(relativePath: readonly string[]): ArchiveName | null {
  const [first, second, third, fourth, ...rest] = relativePath;
  if (rest.length > 0 || first === undefined) return null;
  if (second === undefined) {
    if (first === `${LAYOUT.settings}${LAYOUT.tmpSuffix}`) return { kind: "tmp", of: "settings" };
    if (first === `${LAYOUT.ledger}${LAYOUT.tmpSuffix}`) return { kind: "tmp", of: "ledger" };
    return null;
  }
  if (first === LAYOUT.incomingDir) {
    const id =
      third === undefined && second.endsWith(".part")
        ? exchangeIn(second.slice(0, -".part".length))
        : null;
    return id === null ? null : { kind: "part", ...id };
  }
  if (first !== LAYOUT.sitesDir) return null;
  const scope = siteDir(second);
  if (scope === null) return null;
  if (third === undefined) return { kind: "site-dir", ...scope };
  return fourth === undefined ? null : inSiteFile(scope, third, fourth);
}

/**
 * Small seal sizes and an idle rotation bound what sits in open files, which retention counts but cannot delete.
 * With S sites active in the last ROTATE_IDLE_MS, open files hold at most S x (PACK_SEAL_BYTES + LOG_SEAL_BYTES).
 * @public
 */
export const LOG_SEAL_BYTES = 2 * 1_048_576;
/** @public */
export const PACK_SEAL_BYTES = 8 * 1_048_576;
/** Maximum pending pack bytes before an early flush fires in the store. @public */
export const PACK_PENDING_MAX = 1_048_576;
/** Maximum bytes buffered in one batch (pending below PACK_PENDING_MAX plus one memory-tee body). @public */
export const FLUSH_BATCH_BYTES = 2 * PACK_PENDING_MAX;
/** @public */
export const ROTATE_IDLE_MS = 60_000;
