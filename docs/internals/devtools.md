# DevTools capture source

`apps/extension/experiment/devtools.ts` exposes open DevTools toolboxes as the second `ExchangeSource` alongside the parent-process background recording.

## Lazy priming without loading DevTools

Importing `Loader.sys.mjs` eagerly initializes DevTools in every browser launch. `primeToolboxes()` only imports `DevToolsShim.sys.mjs` and attaches a `"toolbox-ready"` listener, which Gecko queues until DevTools actually starts. Once any toolbox opens (including Inspector or Console), calling `toolbox.getNetMonitorAPI()` starts `NETWORK_EVENT` collection on that toolbox even if the user never opens the Network panel.

## Bypassing built-in Netmonitor HAR traps

Built-in `HarExporter` has three traps when called directly:

- **Panel sort dependency.** Passing items through Redux selectors breaks under non-time sorts such as `contentSize`. `createDevtoolsSource()` reads `api.store.getState().requests.requests` and sorts by `startedMs`.
- **Unwanted body materialization in `HarBuilder`.** `HarBuilder.buildContent()` calls `connector.requestData(id, "responseContent")` even when `includeResponseBodies` is `false`, forcing `FirefoxDataProvider` to pull entire `LongStringActor` payloads into memory. Passing one `metadataConnector` wrapper per request that returns empty content lets `HarBuilder` format headers, cookies, post data, and timings without pulling response bytes.
- **Stack frame destruction and destroyed targets.** `FirefoxDataProvider` clears its per-actor pending stack map after the first `getStackTrace()` call and only persists frames into Redux state when `actionsEnabled` is `true`. Once a navigated page's `targetFront` is destroyed (or a cleared request leaves Redux state), `requestData(id, "stackTrace")` writes `stackTraceAvailable: false` (capital `T`) while leaving `cause.stacktraceAvailable: true`, causing every subsequent call to hit two 50 ms `batchingMiddleware` `DelayedTask` flushes (~100 ms/row). `source.load()` caches destroyed targets and tracks attempted IDs so dead targets and cleared requests skip `requestData`, `HarBuilder`, and `getResponseContent` in bulk, while live panels enable `actionsEnabled` for concurrent chunked prefetches (repairing panels left disabled by a failed built-in HAR export), disable actions across `HarBuilder`, and restore `actionsEnabled` afterward.
- **Snapshot at export start, live store checks, and lost-group fallback.** `createGeckoHost()` captures a synchronous DevTools snapshot at `exports.start()` so a `0 ms` navigation or reload clearing `Netmonitor` does not empty the listing before disk setup finishes. Before reading `getResponseContent`, `resolveResponseBody()` re-reads the live store request so in-progress or `truncated` responses are flagged `"in-progress"` / `"devtools-truncated"` instead of returning empty or zero-padded bytes. When cleared/dead actors or dropped headers/timings occur, `devtools.ts` marks `lostGroups` on the `Material` so `merge` falls back to the recording for `request-head`, `response-head`, and `timings`, and emits `_harExport.headersMissing` / `_harExport.timingsMissing` when neither source has usable values.
- **`blockedReason: 0` on completed requests.** Gecko represents an unblocked request with `blockedReason` set to `0` (as well as `false`, `""`, or nullish). Both `inProgress` filtering and response body resolution must test truthiness (`Boolean(request.blockedReason)`) rather than strict null/empty checks, or completed private-window requests resolve as `"no-response"`.

## Body filling vs. LongStringActor slice streaming

`devtools.netmonitor.bodyLimit` truncates response payloads inside the network actor (`content.text` shorter than full size). When truncated, DevTools emits a `"size-limit"` / `"devtools-truncated"` placeholder rather than fabricated bytes; for non-private traffic, `runExport` prefers the recording candidate first so full bodies recorded in the parent process fill truncated or discarded DevTools items.

When only DevTools has the body (for example, a private window when `extension.privateBrowsingAllowed` is true and `devtools.netmonitor.bodyLimit` is `0`), `bodies.open()` streams `LongStringActor.substring(start, end)` packets directly over `client.request()` instead of calling `getLongString()`. Dead actors whose `networkEvent` front has been released yield `"discarded"` / `"devtools-discarded"` stubs rather than failing the export.

## Pairing scope and non-network rows

DevTools `request.resourceId` maps to Gecko's `nsIHttpChannel.channelId`, which is not globally unique across restarts. Keys are always scoped as `exchangeId(run, channelKey)` against the current process's `RunId` so current DevTools items can only pair with current-run archive lines.

Non-network schemes such as `data:` and `blob:` in the Netmonitor store are excluded from HAR entries and reported in `notNetwork` counts so downstream tools such as `har-to-k6` receive valid HTTP/WebSocket entries.
