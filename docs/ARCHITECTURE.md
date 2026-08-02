# Architecture

The workspace crate by crate. [CLAUDE.md](../CLAUDE.md) keeps a one-line map and
points here; the deepest three subsystems have their own docs
([MCP](MCP.md), [telemetry](TELEMETRY.md), [the native pane](NATIVE-PANE.md)).

Cargo workspace + npm workspace (`apps/client` only):

- `crates/` — **Tauri-free** shared libraries. This is a hard rule (Yaak's
  shared-crate pattern): nothing here may depend on `tauri`, so logic stays
  fast to compile and unit-testable without the app shell (and both the CLI
  and the app can consume it).
  - `tt-config` — settings, stored at
    `~/.config/towles-tool/towles-tool.settings.json`. **This file is shared
    with the TypeScript CLI**, so serde types must tolerate unknown fields
    (`#[serde(default)]` / no `deny_unknown_fields`) to avoid breaking the other
    tool. Also the **single resolver for every mutable state path**, split in
    two: **shared stores** (settings, agentboard `repos.json`, the collectors'
    `gh-cache` — facts about the user/machine, or about GitHub as the machine's
    token sees it) are one machine-wide copy from every checkout, while
    **instance state** (`tt.db`, agentboard sessions/windows/collapse — one
    running checkout's world) nests under `…/towles-tool/tasks/<scope>/…` when
    `state_scope()` detects the process runs from a checkout of this repo (cwd
    walks up to a dir containing `crates/tt-config`; `.claude/worktrees/<name>`
    checkouts get repo-qualified scopes). A branch's schema experiments therefore never
    touch the daily driver's `tt.db`, but tracking a repo shows up everywhere.
    An explicitly set `TT_STATE_SCOPE` isolates *everything*, shared stores
    included (tests must never write real settings); empty = force unscoped.
    The CLI `--config-dir` flag still wins for the settings path. Never build
    these paths ad-hoc — call the resolver.
  - `tt-exec` — process/command wrappers.
  - `tt-journal` — journal/note filesystem logic and date-token path templating.
  - `tt-exec` — process/command wrappers. Every subprocess is logged; see
    [docs/TELEMETRY.md](docs/TELEMETRY.md).
  - `tt-journal` — journal/note filesystem logic and date-token path templating.
  - `tt-git` — **the one way this workspace reads a git repository**, plus the
    GitHub helpers. `tt_git::repo` is an in-process
    [gitoxide](https://github.com/GitoxideLabs/gitoxide) layer behind a
    per-folder cache of open repositories. Nothing outside it parses `git`
    output, because nothing outside it runs `git`: the Agentboard poll alone was
    ~100k subprocesses a day. **Two operations still shell out** because
    gitoxide has no equivalent — linked-worktree add/remove/prune and `fetch`.
    A third git subprocess anywhere else is a regression; extend
    `tt_git::repo`, and read its module docs first.
  - `tt-claude-sessions` — session-JSONL token accounting, the ledger
    scan/search path, ranked waste insights, per-session drill-down.
  - `tt-tasks` — the worktree-task convention: env-template renderer with port
    claims, task naming/layout, removal guards, `ops`. **`landed` is the one
    answer to "has this work reached the base branch"** — everything goes
    through `ops::work_state`, because no single git signal covers all three
    landing shapes (a squash merge is invisible to both reachability and
    per-commit patch identity). Read the module docs before touching detection.
  - `tt-store` — the data-hub SQLite store (`tt.db`): events, board tasks
    (#339's unit of work), issues, PR status, collector freshness. Timestamps
    are epoch ms, passed in (`now_ms`) — never read the clock in logic.
    **Calendar events are the exception**: RFC 3339 text keeping the calendar's
    offset, with a generated `starts_at_utc` as the sort key — never sort or
    range on the authored column. See
    [`crates/tt-store/CLAUDE.md`](crates/tt-store/CLAUDE.md).
  - `tt-collect` — collectors that fill tt.db: calendar via `claude -p` (**off
    by default** — it burns tokens per tick), issues + PRs via `gh`, a watched
    Slack DM. Collector keys are `claude:calendar`, `issues`, `prs`,
    `slack:dm` — the frontend matches on them. See
    [`crates/tt-collect/CLAUDE.md`](crates/tt-collect/CLAUDE.md).
  - `tt-mcp` — the transport-free MCP server: `task_list`, `task_status`,
    `task_create`, `task_summary`, `task_start`, `task_delete`, `preview_file`,
    and the calendar family. Served one per app instance over loopback HTTP.
    **There is no bearer token and no mutation gate** — request admission (no
    `Origin`, JSON `Content-Type`) is the entire write guard, which is also why
    the app's own webview cannot call its endpoint. Tools, hosts and the full
    threat model: **[docs/MCP.md](docs/MCP.md)**.
  - `tt-telemetry` — the `tracing` subscriber, the on-disk event log, and the
    app's Telemetry screen. **Every subprocess and every user-initiated action
    must be logged**, never content or continuous input — the rules, the two
    spawn shapes and the Attention/Keyboard aggregates:
    **[docs/TELEMETRY.md](docs/TELEMETRY.md)**.
  - `tt-ide` — Claude Code IDE-protocol core: the dispatcher and lockfile schema
    the app uses to pose as an "IDE". Transport-free; the lockfile's *filename*
    is the port.
  - `tt-vt` — libghostty-vt terminal-state engine behind the canvas terminals.
    Needs zig 0.15.x; see [`crates/tt-vt/CLAUDE.md`](crates/tt-vt/CLAUDE.md).
  - `tt-jarvis` — the **native pane**: Bevy rendering into a surface it did not
    create, opt-in and off by default. Nothing takes a pane down while the app
    runs, and that is deliberate — that plus the Bevy fork pin, the subsurface
    traps and `bevy_solari`'s blocker: **[docs/NATIVE-PANE.md](docs/NATIVE-PANE.md)**.
  - `tt-browser` — Chrome as a supervised child driven over CDP, behind the
    **Chrome pane**. The profile is the app's own and starts empty: the
    feature is login persistence, never an import of the user's Chrome
    profile. Shutdown goes through CDP `Browser.close` or the cookie DB
    never flushes: **[docs/BROWSER-PANE.md](docs/BROWSER-PANE.md)**.
  - `tt-agentboard` — watchers/engine: repo list, session tracking, needs-you
    synthesis. **Agent status is PTY-first** (`pty_status` folds what the
    terminal observes over the cached `claude agents` verdict — read that
    module's docs; the thresholds are measured, not guessed). Also **the one
    home of the task-removal sequence** (`task_removal`): guards → host teardown
    → worktree off disk → untrack from `repos.json` → board row closed last.
    Change the order there, not in a shell.
  - `tt-claude-code` — transcript/session parsing models.
  - `tt-doctor` — doctor checks logic (the app screen consumes it).
  - `tt-update` — checks GitHub Releases for a newer version. Uses
    `native-tls`, for the Zscaler reason in the conventions.
    app's `store_add_task`), `task_summary`, `task_start`, `task_delete`,
    `preview_file`, plus the calendar family `calendar_today`, `calendar_next`
    and the push-model write `calendar_set`.
    `task_summary` is how a finished agent leaves a record: it writes the
    wrap-up onto the task's row (`summary`/`summary_at`, schema v17) instead of
    into a PTY scrollback that dies with the worktree. It is a *separate column
    from `notes` on purpose* — `notes` is the user's own context and
    `task_prompt` feeds it into a `task_start` prompt, so a summary folded in
    there would come back as instructions to the next session. It records only:
    it never closes the task or touches the worktree, because confirming a task
    is done is the user's job.
    **`task_start` and `task_delete` are the two tools that cannot work from the
    dispatcher alone**, and both enter through the injected `TaskHost`; a
    dispatcher without one refuses rather than half-doing the job. `task_delete`
    kills the task's panes and removes its worktree (the row itself is
    *closed* with an optional `outcome` arg, not deleted — see the
    task-removal bullet in Worktree tasks) via `tt-app`'s
    `task::delete_task_blocking`. `task_start` is the inverse — it mints a
    worktree for an existing card and launches an agent on the task's goal *plus
    its notes* — and it is **asynchronous where `task_delete` blocks**: a pane
    has no PTY until the frontend renders it and the goal is typed into that
    PTY, so the host can only emit `task://start` for the frontend to run down
    its normal `createTask` path (`apps/client/src/lib/task-start.ts` →
    `screens/agentboard/use-task-creation.ts`). Hence `status: "starting"`, not
    `"started"` — the tool genuinely cannot know. Don't "fix" this by minting the
    worktree in Rust and leaving the launch to the frontend: that forks the
    start path in two, and the frontend's half already encodes the
    no-PTY-until-rendered and serial-drain rules the second copy would have to
    restate.
    **`preview_file` is the third host-backed tool, and the only one pointing
    the other way**: an agent points at a file — Markdown rendered as prose, a
    self-contained HTML artifact as the page it is, anything else as text — and
    asks for it on screen in its own task's Preview pane. The pane **watches the
    file** (`preview_watch_file`, one shared `MultiFileNotifier`) and re-reads on
    every write, so an agent iterating on a plan updates what the user is looking
    at without calling the tool again. Extension is what picks the surface, in
    Rust, so a file mid-rewrite can't flip renderers under the user. It is the agent→human
    half of the channel whose human→agent half already existed (draw on the
    pane, send the annotated screenshot back), and the two share a surface
    deliberately, so the user can circle a line of the agent's own plan and
    reply to it. A hand-off like `task_start`, since only the frontend can
    open a pane. **It routes by *caller*, not by path** — the request carries
    the agent's `TT_SESSION_ID` in an `X-TT-Session` header, filled in by the
    MCP client from the plugin's `.mcp.json` (`"${TT_SESSION_ID:-}"`, Claude
    Code's env expansion) rather than by the model, and the frontend resolves
    that session to the folder owning its pane. Path-prefix matching survives
    only as the fallback for a caller with no session (a Claude Code session
    started outside the app). Don't restore it as the primary: an agent's
    natural place for a throwaway page is a scratch dir under no tracked
    folder, which matches nothing and lands the page in whatever task is on
    screen — one instance serves every session on the machine. Making the file's
    location load-bearing also meant an agent had to know that and write
    somewhere unnatural to be routed right; the terminal it is sitting in is
    the fact that actually answers "whose pane is this?". The
    delivery mechanics (path not bytes, the sandboxed `srcDoc` frame) are
    documented at `tt-mcp`'s `PreviewHost` and
    `crates-tauri/tt-app/src/preview.rs`. The broader
    dashboard-read tools (`day_brief`, `needs_you`, `snapshot`,
    PR/issue/DM/collector reads) were pruned in the 2026-07 tool-surface
    review and have not returned.

    **Security posture changed on 2026-07-20 — don't reason from the old
    shape.** There is no bearer token and no `mcp.mutationsEnabled` gate; both
    are gone, not merely defaulted. What guards writes is entirely the
    transport's request admission: **any request carrying an `Origin` header is
    refused** (browsers always send one, real MCP clients never do — the
    DNS-rebinding mitigation) and **`Content-Type: application/json` is
    required** (not a CORS-simple type, so a page can't dodge a preflight).
    Loopback binding alone does *not* keep web pages out, which is why those
    checks exist and why they're pure functions with direct tests. A
    consequence worth knowing before debugging: **the app's own webview cannot
    call the endpoint** — its `fetch` carries an `Origin` — so the MCP screen's
    tool tester issues its request from Rust (`mcp_test_call`). Both crates'
    module docs carry the full threat model.

    Served **one per app instance**, each on its own `${tt:port 8787-8986}`
    claim (`TT_MCP_PORT`) like every other port here — no exception to the
    no-hardcoded-ports rule any more. App closed = that checkout's MCP down;
    there is no headless fallback (the stdio server and `tt mcp serve` were
    deleted). The plugin still ships a **static checked-in `.mcp.json`**,
    because the port rides the environment rather than the file:
    `"http://127.0.0.1:${TT_MCP_PORT:-8787}/mcp"`, expanded by Claude Code from
    the stamp the app put on the terminal. Precedence for the app's own port is
    process env → the checkout's rendered `.env` → settings `mcp.port`
    (`mcp_http::resolve_port`, unit-tested). The pre-2026-07-26 shared-8787
    singleton is described in the Worktree tasks section — read that before
    proposing a shared port again; it cross-wired tool writes between
    checkouts' boards.
  - `tt-telemetry` — telemetry: the `tracing` subscriber/writer and the reader
    behind the app's Telemetry screen, one crate so both halves can never
    disagree about the on-disk schema. `tt_telemetry::init` installs the global `tracing`
    subscriber for both binaries (it replaced `env_logger` — a hard cutover,
    no second logger), fanning out to stderr (filtered by `-v`/`RUST_LOG`) and
    to an **event log on disk**: one JSON object per line at

**`tt open` is the one CLI command that is a client of the app.** It makes no
editor decision of its own: it POSTs the `file_open` MCP tool call to the app
instance serving this checkout, so the file lands in the Files pane beside the
terminal it was typed in (`X-TT-Session` from `TT_SESSION_ID`, the same
routing `preview_file` uses). Hence no `preferredEditor` spawn and no fallback
to one — a command whose behavior depends invisibly on whether a window is up
is worse than one that says the window isn't up — and hence the refusal for a
path under no git repository, checked in the CLI because the pane browses a
checkout and the app has no better answer than a toast in a window that may
not be on screen.
