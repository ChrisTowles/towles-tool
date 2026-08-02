# Telemetry

What is recorded, why every user action has to be, and what the Telemetry
screen makes of it. The rule itself is in [CLAUDE.md](../CLAUDE.md); this is the
mechanism.

telemetry: the `tracing` subscriber/writer and the reader
behind the app's Telemetry screen, one crate so both halves can never
disagree about the on-disk schema. `tt_telemetry::init` installs the global `tracing`
subscriber for both binaries (it replaced `env_logger` — a hard cutover,
no second logger), fanning out to stderr (filtered by `-v`/`RUST_LOG`) and
to an **event log on disk**: one JSON object per line at
`<data_dir>/telemetry/events-<date>.jsonl`, rotated daily, 14 days kept.
The disk sink records at `debug` regardless of `RUST_LOG` — a quiet
terminal must not mean a useless log — and every record carries OTel
resource attributes including `tt.task`, so a line is attributable to the
checkout that produced it. `TT_TELEMETRY=0` disables the disk sink.
**Every subprocess is logged**, in one of two shapes depending on its
lifecycle. Run-to-completion spawns (`gh`, `git`, `claude` — everything
going through `tt-exec`'s three run paths) open a `process.spawn` span
carrying `process.executable.name`, `process.command_args`,
`process.working_directory`, `duration_ms`, `exit_code`, and `outcome`
(`ok`/`non_zero_exit`/`timed_out`/`spawn_failed`). Spawns that outlive the
call and have no exit code to wait for — the PTY behind every terminal,
`rust-analyzer`, a detached editor — can't use that shape, so they call
`tt_exec::record_detached_spawn(cmd, args, kind)` instead and emit a single
event. **A new spawn site must use one or the other**, or it is invisible
in the log; a bare `Command::new` is the one way to break the "what did
this launch?" guarantee. Add instrumentation with `tracing` spans, not
`log::` calls; existing `log::` sites still flow in via the subscriber's
`tracing-log` bridge.
**Every user-initiated action must be logged too, not just subprocesses**
— the log is only useful for answering "where did my attention go" if it
is a complete record, and it never leaves the machine. A new Tauri command triggered by
an explicit user gesture (a click, a confirm, a delete, a shortcut that
mutates state) needs a `tracing` span or event recording at least the
action and its outcome — the same way `process.spawn` covers subprocesses.
Frontend actions (click, shortcut, palette command, form submit) emit a
`ui.action` event carrying a stable action id, the screen, and an
optional word of `detail`; since the webview can't reach `tracing`, they
cross IPC through one shared seam — `uiAction(action, screen, detail?)` in
`apps/client/src/lib/ui-action.ts` → the `ui_action` command in
`tt-app/src/lib.rs` — never per-feature ad-hoc plumbing. A backend
command's own span should record what changed and be named for that
(`repo.identity_set`), not `ui.action` — the click already emitted one, and
reusing the name double-counts the action. Discrete intents
only, never content or
continuous input: no per-keystroke or mouse-move events, no PTY input, no
note text (the log is plaintext, and per-record flushing assumes
human-rate volume). OS-level signals with no other record — window focus/blur
(`WindowEvent::Focused` in `lib.rs`), a native notification actually
firing (`agentboard::notify_needs_you`) — get the same treatment, since
they're exactly the kind of thing that's impossible to reconstruct after
the fact otherwise (a real incident: `task_delete`'s ~1-minute worktree
removal appeared to "steal focus" on completion, and there was no way to
tell from the log alone whether the window itself ever regained OS focus,
an unrelated needs-you notification fired at the same moment, or neither
— all three now emit `window.focus_changed` / `notify_needs_you: fired`
/`skipped` records precisely so the next occurrence is a `jq` query, not
another live repro session). The **Telemetry** screen (`apps/client/src/
screens/telemetry.tsx`, `crates-tauri/tt-app/src/telemetry.rs`) reads
these files back for browsing/searching — day picker, level/kind/target
filters, substring search, a per-record drill-down. It reads fresh off
disk on every request rather than caching (the log is small and bounded
by spawns/discrete actions, never per-keystroke input) and refreshes on a
manual button and when the screen regains focus, not live-tailed.
Its **Attention** tab is the payoff for the completeness rule above:
`tt_telemetry::summarize` (`crates/tt-telemetry/src/attention.rs`) folds a
day's records into focused time and its longest unbroken stretch (paired
from `window.focus_changed`), gestures per screen and in-app screen
switches (`ui.action`), interruptions (`notify_needs_you`), and subprocess
wait (`process.spawn`) — the day's shape, which exists only because every
one of those is logged. **It aggregates in Rust behind its own
`telemetry_attention` command, not in a frontend `useMemo` over the
records the Log tab already holds**: a busy day is 75,000+ records, and
the summary is a few hundred bytes. Two counting rules there look like
bugs and aren't — an *event*'s identity comes from its `message`, since
its `name` is the throwaway `event <file>:<line>`, and hour buckets are
local while the day file's boundary is UTC.
Its **Keyboard** tab is the second payoff, and the one convention a new
click handler has to know: an action id of `shortcut.<id>` means a
registry binding fired, `mouse.<id>` means the pointer did that same
binding's job, and `tt_telemetry::keyboard_score`
(`crates/tt-telemetry/src/keyboard.rs`) scores the two against each other
into a daily share and a streak. **A click target that is a genuine twin
of a shortcut must call `mouseAction(id, screen)`
(`apps/client/src/lib/shortcut-coach.ts`) instead of `uiAction` directly**
— it emits that record and, at most a few times a day, the toast naming
the keys. A twin that emits a plain `uiAction` silently flatters the
score; conversely a *near*-twin (a per-row ✕ against "close the selected
session") must **not** call it, because it wasn't a keystroke the user
passed up. Same aggregate-in-Rust rule as Attention, plus a cache: the
score spans a fortnight and the status bar polls it, so finished days are
memoized in `telemetry.rs` and only today's file is re-read.

## Backend half: every user-gesture command emits its own event

**Every `#[tauri::command]` triggered by an explicit user gesture must emit its
own `tracing` event** — a mutation, a confirm, a delete, or an action that
signals a process. Without it the command is invisible in the on-disk log, and
"feature unused" can't be told from "feature uninstrumented" (the gap #363 fixed
across ~all `ab_*`/`store_*`/task/slack/settings/cockpit/ide commands).

- **Name the event for *what changed*, `noun.verb`** (`task.created`,
  `repo.identity_set`, `session.closed`) — never reuse `ui.action`. The frontend
  click already emitted one, and a backend event with the same name double-counts
  the gesture. The two are complementary: `ui.action` records the intent, the
  command event records the outcome, and catches invocations that never came from
  a click.
- **Record the outcome, not just that it ran** — a `changed`/`count` field, a
  `from`/`to` pair, or a `started`/`already_running`/`blocked` discriminant where
  the command can no-op or be refused (`store_collect_now`, `task_delete`). Log
  after the mutation succeeds; a longer-running command that can end three ways
  uses a span with an `outcome` field.
- **Never log content or continuous input** — no note/message/prompt text, no
  per-keystroke/mouse/scroll/resize/PTY-write events. Hence `slack_dm_send` logs
  `slack.dm_sent` with *no* text, and the `term_*` input commands emit nothing
  (the PTY *spawn* is recorded in `term_start` via
  `tt_exec::record_detached_spawn`, the *kill* in `term_kill`).
- **Don't instrument pure reads or pollers** (`*_get`/`*_snapshot`/`ab_get_*`/
  `app_resource_usage`) — over-logging buries the signal. A command that shells
  out through `tt_exec` (every `gh`/`git`) is already covered by that
  `process.spawn` span, but still add a semantic event when the *user gesture*
  itself is what you want to query for.
