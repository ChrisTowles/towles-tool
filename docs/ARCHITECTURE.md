# Architecture

The workspace crate by crate. [CLAUDE.md](../CLAUDE.md) keeps a one-line map and
points here; the deepest subsystems have their own docs ([MCP](MCP.md),
[telemetry](TELEMETRY.md), [the native pane](NATIVE-PANE.md), [the browser
pane](BROWSER-PANE.md)).

Cargo workspace + bun workspace (`apps/client` only).

## `crates/` — Tauri-free shared libraries

A hard rule (Yaak's shared-crate pattern): nothing here may depend on `tauri`,
so logic stays fast to compile and unit-testable without the app shell, and both
the CLI and the app can consume it.

- `tt-config` — settings, at
  `~/.config/towles-tool/towles-tool.settings.json`. **Shared with the
  TypeScript CLI**, so serde types must tolerate unknown fields
  (`#[serde(default)]`, no `deny_unknown_fields`). Also the **single resolver
  for every mutable state path**, split in two: **shared stores** (settings,
  agentboard `repos.json`, the collectors' `gh-cache` — facts about the
  user/machine) are one machine-wide copy, while **instance state** (`tt.db`,
  agentboard sessions/windows/collapse — one running checkout's world) nests
  under `…/towles-tool/tasks/<scope>/…` when `state_scope()` detects the process
  runs from a checkout of this repo. A branch's schema experiments therefore
  never touch the daily driver's `tt.db`, but tracking a repo shows up
  everywhere. An explicitly set `TT_STATE_SCOPE` isolates *everything*, shared
  stores included (tests must never write real settings); empty = force
  unscoped. Never build these paths ad-hoc — call the resolver.
- `tt-exec` — process/command wrappers. Every subprocess is logged; see
  [TELEMETRY.md](TELEMETRY.md).
- `tt-journal` — journal/note filesystem logic and date-token path templating.
- `tt-git` — **the one way this workspace reads a git repository**, plus the
  GitHub helpers. `tt_git::repo` is an in-process
  [gitoxide](https://github.com/GitoxideLabs/gitoxide) layer behind a per-folder
  cache of open repositories. Nothing outside it parses `git` output, because
  nothing outside it runs `git`: the Agentboard poll alone was ~100k subprocesses
  a day. **Two operations still shell out** because gitoxide has no equivalent —
  linked-worktree add/remove/prune, and `fetch`. A third git subprocess anywhere
  else is a regression; extend `tt_git::repo`, and read its module docs first.
- `tt-claude-sessions` — session-JSONL token accounting, the ledger
  scan/search path, ranked waste insights, per-session drill-down.
- `tt-tasks` — the worktree-task convention: env-template renderer with port
  claims, task naming/layout, removal guards, `ops`. **`landed` is the one
  answer to "has this work reached the base branch"** — everything goes through
  `ops::work_state`, because no single git signal covers all three landing
  shapes (a squash merge is invisible to both reachability and per-commit patch
  identity). Read the module docs before touching detection.
- `tt-store` — the data-hub SQLite store (`tt.db`): events, board tasks, issues,
  PR status, collector freshness. Timestamps are epoch ms, passed in (`now_ms`)
  — never read the clock in logic. **Calendar events are the exception**: RFC
  3339 text keeping the calendar's offset, with a generated `starts_at_utc` as
  the sort key — never sort or range on the authored column. See
  [`crates/tt-store/CLAUDE.md`](../crates/tt-store/CLAUDE.md).
- `tt-collect` — collectors that fill tt.db: calendar via `claude -p` (**off by
  default** — it burns tokens per tick), issues + PRs via `gh`, a watched Slack
  DM. Collector keys are `claude:calendar`, `issues`, `prs`, `slack:dm` — the
  frontend matches on them. See
  [`crates/tt-collect/CLAUDE.md`](../crates/tt-collect/CLAUDE.md).
- `tt-mcp` — the transport-free MCP server: the task family, `preview_file`,
  `file_open`, and the calendar family. Served one per app instance over
  loopback HTTP on its own `${tt:port 8787-8986}` claim (`TT_MCP_PORT`) — app
  closed means that checkout's MCP is down, and there is no headless fallback.
  **There is no bearer token and no mutation gate**: request admission (no
  `Origin` header, JSON `Content-Type`) is the entire write guard, which is also
  why the app's own webview cannot call its endpoint. Tools, hosts, routing by
  caller, and the full threat model: **[MCP.md](MCP.md)**.
- `tt-telemetry` — the `tracing` subscriber, the on-disk event log, and the
  reader behind the app's Telemetry screen, one crate so the two halves can
  never disagree about the schema. **Every subprocess and every user-initiated
  action must be logged**, never content or continuous input:
  **[TELEMETRY.md](TELEMETRY.md)**.
- `tt-ide` — Claude Code IDE-protocol core: the dispatcher and lockfile schema
  the app uses to pose as an "IDE". Transport-free; the lockfile's *filename* is
  the port.
- `tt-vt` — libghostty-vt terminal-state engine behind the canvas terminals.
  Needs zig 0.15.x; see [`crates/tt-vt/CLAUDE.md`](../crates/tt-vt/CLAUDE.md).
- `tt-jarvis` — the **native pane**: Bevy rendering into a surface it did not
  create, opt-in and off by default — at build time too, behind the `bevy`
  Cargo feature this crate, `tt-pane` and `tt-app` all forward
  ([COMMANDS.md](COMMANDS.md#the-bevy-feature)). Nothing takes a pane down while
  the app runs, and that is deliberate: **[NATIVE-PANE.md](NATIVE-PANE.md)**.
- `tt-browser` — Chrome as a supervised child driven over CDP, behind the
  **Chrome pane**. The profile is the app's own and starts empty: the feature is
  login persistence, never an import of the user's Chrome profile. Shutdown goes
  through CDP `Browser.close` or the cookie DB never flushes:
  **[BROWSER-PANE.md](BROWSER-PANE.md)**.
- `tt-codeserver` — code-server as a supervised child, behind the **Files
  pane**: one server per app instance, one VS Code workbench per checkout, the
  app as a multiplexer over the windows it replaces. `tt open` and Claude's
  `openFile` land through code-server's own open-in-window socket:
  **[CODE-SERVER.md](CODE-SERVER.md)**.
- `tt-agentboard` — watchers/engine: repo list, session tracking, needs-you
  synthesis. **Agent status is PTY-first** (`pty_status` folds what the terminal
  observes over the cached `claude agents` verdict — the thresholds are
  measured, not guessed). Also **the one home of the task-removal sequence**
  (`task_removal`): guards → host teardown → worktree off disk → untrack from
  `repos.json` → board row closed last. Change the order there, not in a shell.
- `tt-claude-code` — transcript/session parsing models.
- `tt-doctor` — doctor checks logic (the app screen consumes it).
- `tt-update` — checks GitHub Releases for a newer version. Uses `native-tls`,
  for the TLS-proxy reason in the conventions.

## `crates-tauri/`

- `tt-app` — the Tauri 2.11 shell, identifier `dev.towles.tool`. Its
  locking/ordering/singleton invariants are the easiest place in the repo to
  introduce a subtle bug:
  [`crates-tauri/tt-app/CLAUDE.md`](../crates-tauri/tt-app/CLAUDE.md).
- `tt-pane` — native child surfaces (Wayland subsurface / macOS `NSView`) the
  Jarvis and Chrome panes render into.

## `crates-cli/tt-cli`

`clap` 4, binary `tt`, deliberately small: `journal`, `task`, and
`open <path>[:<line>]`.

**`tt open` is the one CLI command that is a client of the app.** It makes no
editor decision of its own: it POSTs the `file_open` MCP tool call to the app
instance serving this checkout, so the file lands in the Files pane beside the
terminal it was typed in (`X-TT-Session` from `TT_SESSION_ID`, the same routing
`preview_file` uses). Hence no `preferredEditor` spawn and no fallback to one —
a command whose behavior depends invisibly on whether a window is up is worse
than one that says the window isn't up — and hence the refusal for a path under
no git repository, checked in the CLI because the pane browses a checkout.

## `apps/client`

React 19 + Vite + Tailwind v4 + shadcn/ui, a Yaak-style shell (resizable sidebar
as the only nav, ⌘K palette, screens stay mounted across switches) with three
Focus screens: **Agentboard** (repos + per-repo terminals; the cold-start
screen), **Cockpit**, **Board**. Terminals are a canvas renderer over `tt-vt`
state with the PTY host in Rust — no cross-restart persistence.

Product rules: the app is for getting in the zone; agent status is **reported,
never re-rendered**; calendar is only *time until the next meeting*.
Frontend-internal conventions: [`apps/client/CLAUDE.md`](../apps/client/CLAUDE.md).
