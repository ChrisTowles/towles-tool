# CLAUDE.md — crates/tt-collect

Collectors that fill `tt-store`'s `tt.db`: calendar (via `claude -p`), issues
+ PRs (via `gh`), and the pure protocol logic for a watched Slack DM (via
Socket Mode). Tauri-free — both `tt collect` (CLI) and the app's scheduler
drive the same [`CollectSummary`] contract.

## The never-panic, never-`Err` contract

Every public `collect_*` function returns a [`CollectSummary`] (`ok`,
`count`, `message`) — never a `Result::Err`, never a panic. A missing
`claude`/`gh` binary, a non-zero exit, or unparseable output all become
`ok: false` with a message, recorded via `Store::record_run` under a stable
key (`claude:calendar`, `issues`, `prs`, `slack:dm` — the frontend matches on
these). Keep new collectors inside this contract rather than propagating
`Result` upward: the app's scheduler awaits collectors in sequence, so one
`Err`/panic would take out every collector behind it in the batch, not just
its own.

## Per-repo isolation

`collect_issues`/`collect_prs` fan `gh` calls for each tracked repo across a
bounded thread pool (`lib.rs` ~line 285) rather than a single call per repo
serially. Each repo's outcome is independent — one repo's failure (a missing
dir, a repo `gh` can't reach) never sinks another repo's rows. Preserve this
when touching the per-repo path; a shared early-return would silently zero
out unrelated repos' data.

## GitHub rate limiting (#322)

Two mitigations, both load-bearing for keeping the GraphQL budget (per-token,
not per-directory) from getting hammered:

- `dedupe_repo_dirs` (`lib.rs`) runs before every sweep in `collect_issues`/
  `collect_prs`, collapsing tracked dirs to one per resolved `owner/repo`
  before the expensive PR/issue-list calls fire. Every worktree of a repo
  is a separate tracked dir sharing one GitHub identity, so without this an
  N-task repo issues N sets of byte-identical queries per tick. Only a dir
  that *fails* to resolve is kept unconditionally (can't prove it's a
  duplicate) — don't "fix" that into dropping it, or a real error goes silent.
- `gh::LIST_LIMIT` is capped at **60**, not an arbitrarily generous number.
  GitHub prices a GraphQL connection on the page size *requested*, not the rows
  returned, so every `--limit` applies to every tracked repo on every tick even
  when a repo has two open PRs. The cost steps at 60→80 (measured on
  `gh pr list --json …statusCheckRollup…`: ≤60 costs 1 point, ≥80 costs 2), so
  the old 200 was paying double for headroom nobody used. Re-measure before
  raising it — the constant's doc comment carries the table.
- `sweep_cache` shares collector results between open windows. `dedupe_repo_dirs`
  handles one window asking about the same repo twice; this handles four windows
  each asking the same question, which cost ~1,920 points/hour of a 5,000/hour
  budget. **The unit is one `(collector, repo)` pair, not one sweep** — a file per
  repo per question under `tt_config::gh_cache_dir()`
  (`<kind>/<owner>/<repo>.json`) — because that's the unit the answer is true of.
  Read that module's docs before changing the keying: per-sweep keying needs two
  guards that per-repo keying doesn't need at all (a partial sweep can't be
  published, since a missing repo reads back as "that repo has nothing" and the
  full-table replace would clear its rows; and a reader has to prove the cached
  set matches its own tracked set, or a just-added repo gets cleared the same
  way). Per repo, reuse is also partial: three fresh repos and one stale one is
  one `gh` call, not four. Concurrent publishers touch different files, so
  neither can lose the other's work.
  The `reuse_ms` argument on `collect_issues`/`collect_prs_open`/
  `collect_prs_merged` is how old an answer may be; `FETCH_NOW` (0) reuses
  nothing, which is what the post-`gh` nudge passes to show a change immediately.
  **`collect_prs` (the full sweep) takes no part in this in either direction** —
  every caller is a `tt collect` run or the app's refresh button, so it would
  never accept a shared answer, and no other collector asks its question, so
  there'd be no reader for what it published.
  Two things stay out of the cache deliberately, both in `sweep_repos_shared`: a
  repo `gh` can't name (no key to file it under) and a tracked dir that's gone
  (the sweep has to reach it so the run message reports the stale path, instead
  of cached rows papering over it).
  Every sweep logs `gh.sweep` with how many repos went each way, because the
  `process.spawn` records that count `gh` calls can show the volume drop but not
  the reason: a window that reused another's answers, one that sat minimized, and
  one with the collector switched off all make no calls at all.
- `gh::run` arms a process-wide backoff the moment a call's stderr looks like
  a GitHub rate-limit response (primary or secondary/abuse-detection), and
  every `gh` call short-circuits without spawning a subprocess while that
  backoff is armed. This is intentionally global, not per-repo: the limit is
  per-token, so one hit means the next call anywhere is likely limited too.

## Calendar collector: timeout matters more than it looks

`collect_calendar` is **off by default** (it burns tokens every scheduler
tick) and shells out to `claude -p` with a hard `CLAUDE_TIMEOUT` (180s). This
isn't a nice-to-have: the app's scheduler awaits collectors serially, so a
wedged `claude` (stuck on an auth prompt, a dead MCP server) would otherwise
block every other collector forever, not just the calendar one. If you add
another `claude -p`-backed collector, give it the same kind of hard ceiling.
Note the ceiling is **per source** and sources run serially, so N enabled
calendars is an N×180s worst case — keep that in mind before adding
concurrency-free work to this path.

## Calendar sources are independent lanes

One `claude -p` run per **enabled** `tt_config::CalendarSource`, each writing
through `Store::replace_events_for_source(id, day_start, day_end, …)`. The
delete is scoped to `(source, local day)` so a personal and a work calendar
merge into one timeline instead of the second pull erasing the first, and the
prompt lives in settings (not a compiled-in constant) so a machine without the
Google/Outlook MCP can point a source at whatever does work there.

Two invariants worth keeping:

- **The suspicious-empty-sweep guard is per source.** A model that answers `[]`
  when the MCP is momentarily down would otherwise blank the Cockpit countdown,
  so an empty result that contradicts still-upcoming rows *for that source*
  keeps the existing rows and reports an error. It must never consult or
  protect another source's rows — a flaky work calendar excused by a healthy
  personal one is exactly the bug the scoping exists to prevent.
- **One run key for all sources.** Everything is recorded under the single
  `claude:calendar` key (per-source failures become `<id>: <error>` notes in
  the message). The frontend's collector list, the app's stale-collector watch
  and the store's run-pruning all match that literal, so a per-source key
  (`claude:calendar:google`) would need changes in all three before it could
  work.

## Slack: this crate has the protocol, not the socket

`slack_socket.rs` here is pure, unit-tested envelope/backoff/ack logic —
deliberately Tauri-free. The actual WebSocket I/O, reconnect loop, and the
cross-task singleton lock that keeps N open worktrees from each opening
a duplicate Socket Mode connection all live in
[`crates-tauri/tt-app/src/slack_socket.rs`](../../crates-tauri/tt-app/CLAUDE.md)
(see that crate's `InstanceLock` section) — that's the file to read for the
connection-lifecycle half of this feature.
