# Export

`packages/export` turns the background recording and any open DevTools capture into one streamed HAR 1.2 document. Like `packages/recording`, its `tsconfig.json` gives `src/` no DOM or Node types (`AbortSignalLike` is structural), so a browser or Node global in source is a type error.

## Merging the two sources

- Pairing joins strictly on `ExchangeId` (`<run>.<channelId>`). Channel ids repeat across browser restarts, so keying without the run pairs a DevTools item with an older run's line; a 50 ms time-window fallback paired 22 of 59 requests wrongly. Items without a key stay unpaired and appear once per source.
- One request is one entry. A source can list one key twice (the recording's listing includes its live snapshot, so a request that settles between the two reads appears as a line and as a live row). Within a source the settled row wins, ties go to the first listed, and each row left out is counted in `report.duplicates`; across sources the kept rows pair one to one (`DUPLICATE_RULE` in `merge.ts`). Keyless rows cannot be matched and all stay.
- `FIELD_RULES` in `merge.ts` is a mapped type over `HarEntryField` (derived from `@hark/har/model`), so adding a model field without a rule fails typecheck. Related fields (`request-head`, `response-head`, `timings`) come whole from one source via `FIELD_GROUPS`, so an entry never mixes one source's status with another's headers or timings from two clocks.
- `bodyPlan` tries the recording's stored bytes first and DevTools second. When neither has a candidate, the recording's reason wins except `not-recorded`, which yields to DevTools' more specific state (such as `devtools-truncated` or `empty`).

## Redaction is @hark/har's, applied last

- The export decides nothing about secrets. `ExportRequest.redaction` is `none` or one of har's levels by name (`standard`, `shareable`). Each entry is built complete (bodies, comments, `_harExport`) and passed to `redactHarEntry` as the last step before it is written; the log's own fields (pages, comment, the export's report) go through `redactHar` once at the end. Nothing is added to an entry after it is redacted.
- The file's `log._harExport.redaction` is har's report: `redactHar` over the log without its entries, with each entry's place counts and records added in the order `redactHar` would add them. The test is that an export at a level equals `redactHar` at that level of the same export written with `none`, report included.
- Page titles are built from unredacted URLs and redacted with the log, under the page-title rules of the same level.
- Under `standard`, every body is kept and reported as not examined; under `shareable`, every body is removed. A body place is never partly examined, so the export never buffers a body to redact it.

## Bodies, losses, and traps

- One function, `chooseEncoding`, decides how every body is written, for both places and both sources: `text` only for bytes that are valid UTF-8 and whose declared charset is UTF-8, ASCII or absent (or that are pure ASCII), otherwise base64 of the exact bytes. DevTools' decoded text is turned back into UTF-8 bytes first (a pair split between slices is joined), so its declared charset is UTF-8, whatever the page's. A request body that is not text gets `postData.encoding: "base64"`, mirroring `content.encoding`, because HAR 1.2 gives `postData` no encoding field.
- A body is read up to the 3 MiB body window before any of it is written. A longer response body cannot be checked whole in time, so it streams as base64: the entry is redacted once with a sentinel in its text (not counted) to learn whether the level keeps the text and the JSON before it, and once after the body ends for the JSON after it. Both must agree on the part already written. `content.size` is the decoded bytes read.
- Every loss is written into the entry and counted in the report, never a failed export and never silent. A body is complete, empty, missing with a reason from `MISSING_REASONS`, or cut short with a reason from `CUT_SHORT_REASONS` whose comment says how many bytes are present. A source whose `load` throws leaves its side out and names it in the entry's comment; with no side left the entry is a stub from the listing row. A `list` that throws is an empty listing and a sentence in `log.comment`. Only the sink throwing, or an abort, fails the export.
- Non-network URLs (`data:`, `blob:`, `about:`) are excluded by `classifyUrl` and counted in `report.notNetwork`, because `har-to-k6` 0.13.0 rejects an entire archive containing one while still exiting 0.
- `parseExportRequest` accepts only `"har"` packaging.
