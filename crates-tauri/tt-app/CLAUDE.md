# CLAUDE.md — crates-tauri/tt-app

Tauri 2 desktop shell — see the root [`CLAUDE.md`](../../CLAUDE.md) for what
this crate is (identifier, dev-port picking, task labeling). This file is
the internal invariants a single read of the code won't surface: it's the
largest crate in the repo (~6,100 lines / 20 modules), and most of what
follows is a cross-cutting rule that spans multiple files.

## Locking and ordering

- **Never hold the agentboard `Engine` lock across git work.**
  `lib.rs`'s scan task and stat-poll both do git work *outside*
  `engine.lock()` deliberately — on Linux, sync Tauri commands dispatch
  inline on the GTK main thread, so a lock held across a git chain would
  freeze every `ab_*` command, not just the caller. Git reads are in-process
  now (`tt_git::repo`, gitoxide) rather than subprocesses, which makes them
  ~10–100× faster but does not make them free: a status walk over a large
  working tree is still real work, and the rule stands unchanged.
- **Stamp a cache entry with the time its batch *finished*, never the `now`
  the work was scheduled with.** `lib.rs`'s git warm loop takes a fresh
  `now_ms()` *after* `compute_git_info` returns. Reusing the pre-batch `now`
  makes every entry born older than `GIT_CACHE_TTL_MS` the moment a batch
  outruns the TTL, so the next tick finds it stale and recomputes immediately —
  a loop with no upper bound. It ran at ~20 git spawns/sec around the clock and
  wrote ~1 GB/day of telemetry before anyone noticed, because nothing about it
  looks wrong at a glance. The cost is bounded structurally as well:
  `compute_git_info` takes the folder's previous `GitInfo` and skips the
  landing probe when `probe_key` (HEAD sha + base sha + upstream-gone) is
  unchanged, so an idle repo costs three cheap reads instead of a full
  patch-identity probe. `is_worktree`/`common_dir`/`worktree_dirs`/
  `origin_url` get the same treatment for a different reason — they're
  structural facts (a repo's sibling worktrees, its remote), not working-tree
  state, so they're memoized off two file mtimes (`structural_key`) instead
  of re-derived every poll. All three halves are pinned by tests in
  `git_info.rs` — keep them if you touch any.
- **The `~/.claude/projects` fs-notify accelerant is scoped to tracked
  checkouts, not the whole tree.** `lib.rs`'s scan loop watches via
  `ScopedDirNotifier` (`tt_agentboard::fs_notify`), whose `set_targets` is
  called every scan tick with `Engine::watch_targets()` (tracked repos plus
  discovered worktrees). A plain `DirNotifier` on `projects_dir` — the
  original design — fires the eager rescan on *any* Claude Code session's
  transcript write anywhere on the machine, this repo's own session
  included; on a machine running several concurrent sessions that reduces
  the "accelerant" to "rescan constantly," fighting the exact poll cadence
  it exists to shortcut. Each tracked dir maps to its transcript directory
  via `watchers::claude_code::encode_project_dir_name` (`/`, `.`, `_` → `-`,
  verified against real `~/.claude/projects` entries — a worktree checkout's
  `.claude/worktrees/...` segment is exactly the case a naive `/`→`-`-only
  guess used to miss). Don't revert to watching `projects_dir` directly, and
  don't recompute `encode_project_dir_name`'s rule ad hoc elsewhere — it's
  also what `find_journal` uses to resolve a session's journal.
- **Git-info refresh is event-driven, with polling as the backup, not the
  other way around.** `commits_ahead`/`commits_behind`/`landed` depend on
  exactly five `.git` internal files per checkout (`HEAD`, `index`,
  `packed-refs`, `refs/heads/<branch>`, `refs/remotes/origin/<base>` — see
  `git_info::control_files`'s doc). `lib.rs`'s scan loop watches those via a
  `MultiFileNotifier` (`git_watcher`), rebuilt each tick from `Engine::
  control_watch_files()` the same way `ScopedDirNotifier` above is; on a real
  change it calls `Engine::invalidate_git(dir)` (stamp → 0, bypassing the TTL
  entirely) and wakes the scan loop, so a commit/fetch/branch-switch/`git add`
  in a tracked repo recomputes that repo's stats within one tick (measured:
  ~4s, nowhere near the TTL). `GIT_CACHE_TTL_MS` (`git_info.rs`) is 60s
  specifically *because* it's a backup ceiling for a missed event, not the
  primary driver — don't shorten it back down to compensate for a watch gap;
  fix the watch instead. The 10s "git-stat poll" (the second, independent
  poller) gates on `stale_git_targets` too — both loops must respect the same
  staleness signal or one silently defeats the other's savings. Before adding
  a control file: a registered path's parent directory **may not exist**
  (`git pack-refs --prune` deletes a loose slashed ref *and* its emptied
  parent dir); `MultiFileNotifier::add` watches the nearest existing
  ancestor — never pre-create directories inside someone's `.git`.
  **What this deliberately does not cover**: `dirty` and the `uncommitted_*`
  stats measure the *working tree*, and an edited-but-unstaged file never
  touches any of the five watched files — `index` only moves on `git add`/
  `commit`/`reset`. A cheap fs-watch fix doesn't exist (it would mean a
  recursive, gitignore-aware watch of the whole tree — the inotify-cost
  problem `MultiFileNotifier`'s own doc warns about), which is why the 60s
  poll backup still matters for those fields.
- **Every `StatePayload` leaving the app must pass through
  `stamp_pty_state`** (`agentboard.rs`). The Tauri-free engine can't see
  PTYs, so a new command that builds/returns a `StatePayload` without this
  stamp silently reports stale `live`/`shellKind`/needs-you counts — and,
  since the PTY-status cutover, a stale agent *status* too.
- **Agent status is PTY-first; `claude agents` is only a fallback.**
  `stamp_pty_state` folds `tt_agentboard::pty_status::resolve_status` over
  the engine's verdict, because that verdict comes from a `claude agents
  --all --json` snapshot cached for 60s and nothing else could contradict
  it. The terminal can: output that is recent (1.5s) **and has been running
  for a second** proves the agent is working, and 20s of silence proves it
  isn't (Claude Code repaints a live elapsed counter throughout a turn —
  measured max gap 0.27s). Both halves of the working test are load-bearing:
  a *finished* pane still repaints every second or two, so recency alone
  reads those twitches as work — flickering the needs-you banner, discarding
  the turn-end `OSC 777` as superseded, and flapping `busy`/`complete` so
  `needs_since_ms` reset before the waiting-age ever counted up.
  The signals come from `PtyActivity` in `terminal.rs`, stamped on the vt
  sink's `Frame` (output) and `Notify`/`Bell` (Claude Code's `OSC 777`
  attention notification, which is *the* fastest evidence of a blocked
  agent and used to be spent on a toast). **Every path that writes to a PTY
  on the user's behalf must stamp `input_at_ms`** — that is what marks an
  attention notification answered; miss it and the session stays badged
  after the user has replied.
- **PTY replacement is generation-checked** (`terminal.rs`), so a stale EOF
  from a killed/replaced session can never close its successor. Treat
  `TermState`'s lock as map-surgery-only — don't hold it across anything
  that can block.
- **`task_delete` kills a folder's PTYs before touching its worktree on
  disk — but only once the removal guards have passed** (via
  `ops::remove_task`'s `before_removal` hook, `tasks.rs`). Both halves are
  load-bearing for any new task-mutating command: kill before deleting or
  you'll orphan a shell pointed at a deleted cwd; kill only past the guards
  or a *refused* removal costs a live session the guard existed to protect.
- **Task-status mutations must route through `spawn_gh_status_sync`**
  (`store.rs`) — the single call site for gh close/reopen, added after a
  real drift bug (#246). Don't add a second path that flips status without
  it.
- **`ab_save_windows`/`ab_save_collapsed` deliberately skip re-emitting
  state** (`agentboard.rs`), unlike every other mutator, to avoid
  clobbering rapid client-side edits. Match this if you add another
  purely-client-authoritative setter.

## Singletons and cross-task state

- **`tauri.conf.json` has no `enableGTKAppId`, deliberately — do not re-add
  it.** With it on, `tao` registers a D-Bus-activatable GTK `Application`,
  and **any** activation of that name (a dock/taskbar icon click,
  `gio launch`, systemd, a bare `gdbus` `Activate` call) re-enters Tauri's
  `setup()` — no re-entrancy guard — and panics rebuilding the config's
  `"main"` webview (`a webview with label 'main' already exists`,
  tauri-2.11.5). Reproduced live with zero second process involved, so a
  per-task identifier narrows the collision surface but can't close it; only
  no app-id does, since then `tao` never registers a bus name at all. The
  identifier is still patched per-task at runtime (`lib.rs`'s
  `app_identifier`) so `linux_desktop::ensure_installed`'s self-installed
  `.desktop` entry/icon get their own filename per task.
- **`InstanceLock` is a generic, PID-tagged file lock** (`instance_lock.rs`)
  reused for two unrelated purposes — the name passed to `try_acquire`
  decides the holder's scope:
  - `"slack-socket"` (`slack_socket.rs`) is **shared, cross-task**: every
    open task reads the same Slack token, and without this guard N open
    tasks would each open a duplicate Socket Mode websocket on it.
  - `"app-<identifier>"` (`lib.rs`'s `run`) is **per-checkout**: with no
    D-Bus single-instance registration (see above), nothing else stops the
    same checkout launching twice and duplicating windows/PTYs/scheduler
    polling. A second launch prints "already running" and exits — a
    resource-duplication guard, not the crash fix.
- **Nested shells get their env scrubbed and re-stamped** (`terminal.rs`,
  issue #39): a `tt-app` or `npm run dev` launched *inside* an embedded
  terminal doesn't collide with the outer instance's port/session identity.
  `CLAUDE_CODE_SSE_PORT` is re-stamped for deterministic IDE pairing even
  with several tasks open — don't strip this scrubbing step to "simplify"
  terminal spawning.
- **The scheduler's watchers/in-flight guards persist across a
  settings-reload rebuild** (`scheduler.rs`), and a failed `claude:calendar`
  run still counts as "recent" — this avoids re-billing tokens on relaunch.
- **An external process can force an eager `prs` or `issues` collect via the
  nudge dir** (`tt_config::nudge_dir_path()`, watched in `scheduler.rs` via
  `tt_agentboard::fs_notify::DirNotifier`, same accelerant pattern as the
  agentboard journal watch in `lib.rs`). `tt task nudge prs`/`tt task nudge
  issues` (a plain filesystem touch, no store I/O) is the write side —
  the `towles-tool-app` Claude Code plugin's `gh pr`/`gh issue` mutation hook
  is the only current caller. It's a directory *separate* from `data_dir()`
  itself deliberately, so the watch isn't spammed by tt.db's own WAL/SHM
  churn. The `DirNotifier` callback only signals "something in the dir
  changed" — it can't tell which file — so `changed_nudge_batches` diffs each
  target's file mtime against what it last saw to resolve that into specific
  batches, which reuse `spawn_batch`/`guards.{prs,issues}` so a nudge can't
  stack a duplicate run alongside that collector's own tick. The watcher
  construction is `.ok()`-swallowed like every other `DirNotifier` use — a
  failed watch (e.g. inotify limits) just falls back to the normal poll
  cadence, never breaks startup.
  **The dir is machine-global** (`nudge_dir_path` nests only under a forced
  `TT_STATE_SCOPE`, so the writer's cwd — often a tracked repo that isn't a
  checkout of this one — can never split it from the watchers), so each note
  names the `TT_SESSION_ID` that wrote it and
  `note_is_mine` drops the ones belonging to another instance's terminal —
  otherwise one `gh pr create` makes every open window sweep `gh`. A note
  naming nobody (a session started outside an app terminal) still fires
  everywhere, and `NudgeSeen` advances even for a skipped note so it is
  rejected once rather than re-read on every wakeup.

## IDE bridge

- **The IDE server serves multiple concurrent connections per terminal**
  (`ide.rs`) — a Claude Code ≥2.1 session is a TUI process *and* a session
  daemon, both dialing in.
- **`openDiff` replies are deferred through a channel that auto-rejects on
  drop**, so a torn-down pane can never hang the CLI waiting on a review
  decision.

## Telemetry (required for user-gesture commands)

- **Every `#[tauri::command]` triggered by an explicit user gesture must emit
  its own `tracing` event** — a mutation, a confirm, a delete, or an action
  that signals a process. This is the backend half of the root CLAUDE.md's
  "every user action emits its OTel event" mandate (see the `tt-telemetry` bullet
  there), and it is not optional: without it the command is invisible in the
  on-disk event log, and "feature unused" can't be told from "feature
  uninstrumented" (the gap #363 fixed across ~all `ab_*`/`store_*`/task/
  slack/settings/cockpit/ide commands). The rules:
  - **Name the event for *what changed*, `noun.verb`** (`task.created`,
    `repo.identity_set`, `session.closed`, `task.created`) — never reuse
    `ui.action`. The frontend click already emitted a `ui.action`; a backend
    event with the same name double-counts the gesture. The two are
    complementary: `ui.action` records the intent, the command event records
    the outcome (and catches invocations that never came from a click).
  - **Record the outcome, not just that it ran** — a `changed`/`count` field,
    a `from`/`to` pair, or a `started`/`already_running`/`blocked` discriminant
    where the command can no-op or be refused (see `store_collect_now`,
    `task_delete`). Log after the mutation succeeds; a longer-running command
    that can end three ways uses a span with an `outcome` field
    (`task_delete`, `task_stop_port`).
  - **Never log content or continuous input** — no note/message/prompt text,
    no per-keystroke/mouse/scroll/resize/PTY-write events. That's why
    `slack_dm_send` logs `slack.dm_sent` with *no* text, and the `term_*`
    input commands emit nothing (the PTY *spawn* is recorded in `term_start`
    via `tt_exec::record_detached_spawn`, the *kill* in `term_kill`).
  - **Don't instrument pure reads/pollers** (`*_get`/`*_snapshot`/`ab_get_*`/
    `app_resource_usage`) — over-logging buries the signal. A command that already shells
    out through `tt_exec` (every `gh`/`git`) is covered by that `process.spawn`
    span, but still add a semantic event when the *user gesture* itself is
    what you want to be able to query for.

## Misc

- **`TT_NO_FOCUS_STEAL` skips OS focus-steal on launch** (`lib.rs`'s `run`):
  when set, every window config's `focus` flips to `false` before `context`
  reaches the builder. `scripts/dev-drive.mjs` and `scripts/e2e.mjs` set it —
  test launches, never the user sitting down to use the app. Deliberately a
  runtime env var, not `#[cfg(feature = "wdio")]`, which means "wdio plugins
  compiled in," a different concern.
- **OSC 52 clipboard writes are gated on terminal focus** (`terminal.rs`) —
  a background agent pane can't hijack the system clipboard.
- The `WEBKIT_DISABLE_DMABUF_RENDERER` env var (`lib.rs`, Linux-only) works
  around a WebKitGTK/NVIDIA rendering bug (tauri-apps/tauri#9304) — only set
  when NVIDIA is actually driving the screen, and never override an
  explicit user setting.
- **Linux app-id / desktop-entry self-registration** (`linux_desktop.rs`):
  the daily-driver flow (`npm start`) runs `tauri build --no-bundle` and
  execs the raw binary, skipping the packaging step that would write a
  `.desktop` file + themed icon for GNOME/COSMIC. `linux_desktop::
  ensure_installed` (called from `.setup()`) self-registers both into
  `~/.local/share/{applications,icons}` on every startup instead,
  idempotently, one pair per task (keyed by the per-task identifier).
  `StartupWMClass` is the constant binary name (`tt-app`), not the per-task
  identifier — `enableGTKAppId` is off (see above), so the real WM_CLASS is
  GTK's default and matching on the identifier would never resolve; the dock
  icon is best-effort, the launcher/search entry's icon exact.
