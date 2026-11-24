import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createLaunchLease, reapOrphanedLaunches, type ActiveLease } from "./orphan-lease.ts";
import {
  hostProcessIo,
  killOwnedTree,
  removeDirectoryBounded,
  spawnOwned,
  stopOwnedTree,
  watchChildExit,
  type ProcessIo,
} from "./owned-process.ts";
import {
  currentPlatformName,
  readProcessSnapshot,
  type ProcessPlatformName,
} from "./process-table.ts";
import { connectRemote, type RemoteProtocol } from "./remote.ts";
import { readZipEntry } from "./zip.ts";

export type Pref = {
  readonly name: string;
  readonly value: boolean | number | string;
};

export const LAUNCH_PREFS: readonly Pref[] = [
  { name: "extensions.experiments.enabled", value: true },
  { name: "xpinstall.signatures.required", value: false },
  { name: "extensions.autoDisableScopes", value: 0 },
  { name: "devtools.debugger.remote-enabled", value: true },
  { name: "remote.active-protocols", value: 1 },
  { name: "browser.shell.checkDefaultBrowser", value: false },
  { name: "datareporting.policy.dataSubmissionEnabled", value: false },
  { name: "toolkit.telemetry.enabled", value: false },
  { name: "app.update.enabled", value: false },
  { name: "app.update.auto", value: false },
  { name: "browser.aboutwelcome.enabled", value: false },
  { name: "trailhead.firstrun.didSeeAboutWelcome", value: true },
  { name: "zen.welcome-screen.seen", value: true },
  { name: "browser.startup.homepage_override.mstone", value: "ignore" },
  { name: "browser.startup.page", value: 0 },
  { name: "browser.startup.homepage", value: "about:blank" },
  { name: "browser.sessionstore.resume_from_crash", value: false },
  { name: "browser.cache.disk.enable", value: false },
  { name: "browser.cache.memory.enable", value: false },
  { name: "network.http.use-cache", value: false },
  { name: "browser.tabs.warnOnClose", value: false },
  { name: "signon.rememberSignons", value: false },
];

export type BrowserDisplay = "headless" | "window";
export type BrowserLaunchMode = "recommended" | "real-defaults" | "none";

export type BrowserIdentity = {
  readonly binaryPath: string;
  readonly name: string;
  readonly version: string;
  readonly buildId: string;
  readonly userAgent: string;
  readonly remoteProtocol: RemoteProtocol;
  readonly headless: boolean;
};

export type BrowserSession = AsyncDisposable & {
  readonly spawnedPid: number;
  readonly browserPid: number;
  readonly profileDir: string;
  readonly dataHome: string;
  /** SIGKILL to the browser's tree now, through decideSignal. Only namespace tests call it. */
  readonly kill: () => Promise<void>;
  readonly launchMode: "recommended" | "real-defaults";
  readonly identity: BrowserIdentity;
  readonly openTab: (url: string) => Promise<string>;
  readonly navigateTab: (context: string, url: string) => Promise<void>;
  readonly reloadTab: (context: string) => Promise<void>;
  readonly evaluate: (context: string, expression: string) => Promise<string>;
  readonly evaluateChrome: (script: string, args?: readonly unknown[]) => Promise<unknown>;
  readonly takeChromeScreenshot: (selector?: string) => Promise<Buffer>;
  readonly closeTab: (context: string) => Promise<void>;
  readonly quit: () => Promise<void>;
};

export type UntouchedBrowserSession = AsyncDisposable & {
  readonly spawnedPid: number;
  readonly profileDir: string;
  readonly dataHome: string;
  readonly launchMode: "none";
  readonly exited: Promise<string>;
};

type LiveRootBase = "HOME" | "APPDATA" | "LOCALAPPDATA" | "XDG_CONFIG_HOME" | "XDG_CACHE_HOME";

type BrowserCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

type BrowserPlatform = {
  readonly path: NodePath.PlatformPath;
  readonly launcherArgs: readonly string[];
  // Where Zen and the Firefox family keep real profiles. A launch never touches these.
  readonly liveProfileRoots: readonly (readonly [LiveRootBase, ...string[]])[];
  // Prevent abnormal exits from reaching the host crash handler when a platform supports it.
  readonly wrapCoreLimit: (
    binaryPath: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => BrowserCommand;
};

const FIREFOX_FAMILY_FLATPAKS = [
  "app.zen_browser.zen",
  "org.mozilla.firefox",
  "io.gitlab.librewolf-community",
  "one.ablaze.floorp",
  "net.waterfox.waterfox",
] as const;

function findExecutable(name: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(NodePath.posix.delimiter)) {
    if (!dir) continue;
    const candidate = NodePath.posix.join(dir, name);
    try {
      if (!NodeFS.statSync(candidate).isFile()) continue;
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export const BROWSER_PLATFORMS: Readonly<Record<ProcessPlatformName, BrowserPlatform>> = {
  win32: {
    path: NodePath.win32,
    launcherArgs: ["-wait-for-browser"],
    liveProfileRoots: (["APPDATA", "LOCALAPPDATA"] as const).flatMap((base) => [
      [base, "zen"],
      [base, "Mozilla"],
      [base, "librewolf"],
      [base, "Floorp"],
      [base, "Waterfox"],
    ]),
    // Windows WER does not use POSIX RLIMIT_CORE; unobserved on Linux.
    wrapCoreLimit: (command, args) => ({ command, args }),
  },
  linux: {
    path: NodePath.posix,
    launcherArgs: [],
    liveProfileRoots: [
      ["HOME", ".zen"],
      ["HOME", ".mozilla"],
      ["HOME", ".librewolf"],
      ["HOME", ".floorp"],
      ["HOME", ".waterfox"],
      ["XDG_CONFIG_HOME", "zen"],
      ["XDG_CONFIG_HOME", "mozilla"],
      ["XDG_CONFIG_HOME", "librewolf"],
      ["XDG_CONFIG_HOME", "floorp"],
      ["XDG_CONFIG_HOME", "waterfox"],
      ["XDG_CACHE_HOME", "zen"],
      ["XDG_CACHE_HOME", "mozilla"],
      ["XDG_CACHE_HOME", "librewolf"],
      ["XDG_CACHE_HOME", "floorp"],
      ["XDG_CACHE_HOME", "waterfox"],
      ["HOME", "snap", "firefox"],
      ...FIREFOX_FAMILY_FLATPAKS.map((id) => ["HOME", ".var", "app", id] as const),
    ],
    // `ulimit -c 0` still triggers systemd-coredump here; `1` byte skips the core pipe handler.
    wrapCoreLimit: (binaryPath, args, env) => {
      const prlimit = findExecutable("prlimit", env.PATH);
      if (prlimit === null) return { command: binaryPath, args };
      return { command: prlimit, args: ["--core=1:1", "--", binaryPath, ...args] };
    },
  },
  darwin: {
    path: NodePath.posix,
    launcherArgs: [],
    liveProfileRoots: (["Application Support", "Caches"] as const).flatMap((folder) =>
      ["zen", "Firefox", "librewolf", "Floorp", "Waterfox"].map(
        (name) => ["HOME", "Library", folder, name] as const,
      ),
    ),
    // macOS has no prlimit and ReportCrash uses Mach exceptions; unobserved on Linux.
    wrapCoreLimit: (command, args) => ({ command, args }),
  },
};

export function renderUserJs(prefs: readonly Pref[]): string {
  const merged = new Map<string, Pref["value"]>();
  for (const pref of prefs) merged.set(pref.name, pref.value);
  return `${[...merged.entries()]
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
    .join("\n")}\n`;
}

export function browserIsOwned(
  browserPid: number,
  spawnedPid: number,
  parentPid: number | null,
): boolean {
  return browserPid === spawnedPid || parentPid === spawnedPid;
}

export function liveProfileRoots(
  platform: ProcessPlatformName,
  env: NodeJS.ProcessEnv,
  home: string,
): readonly string[] {
  const row = BROWSER_PLATFORMS[platform];
  const base = (name: LiveRootBase): string => {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
    if (name === "HOME") return home;
    if (name === "XDG_CONFIG_HOME") return row.path.join(home, ".config");
    if (name === "XDG_CACHE_HOME") return row.path.join(home, ".cache");
    throw new Error(`cannot locate live browser profiles: ${name} is not set`);
  };
  return row.liveProfileRoots.map(([root, ...segments]) => row.path.join(base(root), ...segments));
}

export function assertOutsideLiveProfiles(
  directory: string,
  roots: readonly string[],
  path: NodePath.PlatformPath = NodePath,
  caseFold = false,
): void {
  const fold = (value: string): string => (caseFold ? value.toLowerCase() : value);
  for (const root of roots) {
    const relative = path.relative(path.resolve(fold(root)), path.resolve(fold(directory)));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`refusing to use ${directory}: it is inside the live profile root ${root}`);
    }
  }
}

function foldsCase(platform: ProcessPlatformName): boolean {
  return platform === "darwin" || platform === "win32";
}

function assertSafeProfileDirectory(directory: string): void {
  const platform = currentPlatformName();
  const row = BROWSER_PLATFORMS[platform];
  const roots = liveProfileRoots(platform, process.env, NodeOS.homedir());
  assertOutsideLiveProfiles(directory, roots, row.path, foldsCase(platform));
  assertOutsideLiveProfiles(
    realpathIfPresent(directory),
    roots.map(realpathIfPresent),
    row.path,
    foldsCase(platform),
  );
}

export async function prepareProfile(
  extensionPath: string | null,
  extraPrefs: readonly Pref[] = [],
  basePrefs: readonly Pref[] = LAUNCH_PREFS,
): Promise<string> {
  const directory = NodeOS.tmpdir();
  assertSafeProfileDirectory(directory);
  const profile = await NodeFSP.mkdtemp(NodePath.join(directory, "hark-browser-"));
  try {
    await writeProfilePrefs(profile, extraPrefs, basePrefs);
    if (extensionPath !== null) await installExtension(profile, extensionPath);
    return profile;
  } catch (error) {
    await NodeFSP.rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function writeProfilePrefs(
  profile: string,
  extraPrefs: readonly Pref[],
  basePrefs: readonly Pref[] = LAUNCH_PREFS,
): Promise<void> {
  await NodeFSP.writeFile(
    NodePath.join(profile, "user.js"),
    renderUserJs([...basePrefs, ...extraPrefs]),
    "utf8",
  );
}

const REMOTE_LAUNCH: Record<
  RemoteProtocol,
  (port: number) => { readonly args: readonly string[]; readonly prefs: readonly Pref[] }
> = {
  bidi: (port) => ({ args: ["--remote-debugging-port", String(port)], prefs: [] }),
  marionette: (port) => ({
    args: ["-marionette"],
    prefs: [{ name: "marionette.port", value: port }],
  }),
};

const REMOTE_PREF_NAMES = new Set(["devtools.debugger.remote-enabled", "remote.active-protocols"]);
const UNTOUCHED_BASE_PREFS: readonly Pref[] = LAUNCH_PREFS.filter(
  (pref) => !REMOTE_PREF_NAMES.has(pref.name),
);

type CommonLaunchRequest = {
  readonly binaryPath: string;
  readonly extensionPath: string | null;
  readonly display: BrowserDisplay;
  readonly profileDir?: string;
  readonly cache?: boolean;
  readonly suppressCoreDumps?: boolean;
  readonly extraPrefs?: readonly Pref[];
  /**
   * XDG_DATA_HOME for the browser. Each launch gets its own folder, so the extension's archive never lands in the
   * user's data folder; a relaunch that must find the same archive passes the same folder.
   */
  readonly dataHome?: string;
  readonly signal: AbortSignal;
};

export function resolveBrowserSpawnCommand(
  binaryPath: string,
  args: readonly string[],
  options: {
    readonly platform?: ProcessPlatformName | undefined;
    readonly suppressCoreDumps?: boolean | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): BrowserCommand {
  if (options.suppressCoreDumps === false) {
    return { command: binaryPath, args };
  }
  const platform = options.platform ?? currentPlatformName();
  return BROWSER_PLATFORMS[platform].wrapCoreLimit(binaryPath, args, options.env ?? process.env);
}

export function spawnLeasedBrowser(
  binaryPath: string,
  args: readonly string[],
  lease: ActiveLease,
  options: {
    readonly stdio: "ignore" | ["ignore", "ignore", "pipe"];
    readonly env: NodeJS.ProcessEnv;
    readonly profileDir: string;
    readonly suppressCoreDumps: boolean | undefined;
  },
) {
  const launch = resolveBrowserSpawnCommand(binaryPath, args, {
    suppressCoreDumps: options.suppressCoreDumps,
    env: options.env,
  });
  const spawned = spawnOwned(launch.command, launch.args, {
    stdio: options.stdio,
    env: options.env,
    profileDir: options.profileDir,
  });
  if (spawned.ownership !== null) {
    lease.setSpawnedProcess(spawned.pid, spawned.ownership.startTime);
  }
  return { spawned, watcher: watchChildExit(spawned.child) };
}

const CACHE_ENABLED_PREFS: readonly Pref[] = [
  { name: "browser.cache.disk.enable", value: true },
  { name: "browser.cache.memory.enable", value: true },
  { name: "network.http.use-cache", value: true },
];

export type RemoteLaunchRequest = CommonLaunchRequest & {
  readonly launchMode?: "recommended" | "real-defaults";
  readonly protocol?: RemoteProtocol;
  readonly allowSystemAccess?: boolean;
};

export type UntouchedLaunchRequest = CommonLaunchRequest & {
  readonly launchMode: "none";
  readonly urls?: readonly string[];
};

export function launchBrowser(request: RemoteLaunchRequest): Promise<BrowserSession>;
export function launchBrowser(request: UntouchedLaunchRequest): Promise<UntouchedBrowserSession>;
export async function launchBrowser(
  request: RemoteLaunchRequest | UntouchedLaunchRequest,
): Promise<BrowserSession | UntouchedBrowserSession> {
  const launchMode: BrowserLaunchMode = request.launchMode ?? "recommended";
  const io = hostProcessIo();
  await reapOrphanedLaunches(io, assertSafeProfileDirectory);
  const cachePrefs = request.cache === true ? CACHE_ENABLED_PREFS : [];

  if (launchMode === "none") {
    await using stack = new AsyncDisposableStack();
    const untouchedRequest = request as UntouchedLaunchRequest;
    const prefs = [...cachePrefs, ...(untouchedRequest.extraPrefs ?? [])];
    const directory = await resolveProfileDir(
      io,
      stack,
      untouchedRequest.profileDir,
      untouchedRequest.extensionPath,
      prefs,
      UNTOUCHED_BASE_PREFS,
    );
    const dataHome = await resolveDataHome(io, stack, untouchedRequest.dataHome);
    const lease = await createLaunchLease(directory);
    stack.defer(() => lease.remove());
    const args = [
      ...(untouchedRequest.display === "headless" ? ["-headless"] : []),
      "-no-remote",
      "-profile",
      directory,
      ...BROWSER_PLATFORMS[currentPlatformName()].launcherArgs,
      ...(untouchedRequest.urls ?? []),
    ];
    // Never open a pipe when output is not consumed; avoids filling the pipe buffer under MOZ_LOG.
    const { spawned, watcher } = spawnLeasedBrowser(untouchedRequest.binaryPath, args, lease, {
      stdio: "ignore",
      env: {
        ...process.env,
        MOZ_CRASHREPORTER_DISABLE: "1",
        MOZ_DISABLE_AUTO_UPDATE: "1",
        XDG_DATA_HOME: dataHome,
      },
      profileDir: directory,
      suppressCoreDumps: untouchedRequest.suppressCoreDumps,
    });
    stack.defer(() => stopOwnedTree(io, spawned.ownership));
    const owned = stack.move();
    return {
      spawnedPid: spawned.pid,
      profileDir: directory,
      dataHome,
      launchMode: "none",
      exited: watcher.exited.then((result) => result.status),
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  }

  const remoteRequest = request as RemoteLaunchRequest;
  const protocol = remoteRequest.protocol ?? "bidi";
  const modePrefs: readonly Pref[] =
    launchMode === "real-defaults" ? [{ name: "remote.prefs.recommended", value: false }] : [];
  let attached = false;
  const attempt = async (): Promise<BrowserSession> => {
    attached = false;
    await using stack = new AsyncDisposableStack();
    const port = await freePort();
    const remoteLaunch = REMOTE_LAUNCH[protocol](port);
    const prefs = [
      ...remoteLaunch.prefs,
      ...modePrefs,
      ...cachePrefs,
      ...(remoteRequest.extraPrefs ?? []),
    ];
    const directory = await resolveProfileDir(
      io,
      stack,
      remoteRequest.profileDir,
      remoteRequest.extensionPath,
      prefs,
      LAUNCH_PREFS,
    );
    const dataHome = await resolveDataHome(io, stack, remoteRequest.dataHome);
    const lease = await createLaunchLease(directory);
    stack.defer(() => lease.remove());
    const args = [
      ...(remoteRequest.display === "headless" ? ["-headless"] : []),
      "-no-remote",
      "-profile",
      directory,
      ...remoteLaunch.args,
      ...BROWSER_PLATFORMS[currentPlatformName()].launcherArgs,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MOZ_CRASHREPORTER_DISABLE: "1",
      MOZ_DISABLE_AUTO_UPDATE: "1",
      XDG_DATA_HOME: dataHome,
      ...(remoteRequest.allowSystemAccess === true ? { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } : {}),
    };
    const { spawned, watcher } = spawnLeasedBrowser(remoteRequest.binaryPath, args, lease, {
      stdio: ["ignore", "ignore", "pipe"],
      env,
      profileDir: directory,
      suppressCoreDumps: remoteRequest.suppressCoreDumps,
    });
    const exitedStatus = watcher.exited.then((result) => result.status);
    stack.defer(() => stopOwnedTree(io, spawned.ownership));
    const remote = await connectRemote({
      protocol,
      port,
      exitStatus: watcher.status,
      waitForExit: () => exitedStatus,
      stderr: watcher.stderr,
      signal: remoteRequest.signal,
    });
    attached = true;
    stack.defer(() => remote.dispose());
    assertOwnedBrowser(remote.browserPid, spawned.pid);
    const owned = stack.move();
    return {
      spawnedPid: spawned.pid,
      browserPid: remote.browserPid,
      profileDir: directory,
      dataHome,
      kill: () => killOwnedTree(io, spawned.ownership),
      launchMode,
      identity: {
        binaryPath: remoteRequest.binaryPath,
        name: remote.browserName,
        version: remote.version,
        buildId: remote.buildId,
        userAgent: remote.userAgent,
        remoteProtocol: remote.protocol,
        headless: remoteRequest.display === "headless",
      },
      openTab: (url) => remote.openTab(url),
      navigateTab: (context, url) => remote.navigateTab(context, url),
      reloadTab: (context) => remote.reloadTab(context),
      evaluate: (context, expression) => remote.evaluate(context, expression),
      evaluateChrome: (script, scriptArgs) => remote.evaluateChrome(script, scriptArgs),
      takeChromeScreenshot: (selector) => remote.takeChromeScreenshot(selector),
      closeTab: (context) => remote.closeTab(context),
      quit: async () => {
        await remote.quit();
        await raceTimeout(exitedStatus, 10_000);
      },
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  };
  return await launchWithRetries({
    protocol,
    start: attempt,
    attached: () => attached,
    aborted: () => remoteRequest.signal.aborted,
    report: (line) => console.error(line),
  });
}

/** How the browser says its first tab never came up, so remote control cannot attach to it. */
const LOST_LAUNCH =
  /Browsing context has been discarded|SB::LA::SpawnTarget|Marionette handshake timed out/i;
// On Windows runners about 3 launches in 100 are lost this way. The export-failures check makes 96 launches, so
// one retry still loses the same launch twice in about one run in ten; two retries leave about one in 300.
const LAUNCH_RETRIES = 2;

export type RetriedLaunch<Session> = {
  readonly protocol: string;
  /** Starts the browser and attaches remote control. Called again for each retry. */
  readonly start: () => Promise<Session>;
  /** Whether remote control attached in the latest start; a product call may have followed it. */
  readonly attached: () => boolean;
  readonly aborted: () => boolean;
  readonly report: (line: string) => void;
};

/** Starts a browser again when the launch was lost before remote control attached, so no product call was made. */
export async function launchWithRetries<Session>(launch: RetriedLaunch<Session>): Promise<Session> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await launch.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        retry === LAUNCH_RETRIES ||
        launch.attached() ||
        launch.aborted() ||
        !LOST_LAUNCH.test(message)
      ) {
        throw error;
      }
      const cause = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 3)
        .join(" | ");
      launch.report(
        `retrying browser launch (retry ${retry + 1} of ${LAUNCH_RETRIES}) before ${launch.protocol} attached: ${cause}`,
      );
    }
  }
}

async function resolveProfileDir(
  io: ProcessIo,
  stack: AsyncDisposableStack,
  profileDir: string | undefined,
  extensionPath: string | null,
  prefs: readonly Pref[],
  basePrefs: readonly Pref[],
): Promise<string> {
  if (profileDir === undefined) {
    const directory = await prepareProfile(extensionPath, prefs, basePrefs);
    stack.defer(() => removeDirectoryBounded(io, directory));
    return directory;
  }
  assertSafeProfileDirectory(profileDir);
  await writeProfilePrefs(profileDir, prefs, basePrefs);
  if (extensionPath !== null) await installExtension(profileDir, extensionPath);
  return profileDir;
}

async function resolveDataHome(
  io: ProcessIo,
  stack: AsyncDisposableStack,
  dataHome: string | undefined,
): Promise<string> {
  if (dataHome !== undefined) return dataHome;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hark-data-"));
  stack.defer(() => removeDirectoryBounded(io, directory));
  return directory;
}

function raceTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function realpathIfPresent(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

function assertOwnedBrowser(browserPid: number, spawnedPid: number): void {
  const parentPid = browserPid === spawnedPid ? null : readProcessSnapshot(browserPid).parentPid;
  if (!browserIsOwned(browserPid, spawnedPid, parentPid)) {
    throw new Error(
      `browser pid ${String(browserPid)} is not the spawned process ${String(spawnedPid)} or its child`,
    );
  }
}

async function readExtensionManifest(extensionPath: string): Promise<unknown> {
  const absolute = NodePath.resolve(extensionPath);
  const stat = await NodeFSP.stat(absolute);
  return stat.isDirectory()
    ? JSON.parse(await NodeFSP.readFile(NodePath.join(absolute, "manifest.json"), "utf8"))
    : JSON.parse((await readZipEntry(absolute, "manifest.json")).toString("utf8"));
}

export async function readExtensionId(extensionPath: string): Promise<string> {
  return readGeckoId(await readExtensionManifest(extensionPath));
}

export async function readExtensionPopupPath(extensionPath: string): Promise<string> {
  const parsed = await readExtensionManifest(extensionPath);
  const action = recordField(parsed, "action");
  const popup = recordField(action, "default_popup");
  if (typeof popup === "string" && popup.length > 0) return popup;
  throw new Error(`manifest.json in ${extensionPath} has no action.default_popup`);
}

export async function waitForActiveExtensionUrl(
  session: Pick<BrowserSession, "evaluateChrome">,
  addonId: string,
  popupPath: string,
  timeoutMs = 15_000,
): Promise<string> {
  const result = await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     const [addonId, popupPath, timeoutMs] = arguments;
     const deadline = Date.now() + timeoutMs;
     const poll = () => {
       try {
         const policy = WebExtensionPolicy.getByID(addonId);
         if (policy && policy.active) {
           done({ url: policy.getURL(popupPath) });
           return;
         }
       } catch (error) {
         done({ error: String(error) });
         return;
       }
       if (Date.now() >= deadline) {
         const policy = WebExtensionPolicy.getByID(addonId);
         done({ error: policy ? "extension policy did not become active" : "extension policy missing for " + addonId });
         return;
       }
       setTimeout(poll, 50);
     };
     poll();`,
    [addonId, popupPath, timeoutMs],
  );
  if (isRecord(result)) {
    if (typeof result.error === "string") throw new Error(result.error);
    if (typeof result.url === "string" && result.url.length > 0) return result.url;
  }
  throw new Error(`unexpected policy result: ${JSON.stringify(result)}`);
}

async function installExtension(profileDir: string, extensionPath: string): Promise<void> {
  const absolute = NodePath.resolve(extensionPath);
  const stat = await NodeFSP.stat(absolute);
  const extensionsDir = NodePath.join(profileDir, "extensions");
  await NodeFSP.mkdir(extensionsDir, { recursive: true });
  const id = await readExtensionId(absolute);
  if (stat.isDirectory()) {
    await NodeFSP.writeFile(NodePath.join(extensionsDir, id), absolute, "utf8");
    return;
  }
  await NodeFSP.copyFile(absolute, NodePath.join(extensionsDir, `${id}.xpi`));
}

function readGeckoId(manifest: unknown): string {
  const id =
    geckoId(recordField(manifest, "browser_specific_settings")) ??
    geckoId(recordField(manifest, "applications"));
  if (id === undefined) throw new Error("extension manifest has no gecko id");
  return id;
}

function geckoId(settings: unknown): string | undefined {
  const gecko = recordField(settings, "gecko");
  if (!isRecord(gecko)) return undefined;
  const id = gecko.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return id;
}

function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function freePort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no free port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
