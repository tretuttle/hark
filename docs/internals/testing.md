# Testing

Rules for writing tests, and for asking for them in review.

## What to test

- Test behavior that can break: principal and permission boundaries, persistence and file ACL guards, capture and retention decisions, HAR serialization, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, and mock-call mirrors.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test or at each call site.
- In review, ask for a missing test only when it would catch a real regression. Flag a new test that breaks the rules above, and name the fix: fold it into the existing case or table, delete it, or keep one layer.
- Behavior changes in `packages/*` ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, and state bugs get a failing test first, then the fix. Purely visual bugs get before/after captures as their proof and no test.

## Tests that can send a signal

A test that can reach a real signal lives in a `*.namespace.test.ts` file and runs only inside a fresh PID namespace; a refusal is tested on the pure decision with fixed data instead. [Browser harness](browser-harness.md#tests-that-can-send-a-signal) explains the check that enforces this, and [mutation testing of the guard](browser-harness.md#mutation-testing-of-the-guard) the run that fails when a guard rule has no test.

## Real-browser checks

- Real-browser checks live under `tools/browser-harness/checks/*.ts` and are found by file discovery. A new check is one file exporting a `HarnessCheck` whose `name` matches its filename, with no shared registry edit.
- Every browser check compares extension behavior against the running browser's own reported session capabilities or the fixture server's `X-Seq` records and request log, and ships with a unit test that feeds it a deliberately broken result.
- `apps/extension` invokes the same harness via `pnpm --filter @hark/extension run verify:browser -- --binary <path>` (or `GECKO_BINARY`).

## Waiting for work

Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.

- No real-clock waits. Await the promise or event that marks the milestone, or use fake timers and advance them.
- No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried. The one exception is `tools/browser-harness/src/namespace-suites.test.ts`: its single test runs every `*.namespace.test.ts` suite against a real browser, so its own limit is sized from timed runs on two CPUs, and the comment beside it gives those times.
- No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
- `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.

## Each workspace keeps its own Vitest cache

`vite.config.ts` sets `test.fsModuleCachePath` to `"node_modules/.vitest-cache"`. The value matches Vitest's documented default, but the line is not redundant. Left unset, Vitest puts the cache in the monorepo root's `node_modules`. Set explicitly, the path resolves against Vitest's `root`, which is each workspace's folder under `vp run -r test`. Those runs are parallel, so a shared folder fails with `ENOTEMPTY` after a lockfile change: one run deletes the cache while another writes to it.
