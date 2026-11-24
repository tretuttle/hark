# Redaction

`packages/har/src/redact.ts` removes what a redaction level promises and writes a report of what it kept. No sentence about what a level does is written by hand, so the report cannot say more than the code does.

## One table, every key

`model.ts` derives `HarModelField`, every key of every model interface at any depth, by walking the types from `HarLog` and `HarEntry`; a type already on the path (the initiator stack's `parent`) is not walked again. `HAR_MODEL_FIELD_TABLE` has exactly one row per key, whatever its type: the value kinds, the places, the value a required field takes when its value is removed, and for containers where their own fields are listed. Type checks in `redact.ts` fail when a key has no row, or when a row's kinds, item kind or removal value disagree with the model type. A narrower table (strings only, `_harExport` strings, or leaving out numbers, booleans and nested Chrome types) misses a field; one table over every key leaves nothing between tables.

A value whose JSON type is not the one its row gives is removed at both levels, recorded under `wrong-type`, and replaced by the row's removal value when the field is required. The removal value is itself checked against the model type. A request URL that is not a URL, or is not one once redacted, is replaced by `https://redacted.invalid/` at both levels and recorded the same way; no redaction path puts an input value back. Counting is by place: every present value counts once, including `null` and the empty string, so a custom `_port: 443` or a cookie's `expires: null` is counted when kept and recorded when removed.

## A URL is what the URL Standard says it is

A hand-made rule misses or over-matches URLs, and scanning free text for anything shaped like an authority can be neither complete nor exact. So "is this a URL" and "where is its userinfo" are decided only by the WHATWG URL Standard's parsing rules, applied in `url-standard.ts`. The tests compare every result with the platform's own parser (`URL` in Node), over 50,000 generated strings per level: a URL with a username or password loses exactly that text and its `@`, and every other value stays byte for byte. One rule is narrower than the standard: a host name with non-ASCII characters is taken as valid, because checking it needs the Unicode IDNA tables.

- `request.url` is a URL field. A value that does not parse is replaced at both levels.
- A page title is examined only when the whole title is a URL with no space or control character. Any other title is text: kept and not examined under `standard`, removed under `shareable`.
- A listed URL header (`Referer`, `Location`, `Content-Location` and the rest of `URL_HEADER_NAMES`) and `response.redirectURL` are examined the same way: when the whole value is a URL, its userinfo and secret query values go at both levels, and its host, path and fragment stay. A navigation URL's `access_token` reaches the `Referer` of every request the page makes; left unexamined, it stayed 201 times in a 202-entry file exported at `standard`. `:path` is a path, not a URL, and is not examined.
- `blob:`, `view-source:`, `jar:` and `filesystem:` carry another URL, which is redacted the same way, up to 3 deep; a deeper value is not a URL. When the carried value does not parse (`blob:null/<uuid>` does not), the wrapper is an opaque URL like any other.
- A URL with no host (`data:`, `mailto:`, `about:`, `javascript:`) is not examined after its scheme under `standard`. Under `shareable` its content becomes `redacted` (`data:redacted`), because the HAR 1.2 schema's `uri` format, read strictly, rejects an empty path. Its query and fragment are handled like any URL's.
- Parsing is one pass with no backtracking pattern and no recursion; a test checks that 5 MB of hostile input takes about five times as long as 1 MB.

## The output is always a valid HAR 1.2 document

Whatever is removed, the result must validate against the published HAR 1.2 schema. A row's removal value is typed against the model, but the model is looser than the schema in one place: Firefox writes `lastFetched` where the schema requires `lastAccess`, so a cache entry's members are optional in the model and required by the schema. Such an object is a whole place (`wholePlace` in the table): `_initiator`, `_webSocketMessages`, `cache.beforeRequest` and `cache.afterRequest` are kept or removed as one object, so a removal never leaves `{}`. A value of the wrong type inside a whole place removes the whole place. `redact-schema.test.ts` removes each place in turn, and puts a wrong type in each field, on a valid document holding every field, and redacts generated valid documents at both levels; every output must pass `har-validator` 5.1.5 and the schema compiled with ajv's strict formats.

## What the report may carry

Records and `_harExport.redactedFields` name a removal by model field path, place, rule id and count. They never carry a value, a header name, a query name or a custom key, because a level can remove those, and copying them into the report would publish what was removed.

`log._harExportId` is the random id an export writes first, so recovery can prove a part on disk is that export's (see the API doc's file section). It holds nothing from a page, and the export writes it before redaction sees the log, so `redactHar` keeps it at every level and counts it in no place; otherwise the export's report and `redactHar`'s would differ by one unexamined custom field.

## Rules

- A header is on the default list when its value is a credential or a proof signed for one request: `DPoP` (RFC 9449) and `Signature` (RFC 9421) are listed. `Digest`, `Content-Digest` and `Repr-Digest` hold a hash of the body and are not.
- `_harExport` is this product's own annotation. Body source and body-state notes are the `export-annotation` place: kept under `standard`, removed under `shareable`. An earlier run's `redaction` report and `redactedFields` list are `redaction-record`, replaced at both levels. Unknown keys under `_harExport` are custom fields, like unknown `_` fields from other tools: kept under `standard`, removed under `shareable`.
- `standard` rebuilds every object in its own key order and changes only removed values, so a document with nothing to remove comes back byte for byte. It writes nothing into `comment` fields.
- The summarizer never reads a redaction report from the document, because any file can carry one. The caller passes the report `redactHar` returned.
