# CLAUDE.md — crates-tauri/tt-app

Tauri 2 desktop shell — the root [`CLAUDE.md`](../../CLAUDE.md) says what this
crate is (identifier, dev-port picking, task labeling). This file is the internal
invariants a single read won't surface: it is the largest crate in the repo
(~6,100 lines / 20 modules), and most of what follows spans several files.

## Locking and ordering

- **Never hold the agentboard `Engine` lock across git work.** `lib.rs`'s scan
  task and stat-poll both do git work *outside* `engine.lock()` deliberately: on
  Linux, sync Tauri commands dispatch inline on the GTK main thread, so a lock
  held across a git chain freezes every `ab_*` command, not just the caller. Git
  reads being in-process (`tt_git::repo`, gitoxide) makes them ~10–100× faster
  but not free — a status walk over a large tree is still real work.
- **Git freshness has three rules, each with a bug behind it, and the reasoning
  is in [docs/GIT-FRESHNESS.md](../../docs/GIT-FRESHNESS.md) — read it before
  touching the warm loop or either watcher.** Stamp a cache entry with the time
  its batch *finished*, never the `now` it was scheduled with (the other way
  round is an unbounded recompute loop that looks fine at a glance). Scope the
  `~/.claude/projects` fs-notify accelerant to tracked checkouts via
  `ScopedDirNotifier`, never the whole tree, and resolve transcript dirs only
  through `watchers::claude_code::encode_project_dir_name`. And keep git-info
  refresh **event-driven with polling as the backup**: the `MultiFileNotifier`
  over `git_info::control_files` is the primary signal, `GIT_CACHE_TTL_MS` is a
  60s ceiling for a missed event — if stats lag, fix the watch, don't shorten the
  TTL. Both pollers must gate on the same `stale_git_targets` or one defeats the
  other's savings.
- **Every `StatePayload` leaving the app must pass through `stamp_pty_state`**
  (`agentboard.rs`). The Tauri-free engine can't see PTYs, so a new command that
  returns a `StatePayload` without the stamp silently reports stale
  `live`/`shellKind`/needs-you counts, and a stale agent *status* too.
- **Agent status is PTY-first; `claude agents` is only a fallback.**
  `stamp_pty_state` folds `tt_agentboard::pty_status::resolve_status` over the
  engine's verdict, which comes from a `claude agents --all --json` snapshot
  cached for 60s that nothing else could contradict. The terminal can: output
  that is recent (1.5s) **and has been running for a second** proves the agent is
  working, and 20s of silence proves it isn't (Claude Code repaints a live
  elapsed counter throughout a turn — measured max gap 0.27s). Both halves of the
  working test are load-bearing: a *finished* pane still repaints every second or
  two, so recency alone reads those twitches as work — flickering the needs-you
  banner, discarding the turn-end `OSC 777` as superseded, and flapping
  `busy`/`complete` so `needs_since_ms` resets before the waiting-age counts up.
  Signals come from `PtyActivity` in `terminal.rs`, stamped on the vt sink's
  `Frame` (output) and `Notify`/`Bell` (Claude Code's `OSC 777`, the fastest
  evidence of a blocked agent). **Every path that writes to a PTY on the user's
  behalf must stamp `input_at_ms`** — that marks an attention notification
  answered; miss it and the session stays badged after the user has replied.
- **PTY replacement is generation-checked** (`terminal.rs`), so a stale EOF from
  a killed/replaced session can never close its successor. Treat `TermState`'s
  lock as map-surgery-only — never hold it across anything that can block.
- **`task_delete` kills a folder's PTYs before touching its worktree on disk —
  but only once the removal guards have passed** (via `ops::remove_task`'s
  `before_removal` hook, `tasks.rs`). Both halves matter for any new
  task-mutating command: kill before deleting or you orphan a shell pointed at a
  deleted cwd; kill only past the guards or a *refused* removal costs a live
  session the guard existed to protect.
- **Task-status mutations must route through `spawn_gh_status_sync`**
  (`store.rs`) — the single call site for gh close/reopen, added after a real
  drift bug (#246). Don't add a second path that flips status without it.
- **`ab_save_windows`/`ab_save_collapsed` deliberately skip re-emitting state**
  (`agentboard.rs`), unlike every other mutator, to avoid clobbering rapid
  client-side edits. Match this for another client-authoritative setter.

## Singletons and cross-task state

- **`tauri.conf.json` has no `enableGTKAppId`, deliberately — do not re-add it.**
  With it on, `tao` registers a D-Bus-activatable GTK `Application`, and **any**
  activation of that name (a dock icon click, `gio launch`, systemd, a bare
  `gdbus` `Activate`) re-enters Tauri's `setup()` — no re-entrancy guard — and
  panics rebuilding the `"main"` webview (tauri-2.11.5). Reproduced with zero
  second process involved, so a per-task identifier narrows the collision surface
  but can't close it; only no app-id does, since then `tao` never registers a bus
  name. The identifier is still patched per-task at runtime (`lib.rs`'s
  `app_identifier`) so `linux_desktop::ensure_installed`'s `.desktop` entry and
  icon get their own filename per task.
- **`InstanceLock` is a generic, PID-tagged file lock** (`instance_lock.rs`)
  reused for two unrelated purposes; the name passed to `try_acquire` decides
  scope. `"slack-socket"` (`slack_socket.rs`) is **shared, cross-task** — every
  open task reads the same Slack token, and without the guard N tasks each open a
  duplicate Socket Mode websocket on it. `"app-<identifier>"` (`lib.rs`'s `run`)
  is **per-checkout**: with no D-Bus single-instance registration, nothing else
  stops one checkout launching twice and duplicating windows/PTYs/scheduler
  polling. A second launch prints "already running" and exits — a
  resource-duplication guard, not the crash fix.
- **Nested shells get their env scrubbed and re-stamped** (`terminal.rs`, issue
  #39), so a `tt-app` or `bun run dev` launched *inside* an embedded terminal
  doesn't collide with the outer instance's port/session identity.
  `CLAUDE_CODE_SSE_PORT` is re-stamped for deterministic IDE pairing even with
  several tasks open — don't drop this to "simplify" terminal spawning.
- **The scheduler's watchers/in-flight guards persist across a settings-reload
  rebuild** (`scheduler.rs`), and a failed `claude:calendar` run still counts as
  "recent" — this avoids re-billing tokens on relaunch.
- **An external process can force an eager `prs` or `issues` collect via the
  nudge dir** (`tt_config::nudge_dir_path()`, watched in `scheduler.rs`).
  `tt task nudge prs`/`issues` is the write side — a plain filesystem touch, no
  store I/O — and the plugin's `gh pr`/`gh issue` hook is the only caller today.
  The dir is *separate* from `data_dir()` so the watch isn't spammed by tt.db's
  WAL/SHM churn. `DirNotifier` only signals "something changed", so
  `changed_nudge_batches` diffs each target's mtime to resolve specific batches,
  which reuse `spawn_batch`/`guards.{prs,issues}` so a nudge can't stack a
  duplicate run alongside that collector's own tick. Watcher construction is
  `.ok()`-swallowed like every `DirNotifier` use — a failed watch falls back to
  the poll cadence, never breaks startup. **The dir is machine-global**
  (`nudge_dir_path` nests only under a forced `TT_STATE_SCOPE`, so the writer's
  cwd can never split it from the watchers), so each note names the
  `TT_SESSION_ID` that wrote it and `note_is_mine` drops other instances' —
  otherwise one `gh pr create` makes every open window sweep `gh`. A note naming
  nobody still fires everywhere, and `NudgeSeen` advances even for a skipped note
  so it is rejected once rather than re-read on every wakeup.

## IDE bridge, telemetry, and the rest

- **The IDE server serves multiple concurrent connections per terminal**
  (`ide.rs`) — a Claude Code ≥2.1 session is a TUI process *and* a session
  daemon, both dialing in. It answers a deliberately small slice of the
  protocol; the editor half is code-server's
  ([docs/CLAUDE-CODE-IDE.md](../../docs/CLAUDE-CODE-IDE.md)).
- **Every `#[tauri::command]` triggered by an explicit user gesture must emit its
  own `tracing` event.** The naming, outcome-recording and never-log-content
  rules are in **[docs/TELEMETRY.md](../../docs/TELEMETRY.md)**; this is not
  optional, and it is where "feature unused" gets told from "feature
  uninstrumented".
- **`TT_NO_FOCUS_STEAL` skips OS focus-steal on launch** (`lib.rs`'s `run`):
  every window config's `focus` flips to `false` before `context` reaches the
  builder. `scripts/dev-drive.mjs` and `scripts/e2e.mjs` set it — test launches,
  never the user sitting down to work. Deliberately a runtime env var, not
  `#[cfg(feature = "wdio")]`, which means "wdio plugins compiled in".
- **OSC 52 clipboard writes are gated on terminal focus** (`terminal.rs`) — a
  background agent pane can't hijack the system clipboard.
- `WEBKIT_DISABLE_DMABUF_RENDERER` (`lib.rs`, Linux-only) works around a
  WebKitGTK/NVIDIA rendering bug (tauri-apps/tauri#9304) — set it only when
  NVIDIA is actually driving the screen, and never override a user setting.
- **Linux app-id / desktop-entry self-registration** (`linux_desktop.rs`): the
  daily-driver flow (`bun start`) runs `tauri build --no-bundle` and execs the
  raw binary, skipping the packaging step that would write a `.desktop` file and
  themed icon. `ensure_installed` (from `.setup()`) self-registers both into
  `~/.local/share/{applications,icons}` on every startup, idempotently, one pair
  per task. `StartupWMClass` is the constant binary name (`tt-app`), not the
  per-task identifier — `enableGTKAppId` is off, so the real WM_CLASS is GTK's
  default and matching on the identifier would never resolve. The dock icon is
  best-effort; the launcher entry's icon is exact.
