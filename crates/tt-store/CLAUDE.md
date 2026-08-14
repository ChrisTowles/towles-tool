# CLAUDE.md — crates/tt-store

The SQLite store behind `tt.db`: calendar events, board tasks and their
issue/PR links, the GitHub issue/PR caches, collector-run freshness, and the
day-model attention watchers. Tauri-free — the app, the CLI and the MCP server
all open the same file. Clocks are injected as `now_ms`; nothing here reads one.

Modules: `schema` (DDL + migrations + `Store::open*`), `model` (the structs and
pure helpers), `events` (calendar), `tasks` (board tasks + links + worktree
binding), `github` (issue/PR caches, tracked-repo identities), `collect`
(collector runs, DMs, MCP call log, the aggregate snapshot), `attention`
(notification edge detection).

**`lib.rs` is ~60 lines of code and ~2,280 lines of tests.** The `Store` impl
lives in the modules above, not there — don't go looking for it in the big file.

## Time: epoch ms, except calendar events

Everything is epoch milliseconds passed in by the caller. Calendar events are
the exception: `starts_at`/`ends_at` are RFC 3339 text keeping the offset the
calendar reported, because an integer can say *when* a meeting is but not that
it was booked as 3pm London.

**Never sort or range on the authored column.** Lexical order across offsets is
not chronological (`…T09:00:00-05:00` sorts before `…T10:00:00+01:00` while
being an hour later). The STORED generated `starts_at_utc`/`ends_at_utc`
columns are the sort/range key, and `model::UTC_KEY_FORMAT` must match the
DDL's `strftime` byte for byte — a test asserts it, because a mismatch makes
range queries silently return wrong rows rather than fail.

## Migrations

One `Store::migrate`, run on every open, idempotent — `SCHEMA_V1`'s
`IF NOT EXISTS` batch, then a run of additive `ALTER TABLE ADD COLUMN` steps
that check the current table shape. **A new column goes at the end of that run,
never folded into `SCHEMA_V1`**: `CREATE TABLE IF NOT EXISTS` is a no-op on an
existing db, which would then silently lack the column.

**There is a floor, not an unbounded upgrade path.** `MIN_SUPPORTED_VERSION`
(16) is the oldest db `Store::open` accepts; below it, `check_version_floor`
returns `Error::SchemaTooOld` telling the user to delete the file. The
rebuild-style migrations (`CREATE TABLE tasks_vN` + `INSERT … SELECT <fixed
column list>`) that once carried a v1 db forward are gone. If you ever add one
back, it must run *before* the additive steps — a rebuild's fixed column list
silently drops any column added ahead of it.

## Concurrency

The file is open in several processes at once (app UI, the app's collector
scheduler, the CLI, MCP). `Store::open` sets WAL plus a 5s busy timeout so
their writes interleave instead of failing with `SQLITE_BUSY`. Anything doing a
multi-statement write wraps it in a transaction.

## Dismissal is user state, so it never lives on a collector-owned row

`replace_issues`/`replace_*_prs*` are **full swaps** — the collector deletes the
rows it owns and reinserts the snapshot. Dismissals therefore cannot live on
those rows; they live in `item_dismissals` (`kind`, `repo`, `number`) and are
joined at read time. Move a dismissal onto a collector-owned row and every
sweep un-hides what the user hid.

DM dismissals go one step further: tt.db itself is *instance* state (one per
checkout scope), but the watched DM is one shared conversation, so its handled
state lives in the shared ledger at `tt_config::dm_dismissals_path()`
(`channel` → highest handled message ts). `dismiss_dm` writes it and `dms()`
overlays it; the `dm_status.dismissed_ts` column is dead. Kept in tt.db, a
dismissal evaporated whenever the next launch resolved a different scope (dock
vs terminal vs task worktree) and the handled message re-raised its banner.
`Store::open` defaults the ledger next to the db (hermetic for tests);
`open_default` points it at the shared path.

## `attention.rs` — read the module doc, don't re-derive it

Four independent edge watchers (`MeetingStartWatch`, `ReviewRequestedWatch`,
`ChecksFailedWatch`, `StaleCollectorWatch`) turning successive store reads into
"this newly deserves attention" edges. The module doc in the file is the
authoritative description of each one; it is not repeated here.

What to know before touching it: the only consumer is
`crates-tauri/tt-app/src/scheduler.rs`'s `run_notify_check`, and each watcher
maps 1:1 to a desktop notification with its own `tt_config::NotifyKind` and its
own suppression policy — so the four are not collapsible into one. The per-key
state exists to make notifications *edge*-triggered rather than level-triggered:
`primed` suppresses the first observation (a PR already red, or a collector
already broken, at launch), the previous-set / `prev_stale` fields stop a
persisting condition re-firing every tick, and recovery clears the state so a
later break fires again. Drop any of those and the scheduler's 15s notify tick
turns one broken collector into a notification storm. The tests in the file are the
spec for that guarantee — extend them, don't relax them.

`StaleCollectorWatch` carries two more fields for reasons that aren't visible
from the type: `last_seen_ran_at` because run rows are *upserted*, so a changed
`ran_at` is the only signal that a new run happened at all, and `fail_streak`
because a collector that fails outright would otherwise stay quiet until its
age threshold (4× cadence) elapsed — 40 minutes for `issues`.

Agent status has its own, separate watcher (`tt_agentboard::NeedsYouWatch`);
the app header and Agentboard needs-you feed read snapshots, not these edges.

## Board tasks: closed, not deleted

A finished task row is *closed* (`outcome`, `worktree_dir` cleared) and later
archived, not deleted; `delete_task` exists only for the Board's explicit
"Delete permanently". The lifecycle and the removal ordering it participates in
are documented in the root [CLAUDE.md](../../CLAUDE.md) (Worktree tasks) and
owned by `tt_agentboard::task_removal`.
