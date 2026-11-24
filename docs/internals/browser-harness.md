# Browser harness

`tools/browser-harness` is the single launcher, fixture server, and check runner for every Gecko browser. Extension scripts (`verify:browser`, `screenshot:toolbar`) launch through it rather than keeping separate spawn, profile, or shutdown code.

## Check discovery and the browser's own version

`browser-harness check` discovers every `*.ts` file under `tools/browser-harness/checks/` in sorted filename order and fails if zero checks are discovered or an unknown `--check` filter is requested. `environment` compares `hark.getEnvironment()` against the browser's own WebDriver session capabilities (`name`, `version`, `buildId`) instead of `application.ini` on disk, waits for `WebExtensionPolicy.getByID(id).active` rather than racing startup, and verifies schema refusals and DevTools open/close state. `restart` installs the XPI, shuts the browser down cleanly, relaunches on the same profile without reinstalling, and verifies the extension stays active. `cost-baseline` runs the rotated three-arm cost check.

## Three-arm cost measurement and baselines

`browser-harness cost` measures `off` (no extension), `extension` (packed XPI installed), and `panel` (Network panel open on the tab before navigation) across the cost pages (`cost-images`, `cost-heavy`, `cost-mixed`). Arms assert their own preconditions before counting (`extension`: active policy and working extension API; `panel`: Netmonitor open and recorded request count >= served count; `off`: neither), trigger GC/CC, and settle at least `2500 ms` until two consecutive `250 ms` parent main-thread windows are at or below `5.0 ms` (capped at `8000 ms`) so fresh-profile startup bursts stay outside the window.

Arms rotate inside each round, round `0` is dropped as warmup, and rounds whose machine load exceeds `25%` CPU or `1`-minute loadavg `max(4, round(cpuCount * 0.25))` are discarded and repeated. Primary CPU is parent main-thread milliseconds from `ChromeUtils.requestProcInfo()` (thread with `tid === pid`) between navigation start and page completion. The budget for `extension` is `off + 0.5 * (panel - off)`. CI runs `--short` (`3` rounds on `cost-images`). The `baseline` command and `cost --record-baselines` write baselines locally under `tools/browser-harness/baselines/` and `baselines/cost/`, only when `errors` is `0`. A baseline describes one machine and browser build, so it is not committed.

## Fixture server records

Every non-control response from the fixture server carries a monotonic `X-Seq` header, and the server records a per-sequence SHA-256 (`wireSha256` and `decodedSha256`) alongside a request log. This covers both static pinned fixtures (`src/pinned-responses.ts`) and dynamic or streaming identity fixtures (`/poll`, cancelled 4 MiB download, 304 revalidation, cache hit, 302-to-307 redirect chain, service worker synthesize and passthrough, endless NDJSON stream, refused loopback port, and `Content-Disposition: attachment` download link). Control queries under `/__harness/` do not increment `X-Seq` or enter the fixture request log.

## Launch modes, cache control, and remote protocols

A remote launch uses WebDriver BiDi unless `--protocol marionette` is passed. Closing a tab in Marionette switches back to the initial window handle so subsequent tabs remain valid. Default launch prefs disable the HTTP cache (`browser.cache.disk.enable`, `browser.cache.memory.enable`, `network.http.use-cache`); pass `cache: true` to enable it for 304 and cache-hit checks.

`launchBrowser` accepts a named `launchMode`:

- `recommended` (default): keeps Gecko Remote Agent's recommended preferences (`remote.prefs.recommended = true`). Observed on Zen Twilight 1.25t, this modifies `125` effective preferences (on top of the `22` `LAUNCH_PREFS`), including setting `security.fileuri.strict_origin_policy` to `false`.
- `real-defaults`: sets `remote.prefs.recommended = false` in `user.js` while still applying `LAUNCH_PREFS` and remote-protocol prefs. `security.fileuri.strict_origin_policy` stays `true`.
- `none`: launches with no `-marionette`, no `--remote-debugging-port`, no remote prefs, no `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, and `stdio: "ignore"` (never opening an unread pipe), optionally passing `urls` directly.

## Process-tree ownership, exit reporting, and orphan cleanup

Every decision about a signal is a pure function over data in `src/signal-policy.ts`: `decideSignal` (an ordered table of refusal rules: an ID `<= 1`, the harness, its parent or its process group, a group the target does not lead, an ownership record not minted by `spawnOwned` or a verified lease, or a start time or profile path that no longer matches), tree membership, the stop state machine (`SIGTERM` to the tree, `SIGKILL` at `1500 ms`, give up at `5000 ms`, never a core-dump signal; one refusal in a step stops the whole stop), and `decideLease`. `decideSignal` is the only issuer of a `SignalOrder`, and minted orders and ownership records are frozen. `signalPerformer` in `owned-process.ts` redeems an order (single use, refused unless issued, ID floor checked again) before it sends; the host's sender is the one `process.kill`, and Windows uses `taskkill /T` instead (its arguments are tested; running it is not observed on Linux). Liveness comes from the process table (`/proc`; one `ps` or `Win32_Process` listing on macOS and Windows, not observed on Linux), so nothing sends signal 0. Once a root has exited, its process group is no longer trusted, because its ID could belong to a reused PID: only processes naming the profile directory are stopped, and PID 1 and the harness, its parent and its group leader never count as members.

Stopping, reaping and profile removal take a `ProcessIo`. Tests pass `src/simulated-process-io.ts`, a fixed process table whose `perform` is `signalPerformer` with the system call swapped for a change to the table, so the whole chain (refusals, membership, escalation timing, cross-process reaping) is proven with no process and no signal on every machine and in CI.

Each launch gets its own `XDG_DATA_HOME`, removed at dispose unless the caller passes one, so the recorder's archive never lands in the user's data folder. `kill` sends `SIGKILL` at a point a test chose by entering the same stop past its `SIGTERM` step, so the order still comes from `decideSignal`; only namespace tests call it.

By default (`suppressCoreDumps` enabled), Linux launches wrap the browser with `prlimit --core=1:1 --` when `prlimit` is on `PATH` so crashing or aborted browsers skip `systemd-coredump` (`RLIMIT_CORE = 0` still triggers core-pipe handlers here); macOS (`ReportCrash`) and Windows (`WER`) launch unwrapped and are not observed on Linux. Child exit watchers report on `exit` with a `100 ms` bounded stderr drain so descendants holding stderr cannot delay failure reporting, and unexpected post-connect socket closes attach the browser's exit status and stderr tail.

Before each launch, `reapOrphanedLaunches` scans a `0700` per-user lease directory (`hark-leases-<uid>`) of `0600` version-2 leases recording PID, process start time (Linux `/proc/<pid>/stat` field 22), and exact profile path. A lease only authorizes a stop when its harness is gone and its browser still has the recorded start time and profile path; otherwise the stale lease and profile are cleared without a signal. A failed reap keeps the lease, records `reapFailures` and `lastReapFailure`, and retries on the next launch, so a transient failure never leaks a browser for good. Any profile inside a live Zen, Firefox, LibreWolf, Floorp, or Waterfox profile root is refused before creation.

## Driving the real popup

`checks/popup-states.ts` opens the toolbar popup itself, not the popup page in a tab, because the popup reads the window's active tab when it loads. Each of these was observed in headless Zen 1.24.2b:

- `browserActionFor(extension).openPopup(window)` from chrome opens it, but only for the focused window, and only once the button has a node there; a new private window needs `CustomizableUI.addWidgetToArea` first.
- Every Marionette content call re-selects the tab it runs in, some time after the call returns. The open script therefore waits until the popup has drawn before it returns, or the popup reads the helper page's tab.
- The popup's DOM is reached from a page of the add-on with `browser.extension.getViews({ type: "popup" })`. That lists only views whose principal the caller's subsumes, so a private popup needs a page of the add-on in the private window.
- A chrome screenshot of the window does not include the popup panel; `drawSnapshot` on the popup's `<browser>` does.
- Zen draws a private window and its popups dark whatever `ui.systemUsesDarkTheme` and `browser.theme.dark-private-windows` say, so the private state has a dark screenshot only.

## Driving the extension pages

The history and options pages run in tabs, and the `pages-*` checks drive them with clicks as a user would. They run in their own CI job, `Browser pages`; the `Browser` job passes them to `--skip`, which refuses a name no check has, so a renamed check cannot run in both jobs or neither.

- Zen restores its spaces after the window opens, even with `browser.startup.page` 0. On the first start after a restart, a tab opened before that finished was closed under Marionette (`contentBrowser is null`, a navigation that never ended, or a page whose API calls never answered; 3 of 7 runs). `PageDriver.origin` waits for `SessionStore.promiseAllWindowsRestored`, `gZenWorkspaces.promiseInitialized` and a stable tab list first; 8 of 8 passed after.
- The folder picker is replaced for one browser by a factory registered for `@mozilla.org/filepicker;1` from chrome, answering the folder a pref names, so the product's own picker call runs unchanged and carries no harness hook.
- A screenshot draws the selected tab's whole document with `drawSnapshot` after scrolling to the top; a sticky element is drawn where the current scroll puts it.

## Tests that can send a signal

`scripts/signal-reach.ts` parses the repository and follows static imports from every function to `process.kill`, a `.kill()` call, or a spawned kill command; a dynamic import it cannot follow counts as reaching any module of its own package. `pnpm run check` fails, printing the path, when a test outside a `*.namespace.test.ts` file can reach one, or when a namespaced file does not call `requireIsolatedPidNamespace()` first.

The root Vite config runs `*.namespace.test.ts` files only inside the namespace that `src/namespace-suites.test.ts` starts with `unshare --user --map-current-user --pid --fork --mount-proc --kill-child`, under `prlimit --core=1:1` and a private `TMPDIR`. Its launcher refuses unless it is PID 1, and each file refuses unless PID 1 is that launcher, a host process the outer run named is invisible, and every visible process descends from the launcher. Whether the machine grants a namespace is asked with a separate `unshare --user` probe that shares no flags with the launcher, so a broken launcher fails the run instead of reading as a refusal. Where the namespace is refused, the suites skip with a warning on a developer machine and fail under `CI`. GitHub's Ubuntu runner refuses one through AppArmor (`write failed /proc/self/uid_map`), so the workflows set `kernel.apparmor_restrict_unprivileged_userns=0` first. Also tried on the runner: `sudo unshare` works but runs the suites as root, and a container job has its own PID namespace but refuses `unshare` inside it.

## Mutation testing of the guard

A rule no test pins can be deleted without a test noticing, so the guard is mutation-tested: `pnpm --filter @hark/browser-harness run mutation:guard` (`mutation/guard-mutation.ts`) applies a fixed list of operator mutations (operator and boundary swaps, condition to `true`/`false`, operand, element, property, statement and call removal, number `±1`, regex boundary removal) one at a time to `signal-policy.ts`, the performer and `spawnOwned`/`stopOwnedTree`, the namespace launcher and isolation check, `spawnLeasedBrowser` and `parseLease`. It runs only inside a PID and user namespace, gives each test run a nested one ended by `timeout` inside it, runs the guard's fixed-data tests first and the namespaced suites only for mutants they miss, and fails unless every mutant is killed or listed in `mutation/equivalent-mutants.json` with a one-line reason. A listed mutant that a test now kills, or that is no longer generated, also fails it. The `Guard mutation` workflow runs it on every pull request that touches the guard, its tests or the runner, with a 25-minute limit.
