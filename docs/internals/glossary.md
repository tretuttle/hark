# Glossary

The words the code and the product use, one line each.

## Product and people

- **Hark.** A Zen and Firefox extension that saves a complete HAR of any tab in one click. No DevTools needed, and it includes what already happened.
- **Gecko browser.** Zen, Firefox Nightly, Firefox Developer Edition, or an unbranded build or fork that does not force add-on signing, so it can load an experiment API.
- **User.** The person running Hark in their browser under their own operating-system account.

## Processes and principals

- **Parent process.** The Gecko process that runs browser chrome and privileged code. Hark records and stores captures here.
- **Content process.** A Gecko process that runs web pages. It holds no Hark data.
- **Principal.** The Gecko security identity attached to running code, which decides what that code may reach.
- **System principal.** The principal of browser chrome code. It passes every security check. The experiment API parent script runs with it.
- **`moz-extension` principal.** The principal of an extension's own pages and background script, scoped to its `moz-extension://` origin.
- **Content principal.** The principal of a web page, scoped to that page's origin.
- **Experiment API.** A WebExtension API that an unsigned or privileged extension declares itself. Its parent script runs with the system principal in the parent process, and only the declaring extension can call it.

## Capture

- **DevTools capture.** The request list inside an open DevTools Network panel, exported directly without the built-in panel save dialog.
- **Native tee.** An `nsIStreamListenerTee` attached at examine time that copies a response's wire bytes into a sink as they arrive, without passing them through script.
- **Cap watchdog.** The timer that closes a file tee's part once it reaches the body cap. It runs only while a file tee is live.
- **Archive key.** 128 random bits kept in the profile that name the archive's folder, so no path below the archive root can be guessed.
- **Harness topic.** The observer topic a harness profile turns on to flush, seal, exclude, park the write chain at a crash point, and read recovery.

## Recording

- **Background recording.** The always-on, low-cost parent-process capture of requests and response bodies, used when DevTools was not open.
- **Exchange.** One request and its response, from the channel opening to its one log line. Its id is the run plus the channel id.
- **Run.** One browser session, start to quit. Every file a run writes carries its run id, and channel ids repeat across runs.
- **Site.** The registrable domain of the top-level document, or the host for IP and single-label hosts. Recording, exclusion and history group by it.
- **Site directory.** A site's folder under `sites/`. A site name too long for one directory name is cut with a hash and cannot be read back, so recovery links files to their site directory, never to the site.
- **Body route.** The row of `BODY_ROUTES` that decides, from the response head alone, whether a body is copied and into which sink.
- **Sink.** Where a copied body goes while it arrives: a memory tee into the site's pack, or a file tee into `incoming/`.
- **Pack.** A site's append-only file of small bodies for one run, addressed by offset and length.
- **Part.** A file tee's file in `incoming/` while its body arrives. It becomes a body file when the tee closes.
- **Log segment.** A site's append-only file of exchange lines for one run, sealed by size, idle time or quit. The newline is the commit point.
- **Segment summary.** A segment's counts and activity buckets, written through a `.tmp` file and a rename. It counts only while its size matches the segment's.
- **Exclusion.** A site the user stopped recording. Its directory is deleted, and recovery finishes a deletion a crash interrupted.
- **Recovery.** The steps the next start takes from what is on disk after a crash. Planning again after they run plans nothing.
- **Retention.** Deleting the oldest sealed files when the archive passes its size or age cap. It stops at a file an export has pinned.
- **Pin.** A lock held while an export lists and reads recorded files; retention stops at the oldest pinned file instead of skipping past it.
- **Activity index.** The in-memory counts behind the popup and history pages, derived from summaries and open segments and never written to disk.

## Export

- **HAR export.** An HTTP Archive 1.2 file built on demand from DevTools capture, background recording, or both, with any missing bodies reported.
- **Standard redaction.** The default redaction level (`standard`). It removes the values its rules name as credentials, redaction records from an earlier run, and values whose JSON type does not match the model, and leaves every other value, and the order of keys, as it was. The report it writes lists exactly what it removed and what it kept without examining; see [Redaction](redaction.md).
- **Shareable redaction.** The allowlist redaction level (`shareable`). It keeps only the places its table marks `kept-by-allowlist` and removes every other place. The report it writes lists both.
- **Missing-body state.** The per-entry state recorded in `_harExport` and counted by `@hark/har/summarize`: a body that is missing, with its reason, or incomplete (`bodyIncomplete`), with the reason its first part was all that was stored. An incomplete body never counts as present.
- **Body window.** The 3 MiB of a body the export reads before writing any of it. A body that ends inside it is written in one piece and its encoding is decided on all its bytes; a longer response body streams as base64, and a longer request body is cut short at the window.
- **Cut-short body.** A body whose first bytes are in the file and whose rest is not. Its comment says how many bytes are present and why, from `CUT_SHORT_REASONS`.
- **Unpaired item.** A source item whose `ExchangeId` key is `null` (such as a DevTools entry without a `resourceId`); it cannot join across sources and is written once and counted in the report.
- **Non-network row.** A source listing entry whose URL scheme is outside `http:` and `https:` (`data:`, `blob:`, `about:`); counted by scheme in the report and excluded from `entries`.

## Extension

- **API contract.** The typed table in `apps/extension/experiment/contract.ts` that lists each experiment API function with its parameters, each parameter's parser, and its result type. The build generates `schema.json` from it, and the extension pages and the parent script typecheck against it.
- **Host.** What runs the API's handlers after their arguments are parsed. The experiment host runs in the parent process.
- **Export job.** One export the host runs, listed by `listExports` with its state: writing, done, cancelled or write-failed.
- **Export journal.** `exports.jsonl` in the archive. It names each `.har.part` before its first byte and again when it is renamed or deleted, so the next start deletes a part a crash left.
- **Toolbox.** A DevTools instance attached to one tab. When a toolbox is open, its Network panel holds that tab's requests.

## Harness

- **Browser harness.** `tools/browser-harness`: the single isolated launcher for any Gecko browser, the fixture server, and the `check`, `cost`, `measure`, `baseline`, and `har-check` commands.
- **Check.** One `*.ts` file under `tools/browser-harness/checks/` found by file discovery and run by `browser-harness check` and CI.
- **Cost arm.** One of `off`, `extension`, or `panel` (Network panel open), rotated inside each measurement round with round 0 dropped as warmup.
- **Sequence record.** The per-sequence byte length, status, and SHA-256 recorded by the fixture server for every `X-Seq` response, paired with the server's request log.
- **Scenario.** A named set of responses one fixture page makes the browser fetch, each with its method, path, status, and pinned or per-sequence SHA-256 and length.
- **Sample.** One measured page load: from navigation start to the moment the last resource finished, as the page reports it.
- **Baseline.** A set of samples (`off` or `panel`, or no-extension `measure`) named after the machine, browser build, and display mode it ran on. Written locally under `tools/browser-harness/baselines/` only when `errors` is 0. It describes one machine and browser build and is not committed.
- **Remote protocol.** WebDriver BiDi or Marionette. A launch asks for one, and only that listener is started.

## UI

- **Popup view.** One screen of the toolbar popup, a variant of the `PopupView` union in `apps/extension/src/popup/view.ts`: `ready`, `custom`, `exporting`, `done`, `error-write`, `error-store`, `empty-tab`, `empty-private`, `no-tab` or `api-missing`. The reducer moves between them and returns API calls as commands; the store runs the commands.
- **Ready-made export.** One of the popup's four rows (this tab, this tab recent, this site, everything recorded), built from `PRESETS` with the count and "up to" size the API's `getPopup` reports. One click on a row starts its export.
- **Footer choices.** The two toggles under the rows, response bodies and removing secrets, which apply to every row and to Custom. They start from the export defaults in settings.
- **Custom export.** The popup view that builds a selection from a scope, a time range, a request filter and a file name, checks it with `parseSelection`, and counts it with `preview` before the export starts.
- **Missing-body group.** One line of the result: a count of bodies not in the file for one reason from `MISSING_REASONS` or `CUT_SHORT_REASONS`, with a link to the setting that changes it where the table names one. Bodies left out by the footer choice are listed but not counted as missing.
- **No-tab view.** The popup on a tab it cannot use, such as Zen's empty tab (id -1). Only the rows that need no tab are offered.
- **Blocking recording problem.** A `RecordingProblem` that means nothing is being recorded (`archive-refused`, `archive-unwritable`); it shows the `error-store` view instead of the rows. Other problems show as a warning line above the rows.
- **Session.** A stretch of one site's activity with no gap longer than 30 minutes (`SESSION_GAP_MINUTES`), as `listSessions` returns it. The history page lists sessions by site; ticked sessions of any sites export as one file through the `sessions` selection.
- **History page.** `src/pages/history/`: sites on the left, the chosen site's sessions on the right, and a selection bar whose "Export as one file" is disabled while nothing is ticked. Excluding a site from it asks once, in place.
- **Settings section.** An element of the options page whose id is a `SettingsSection`. Every popup settings link opens one; the options page keys its section table by that type, so a link with no section fails typecheck. `export-holding` and `unreadable-files` explain a retention problem and say what the user can do.
