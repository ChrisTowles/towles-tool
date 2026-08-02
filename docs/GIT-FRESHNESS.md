# Keeping agentboard's git stats fresh

Why the caching and watching in `crates-tauri/tt-app/src/lib.rs` is shaped the
way it is. The rules themselves are in
[`crates-tauri/tt-app/CLAUDE.md`](../crates-tauri/tt-app/CLAUDE.md); this is the
reasoning behind them, and each one has a bug behind it.

## Stamp a cache entry when its batch *finished*

`lib.rs`'s git warm loop takes a fresh `now_ms()` *after* `compute_git_info`
returns. Reusing the pre-batch `now` makes every entry born older than
`GIT_CACHE_TTL_MS` the moment a batch outruns the TTL, so the next tick finds it
stale and recomputes immediately — a loop with no upper bound. It ran at ~20 git
spawns/sec around the clock and wrote ~1 GB/day of telemetry before anyone
noticed, because nothing about it looks wrong at a glance.

Cost is bounded structurally too. `compute_git_info` takes the folder's previous
`GitInfo` and skips the landing probe when `probe_key` (HEAD sha + base sha +
upstream-gone) is unchanged, so an idle repo costs three cheap reads instead of a
full patch-identity probe. `is_worktree`/`common_dir`/`worktree_dirs`/`origin_url`
get the same treatment for a different reason — they are structural facts (a
repo's sibling worktrees, its remote), not working-tree state, so they are
memoized off two file mtimes (`structural_key`) rather than re-derived per poll.
All three halves are pinned by tests in `git_info.rs`.

## Scope the `~/.claude/projects` accelerant to tracked checkouts

The scan loop watches via `ScopedDirNotifier` (`tt_agentboard::fs_notify`), whose
`set_targets` is called every tick with `Engine::watch_targets()` (tracked repos
plus discovered worktrees). A plain `DirNotifier` on `projects_dir` — the
original design — fires the eager rescan on *any* Claude Code session's
transcript write anywhere on the machine, this repo's own session included; on a
machine running several concurrent sessions that reduces the "accelerant" to
"rescan constantly", fighting the exact poll cadence it exists to shortcut.

Each tracked dir maps to its transcript directory via
`watchers::claude_code::encode_project_dir_name` (`/`, `.`, `_` → `-`, verified
against real `~/.claude/projects` entries — a worktree checkout's
`.claude/worktrees/...` segment is exactly the case a naive `/`→`-`-only guess
used to miss). Don't recompute that rule ad hoc elsewhere: `find_journal` uses it
to resolve a session's journal.

## Event-driven refresh, with polling as the backup

`commits_ahead`/`commits_behind`/`landed` depend on exactly five `.git` internal
files per checkout (`HEAD`, `index`, `packed-refs`, `refs/heads/<branch>`,
`refs/remotes/origin/<base>` — see `git_info::control_files`'s doc). The scan
loop watches those via a `MultiFileNotifier` (`git_watcher`), rebuilt each tick
from `Engine::control_watch_files()`; on a real change it calls
`Engine::invalidate_git(dir)` — stamp → 0, bypassing the TTL entirely — and wakes
the scan loop, so a commit, fetch, branch switch or `git add` in a tracked repo
recomputes that repo's stats within one tick (measured ~4s, nowhere near the
TTL).

`GIT_CACHE_TTL_MS` is 60s specifically *because* it is a backup ceiling for a
missed event, not the primary driver. The 10s git-stat poll — a second,
independent poller — gates on `stale_git_targets` too; both loops must respect
the same staleness signal or one silently defeats the other's savings.

Before adding a control file: a registered path's parent directory **may not
exist** (`git pack-refs --prune` deletes a loose slashed ref *and* its emptied
parent dir), and `MultiFileNotifier::add` watches the nearest existing ancestor.
Never pre-create directories inside someone's `.git`.

**What this deliberately does not cover:** `dirty` and the `uncommitted_*` stats
measure the *working tree*, and an edited-but-unstaged file never touches any of
the five watched files — `index` only moves on `git add`/`commit`/`reset`. A
cheap fs-watch fix doesn't exist (it would mean a recursive, gitignore-aware
watch of the whole tree — the inotify-cost problem `MultiFileNotifier`'s own doc
warns about), which is why the 60s poll backup still matters for those fields.
