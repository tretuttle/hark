# Recording in Gecko

The background recording runs in the experiment API's parent script: system principal, parent process. It writes every request it sees to an archive outside the profile. Extension pages with the `moz-extension` principal reach it only through the experiment API, which returns status and counts and never a path or a body byte. Pages with a content principal reach nothing. [Recording](recording.md) covers the pure rules; this file covers what the Gecko side decides and the traps behind it.

## Design

- **Startup is synchronous up to the observers.** `onStartup` resolves the archive root, reads the key and reads `settings.json` with synchronous file calls (one small file each), then adds the six observers before anything is awaited. The first request of the run already has a place to go, and an excluded site is excluded from the first channel. Starting them 650 ms later missed the first page.
- **The archive name is 128 random bits kept in the profile** (`<profile>/hark.archive-key`). A local `file://` page can test whether a path exists, and a name derived from the profile path could be guessed. A missing or unreadable key file gets a new key and so a new, empty archive. The old archive stays on disk untouched: nothing can tell which profile it belonged to, so the product never deletes it. The user can delete `hark/<old key>/` by hand.
- **Settings live in the archive, not the profile.** Only the parent script reads or writes `settings.json`, always through `.tmp` and a rename. A file that does not parse is renamed to `settings.json.rejected`, a name recovery never touches, and the status reports `settings-unreadable`.
- **An exchange settles when both stops have happened.** `http-on-stop-request` and the tee's own `onStopRequest` arrive in either order; the store commits when it has both, so a sink's byte count is final before `settle` reads it.
- **The status names a `file://` page's way in.** With `security.fileuri.strict_origin_policy` false, a local page can read the archive. `getRecordingStatus` reports `file-pages-can-read-files`; the extension never changes the user's setting.
- **Nothing is added to the Downloads list.** An extension with the `downloads` permission sees every entry's path and file name.
- **The folder guard covers `moz-src://`.** `moz-src:///` resolves into `omni.ja`, like the known `resource://` names; its target joins `ForbiddenRoots.substitutions`.
- **A harness topic exists only in harness profiles.** With `extensions.hark.harness` set, the parent script listens on the observer topic `hark-harness`, which only system-principal code can reach. It flushes, seals, excludes a site, parks the write chain at a named crash point or an export at a pause, and returns the steps recovery ran. The pref `extensions.hark.harness.namedParts` beside it makes exports name a part, as where no folder can be held. It reveals nothing system-principal code could not read from the archive already.

## Traps

Each was observed on Zen Twilight 1.25t (Gecko 160) on Linux.

- **A service worker's interception replaces the channel object and keeps its id.** The object `http-on-opening-request` delivered has no listener by `service-worker-synthesized-response`, and `setNewListener` on it throws `NS_ERROR_UNEXPECTED`. The recorder always acts on the object the current topic delivered.
- **An internal redirect source never stops.** A document load can open a channel that turns `NS_BINDING_REDIRECTED` and never reaches an examine topic or `http-on-stop-request`; its target arrives with another channel id. The recorder drops such opened-only entries every 256 admissions instead of keeping them until shutdown.
- **`http-on-stop-request` can fire twice for one channel** (a service worker's script update, both `NS_BINDING_ABORTED`). The second finds no live entry and is ignored.
- **The body cap is a bound, not an exact byte.** The watchdog checks part sizes every 250 ms, so a fast stream passes the cap by up to 250 ms of throughput: a local stream with a 16 MiB cap kept 21,430,272 bytes. Under load the page can even finish reading past the cap before the watchdog runs (observed on Zen 1.24.2b), so the tee's own stop checks the part against the cap too: a part that reached it is the body's first part however the request ended.
- **`IOUtils` creates files 0644.** Every archive file is first created through `nsIFileOutputStream` with mode 0600, and directories are set to 0700 after creation.
- **Marionette's recommended preferences turn `security.fileuri.strict_origin_policy` off**, so a harness launch in `recommended` mode reports `file-pages-can-read-files`. A launch in `real-defaults` mode does not.
