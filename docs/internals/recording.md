# Recording

`packages/recording` holds every rule the background recording follows that does not need a browser: which requests are recorded, what happens to each body, where every file lives, how a log line is written and read back, what the next start does after a crash, and what retention deletes. The experiment API parent script calls it from the parent process with the system principal. The package itself has no principal: `tsconfig.json` gives `src/` no Node or DOM types, so a browser or Node global there is a type error.

## Every body is copied while it arrives

No body is left in the browser's HTTP cache or read back from it. A cache entry's key is the bare URL, reopening by it missed every entry, and a replaced entry with the same Date second and length passes a check on those two, so the file would get another request's bytes. Copying every body at capture through a native tee fit the cost budget on every fixture page with 0 wrong bytes in 89,490 bodies. `BODY_ROUTES` picks the sink from the response head alone, because a tee must be attached at examine time; a measurement changes a row of that table and no caller.

## One exchange, one line

An exchange is a state machine in `exchange.ts`: opened at `http-on-opening-request`, decided or copying at the first examine topic, settled at stop. A channel that stops with no head is `unanswered`; one still live at shutdown is `abandoned`, with `browser-closed` or `recording-stopped`, never a guess between the two. A 304 from the network waits in `awaiting-merge` and takes its body from the merged response on the same channel, keeping the 304's head.

A line pairs each route with only the bodies its row can produce, and an abandoned body names no reason of its own, so a contradictory line is a type error and `decodeLine` refuses it. That is why a decided capture settles to its route's own outcome and an unmerged 304 to empty before any rule: `SETTLE_RULES` holds the rows that read a sink, and is first match wins. A body the watchdog cut at the body cap keeps its first part, stored with `check: "first-part"`. That row comes before `stop-failed`: an endless stream that passed the cap is usually aborted later by a navigation, and its first part is still exact.

## Files and the commit point

The rules that keep the archive consistent across crashes:

- One writer per file. A part in `incoming/` belongs to its tee and sits outside every site directory, so deleting an excluded site never meets an open file on Windows.
- The newline is the commit point. Pack bytes are appended and a body file renamed before the line that addresses them. A line is never rewritten.
- Log lines are ASCII (`encodeLine` writes every code unit above 0x7e as a `\u` escape), so a byte offset in a segment is a string offset and a torn tail never splits a character.
- Facts that change later are derived: `bodyAvailability` reads "removed by retention" or "interrupted by crash" from which files exist.
- Settings and summaries are written through a `.tmp` file and a rename. A summary counts only when it decodes and its recorded size equals its segment's.

## Recovery is a pure plan

`planReconcile` reads a directory snapshot and returns steps; the store executes them. Every step is derived from what is on disk and removes its own trigger, so planning again after the steps, or after a crash part way through them, converges. The tests hold it to a 22-row crash table, to altered copies of the planner that each break one rule and must fail that table, and to generated runs: random store operations stopped at a random step (sometimes mid-write), plus zero-filled summaries for a power loss, then recovery interrupted at random and run again. After every recovery the second plan is empty, every line whose append finished is still in its segment, and every body such a line names still exists. Removing any one planner rule fails the generated test.

A site name over 64 characters is cut with a hash (`siteDirName`), so `parseSiteDir` cannot read it back. Recovery therefore never asks a file for its `Site`. A file belongs to a site by the directory its name carries, the planner finds each excluded site's directory with `siteDirName`, and a log's entry carries its own lines, so a snapshot cannot list a segment apart from its file. Linking them by `Site` would drop a cut site's segments and delete that site's committed bodies as orphans.

## Retention stops at a pin

Every file counts toward its cap, open files included, because open files cannot be deleted. The size walk goes oldest first and stops at the first pinned file instead of skipping it, so an export's pin can never cause newer data to be deleted first. Age deletes skip pinned and open files. A generated test holds the caps and the pin rule over random inventories.
