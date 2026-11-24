import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ARCHIVE_KEY_FILE, LAYOUT } from "@hark/recording/layout";
import {
  launchBrowser,
  type BrowserSession,
  type Pref,
  type RemoteLaunchRequest,
} from "./browser.ts";
import { listArchive, locateArchive, readLines, type ArchiveLine } from "./archive.ts";

/** Turns on the extension's harness topic. Only system-principal code can reach it. */
export const HARNESS_PREFS: readonly Pref[] = [{ name: "extensions.hark.harness", value: true }];

/** Downloads go to the check's own folder, never the user's Downloads, and never ask. */
const downloadPrefs = (folder: string): readonly Pref[] => [
  { name: "browser.download.dir", value: folder },
  { name: "browser.download.folderList", value: 2 },
  { name: "browser.download.useDownloadDir", value: true },
  { name: "browser.download.always_ask_before_handling_new_types", value: false },
];

export type HookRequest =
  | {
      readonly kind:
        | "flush"
        | "seal"
        | "recovery"
        | "status"
        | "retain"
        | "reset-work"
        | "pin-oldest-pack"
        | "sites";
    }
  | { readonly kind: "exclude"; readonly site: string }
  | { readonly kind: "unpin"; readonly pinId: string }
  | { readonly kind: "arm" | "reached"; readonly point: string }
  | { readonly kind: "guard"; readonly path: string }
  | { readonly kind: "export-audit" | "export-route"; readonly id: string }
  | { readonly kind: "export-fault"; readonly op: string; readonly errno: string }
  | {
      readonly kind: "export-pause";
      readonly point: "before-bodies" | "before-link" | "before-rename" | "after-link";
      readonly action: "arm" | "reached" | "release";
    };

const HOOK_SCRIPT = `const done = arguments[arguments.length - 1];
  const request = arguments[0];
  Services.obs.notifyObservers({ wrappedJSObject: { request, done } }, "hark-harness");`;

export async function callHook(
  session: Pick<BrowserSession, "evaluateChrome">,
  request: HookRequest,
): Promise<unknown> {
  const answer = (await session.evaluateChrome(HOOK_SCRIPT, [request])) as
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly error: string }
    | null;
  if (answer === null) throw new Error(`no answer from the harness topic for ${request.kind}`);
  if (!answer.ok) throw new Error(`harness ${request.kind}: ${answer.error}`);
  return answer.result;
}

function clearReadOnlyTree(root: string): void {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = NodePath.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) clearReadOnlyTree(path);
    else {
      try {
        NodeFS.chmodSync(path, 0o600);
      } catch {
        // Best-effort attribute cleanup before removing the temp workspace.
      }
    }
  }
}

/** A folder for one check: its profile, its data home and its downloads, removed at dispose. */
export type RecordingWorkspace = AsyncDisposable & {
  readonly profileDir: string;
  readonly dataHome: string;
  readonly downloads: string;
  /** `dataHome` defaults to the workspace's; a check that wants the archive refused passes one inside the profile. */
  readonly launch: (
    request: Omit<RemoteLaunchRequest, "profileDir" | "allowSystemAccess">,
  ) => Promise<BrowserSession>;
  readonly lines: () => readonly ArchiveLine[];
  readonly root: () => string;
  readonly appFolder: () => string;
  /** Writes the key and settings.json before the first launch, as if an earlier run had made them. */
  readonly seed: (key: string, settings: unknown) => void;
  readonly entries: () => ReturnType<typeof listArchive>;
};

export function recordingWorkspace(name: string): RecordingWorkspace {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `hark-${name}-`)),
  );
  const profileDir = NodePath.join(base, "profile");
  const dataHome = NodePath.join(base, "data");
  const downloads = NodePath.join(base, "downloads");
  for (const dir of [profileDir, dataHome, downloads]) NodeFS.mkdirSync(dir, { mode: 0o700 });
  const location = () => {
    const found = locateArchive(dataHome, profileDir);
    if (found === null) throw new Error(`no archive key in ${profileDir}`);
    return found;
  };
  return {
    profileDir,
    dataHome,
    downloads,
    launch: (request) => {
      const targetDataHome = request.dataHome ?? dataHome;
      return launchBrowser({
        ...request,
        profileDir,
        dataHome: targetDataHome,
        allowSystemAccess: true,
        extraPrefs: [
          ...HARNESS_PREFS,
          { name: "extensions.hark.harness.dataHome", value: targetDataHome },
          ...downloadPrefs(downloads),
          ...(request.extraPrefs ?? []),
        ],
      });
    },
    lines: () => readLines(location().root),
    root: () => location().root,
    appFolder: () => location().appFolder,
    seed: (key, settings) => {
      NodeFS.writeFileSync(NodePath.join(profileDir, ARCHIVE_KEY_FILE), `${key}\n`, {
        mode: 0o600,
      });
      const root = NodePath.join(dataHome, "hark", key);
      NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(root, LAYOUT.settings), JSON.stringify(settings), {
        mode: 0o600,
      });
    },
    entries: () => listArchive(location().appFolder),
    [Symbol.asyncDispose]: async () => {
      if (process.platform === "win32") clearReadOnlyTree(base);
      NodeFS.rmSync(base, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
    },
  };
}

/** A small body cap: a quarter of the smallest body limit settings accept, 64 MiB. */
export const SMALL_CAP_SETTINGS = {
  user: {
    version: 1,
    retention: { maxBodyBytes: 64 * 1_048_576, maxDetailBytes: 1024 * 1_048_576, maxAgeDays: 14 },
    excludedSites: [],
    media: "details-only",
    secretStorage: "store",
    exportDefaults: { bodies: "include", secrets: "remove" },
  },
  exportFolder: { kind: "downloads" },
} as const;
export const SMALL_CAP_BYTES = 16 * 1_048_576;
