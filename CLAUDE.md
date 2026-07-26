# CLAUDE.md

Rust rewrite of `towles-tool`: a Tauri 2 desktop app plus the `tt` CLI. Modeled on
the [Yaak](https://github.com/mountain-loop/yaak) repo structure (see
[ATTRIBUTION.md](ATTRIBUTION.md)).

## The Towles twins

**Chris** (this repo) and **Patrick** ([`slyedoc`](https://github.com/slyedoc) —
that spelling, not `slydoc`) are identical twin brothers. Patrick builds
**Solari**, Bevy's real-time raytraced lighting.

So `crates/tt-jarvis` pins `slyedoc/bevy@solari-rt-pipeline` rather than a
released Bevy, and running Solari live inside this app is a repo goal (see
[README.md](README.md)). "My brother's work" in a graphics context means that
fork.

## Commands

Rust:

```sh
cargo run -p tt-cli -- <args>       # run the CLI (binary `tt`)
cargo run -p tt-cli -- task ls      # e.g. task, journal, collect
cargo fmt --check                   # formatting (rustfmt, 100-col)
cargo clippy --all -- -D warnings   # lint; warnings are errors
cargo test --all                    # unit + assert_cmd black-box tests
```

`clippy --all`/`test --all` build `tt-vt` (needs zig 0.15.x), `tt-app` and
`tt-pane` (need webkit2gtk/GTK), and `tt-jarvis` (GTK dev-deps for its
benchmark, plus Bevy from a git fork — minutes of cold build). Without those
prereqs, use CI's variant:

```sh
cargo clippy --workspace --exclude tt-vt --exclude tt-app \
  --exclude tt-jarvis --exclude tt-pane --all-targets -- -D warnings
```

Those four are covered by CI's GTK-provisioned `rust-tauri` job instead, and
that job is path-gated — **a new crate needing GTK must be added to both the
`--exclude` list and the `vt_or_app` paths-filter in `.github/workflows/ci.yml`,
or it silently gets no Rust CI at all.**

Desktop app / frontend:

```sh
npm install                         # installs apps/client (npm workspaces)
npm run dev                         # tauri dev — app + Vite frontend (debug build; noticeably laggy)
npm start                           # release build (`tauri build --no-bundle`) + run the binary — for daily driving
npm run dev:drive                   # like dev, but the window is automatable (live-drive)
npm run drive -- <verb>             # drive the dev:drive window (status|invoke|shot|click|…)
npm run e2e                         # regression suite vs the real shell (see below)
cd apps/client && npm run lint      # oxlint (types/react/unicorn/oxc rules; warnings are non-blocking)
cd apps/client && npm run format    # oxfmt, in place (100-col, matches rustfmt's width)
cd apps/client && npx shadcn@latest add <name>   # vendor a shadcn/ui component
```

**Verifying UI/IPC changes — drive the real app.** Two ways, both hitting the
*actual* Tauri shell (WebKitGTK WebView + real Rust IPC), never a bare browser or
the mock dev server:

- **Live drive** — `npm run dev:drive` opens one automatable window (HMR, you use
  it normally); `node scripts/drive.mjs <verb>` drives *that same* window:
  `status`, `invoke <cmd> [json]` (real IPC), `eval "<js>"`, `shot <name>` (→
  `e2e/screenshots/<name>.png`, which you can `Read`), `click "<css>"`,
  `type "<css>" <text>`, `url <path>`, `console [--clear]`. This is the way to
  visually/behaviorally debug a change and see the result. **`shot` is blind to
  the native pane**: a `tt-pane` surface composites *above* the webview, so it's
  absent from a WebDriver capture however healthy it is. `winshot <name>`
  captures at the compositor level instead — it fullscreens the window on the
  test monitor first, which both identifies it among several tasks' identical
  windows and forces it unoccluded (no frame callbacks otherwise) — and
  `unplace` gives the monitor back. **A screenshot that
  looks right is not proof the render was clean** — React reports invalid
  markup as a runtime console error that nothing else here can see (no linter,
  no component tests), so every verb prints a `⚠ N console error(s)` summary
  and `console` dumps the detail. It's a plain-`fetch` client talking to the
  app's in-process WebDriver server — no WebdriverIO.
- **Regression suite** — `npm run e2e` runs WebdriverIO specs that spawn a fresh
  window, run, and exit (CI pass/fail). Specs in `e2e/specs/*.e2e.ts` are
  **read-only** (never write your real settings file); `npm run e2e:run` skips
  the rebuild.

Both are gated behind the `wdio` cargo feature + `VITE_WDIO` flag, so nothing
ships in normal/release builds. Ports come from the env files (`TT_DEV_PORT` in `.env.local`, or `.env` rendered by `tt task`;
webdriver = the `TT_E2E_WEBDRIVER_PORT` claim, falling back to `+3000`); `dev:drive` and `e2e` share a task's ports, so don't run
both at once in one task. Full docs + Linux gotchas: [e2e/README.md](e2e/README.md).

**After finishing a task that touches the app, leave it running for Chris to
check.** Once the change builds/lints/tests clean, launch `npm start`
(release build, the daily-driving binary) as a background task — Bash with
`run_in_background: true`, not a foregrounded blocking call — as the last
step before ending the turn. This is a courtesy handoff so the real running
app is already on screen for Chris to click through and validate, rather than
him having to remember to launch it himself. It doesn't replace driving/
screenshotting the app yourself first for UI/IPC changes (previous section) —
do both when the change touches the app. Skip it for changes with nothing in
the app to look at (CLI-only, docs-only, crate-internal refactors with no
`tt-app`/`apps/client` surface).

> The binary is **`tt`**. The `ttr` → `tt` cutover from the TypeScript CLI
> happened 2026-07-13 — hard cutover, no `ttr` alias left behind (see
> [docs/CUTOVER.md](docs/CUTOVER.md)).

## Worktree tasks — you are probably working in one

Tasks are branch-named git worktrees nested **inside** the checkout at
`<checkout>/.claude/worktrees/<name>/` — Claude Code's native worktree
location — one per parallel line of work (a `.tt-task` marker file sits at
each task's root). Any plain git checkout is task-capable with no
restructuring: point `tt task new` at it with `--repo`. Tasks are ephemeral:
created for a branch, removed when the branch merges. Manage them with
`tt task` — never raw `git worktree` or new clones. (`git clean -fdx` at the
checkout root is safe — git skips nested repositories without a second `-f`.)

```sh
tt task init                              # onboard a repo: template, .gitignore, worktree hooks, primary .env
tt task new "<title>" --repo <name|dir> [-b feat/thing] [--base <ref>] [--status doing] [--notes ...]
                                          # board task + .claude/worktrees/<branch-slug> in one shot
                                          # (branch defaults to a slug of the title)
tt task ls [--json]                       # fleet: main checkout + tasks, branch, dirty, ports
tt task env <name>                        # (re)render .env — idempotent, keeps claims
tt task env primary                       # same, for the main checkout
tt task ports [--probe <port>] [--json]   # repo's port picture: every checkout's claims + registry, each probed for a listener
tt task rm <name> [--force]               # guarded removal + docker cleanup
tt task clean [--dry-run]                 # rm every merged/gone task + sweep stale state
```

Claude Code's own worktree surfaces (`claude --worktree`, background
sessions, the desktop app's parallel sessions) route through the same
machinery when the repo's `.claude/settings.json` wires the hooks:

```json
"hooks": {
  "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "tt task hook-create" }] }],
  "WorktreeRemove":  [{ "hooks": [{ "type": "command", "command": "tt task hook-remove" }] }]
}
```

`hook-create` reads the hook JSON on stdin and prints the task path (its one
line of stdout — the hook contract); the requested worktree name IS the
branch, verbatim (`claude -w feat/thing` → branch `feat/thing`, folder
`feat-thing`), never Claude Code's `worktree-<name>` scheme. `hook-remove` runs the same
guarded removal as `tt task rm`. Hooks execute from the *session checkout's
committed copy* of `.claude/`, so hook config edits only take effect in new
worktrees once committed. The blog repo (`~/code/p/blog`) is wired this way
and is the reference example.

The Agentboard rail shows the whole fleet automatically (worktrees of any
tracked checkout are discovered per poll), and the `+` button on the repo
header opens the same creation flow as a modal: goal → branch → base, then
Claude starts on the goal in the new task's terminal. Discovery covers the
main checkout and `tt task` worktrees only; a worktree created outside the
convention (`claude --worktree` against unwired hooks, a hand-added one — no
`.tt-task` marker, so `tt_tasks::is_managed_task` says no) reaches the rail
only when the rail header's worktree toggle
(`agentboard.showUnmanagedWorktrees`) is on. The engine applies that setting
at discovery time (`Engine::expand_with_worktrees`), so it never invalidates
the git cache.

Rules when working in a task:

- **The main checkout is load-bearing.** Every task's git state lives in its
  `.git` — never delete, move, or re-clone it. Tasks never work on the
  default branch directly (git itself blocks a second checkout of it while
  the main checkout holds it).
- **One branch per task, named after it.**
  `tt task new "Thing" --repo <r> -b feat/thing`
  creates `.claude/worktrees/feat-thing` (the folder is the slugged branch —
  one-way; the branch is always read from git, never parsed back from the
  folder) (`--base` when not branching off the
  default). A task whose PR merged is done — `tt task rm` it (or
  `tt task clean`, which finds every merged/gone task); commits reachable
  from no branch or remote block removal by design.
- **Ports come from the rendered `.env`** — `.env.example` is the template
  (`${tt:port A-B}` pool claims, `${tt:task-name}`, `${tt:var NAME}`; a repo
  without tokens uses the `.claude/task-env.template` sidecar, and a repo
  with neither renders an empty `.env` — no template is required to create
  tasks), and a manual `.env.local` pin overrides it; shell env overrides
  both. Never hardcode a port anywhere. The main checkout claims its ports
  the same way.
- **No setup scripts.** `tt task new` runs the `TT_TASK_SETUP` command
  declared in `.env.example` (spawned directly, no shell — `npm install`
  here), falling back to lockfile detection in repos that don't declare one —
  and, in the CLI, runs it synchronously: `tt task new` is a foreground tool,
  so blocking on the install there is correct. **The app's `+` flow does
  not** — `task_create` (`crates-tauri/tt-app/src/task.rs`) only does the
  fetch/worktree-add/`.env`-render half and returns; `task_run_setup` fires
  separately, after the pane already opened, off `agentboard.tsx`'s
  `createTask`. The pane must never wait on the install again — it's what
  turned a 2–3s Linux task into a 1–2 minute macOS one (npm's per-file cost
  under APFS + Gatekeeper scanning is far higher than on Linux for the same
  `node_modules`), and the fix is to keep the two off the same critical path,
  not to make the install itself faster.
- **Never touch sibling task directories** — other agents work there
  concurrently. Instance state (tt.db, sessions/windows) is scoped per
  checkout via `tt_config::state_scope()`; shared stores (settings, tracked
  repos) are one machine-wide copy.
- **Attribute a running process to its worktree before acting on it.** Several
  tasks run `tt-app`/vite at once and they are identical by process name, so
  `readlink /proc/<pid>/cwd` is the thing that tells you whose it is:

  ```sh
  pgrep -af "tt-app|vite"        # every instance on the machine
  readlink /proc/<pid>/cwd       # which checkout owns that one
  pkill -f "<task-name>.*tt-app" # kill only ever scoped to one task
  ```

  A bare `pkill -f "tauri dev"` or `killall` matches every task's processes,
  which is why `.claude/hooks/guard-task-pkill.sh` rejects the unscoped forms.

  **"The MCP tools aren't there"** is the common case, and its cause is
  counter-intuitive: the server is one-per-machine **bind-or-skip**, so an app
  that started while another instance held `8787` serves nothing *for its whole
  life* and never retries. A running `tt-app` is therefore no evidence that MCP
  is up.

  ```sh
  curl -s -m 5 -X POST http://127.0.0.1:8787/mcp \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'  # empty => nobody serving
  ss -ltnp | grep 8787                                    # who bound it, if anyone
  ```

  The fix is to start an app from your own checkout — the port is free, so it
  binds. The app shows this itself (`Not serving · another instance holds the
  port`), but that surface is useless when the app is the thing that's down,
  and `tt task ports` lists only `${tt:port}` claims, never the fixed `8787`.
- Task logic lives in `crates/tt-tasks` (template grammar, removal guards,
  pure decisions) with shared orchestration in `tt_tasks::ops`; the CLI and
  the app's `task_create` command are thin shells over it. Change behavior
  there, not in the shells.
- **Migration state:** this repo's own checkouts still use the retired
  sibling layout (`~/code/p/towles-tool-repos/towles-tool-rs-primary` +
  `tasks/`). Running from an old-layout task still anchors correctly (the
  `.git` file's worktree pointer resolves to the main checkout), but new
  tasks land in `<checkout>/.claude/worktrees/`; old tasks drain as their
  branches merge.
- **Removing a task checkout goes through `tt_agentboard::task_removal`** —
  don't hand-roll the sequence. It untracks the dir from the shared
  `repos.json` and **closes** the bound board row, in that order, after the
  worktree leaves disk; `FinishedTask`/`RemovedTask` carry `dir`/`checkout`
  for exactly this. Closing (2026-07-22) replaced deleting: the row survives
  with a `TaskOutcome` (`done`/`abandoned`) and its `worktree_dir` cleared —
  the app's delete dialog asks which, headless callers (`tt task rm`, MCP)
  infer it via `TaskItem::inferred_outcome` (merged linked PR ⇒ done). Closed
  rows age into the archive (`archived_at`, `Store::archive_closed_tasks`,
  swept from `tt-collect`'s `sync_task_links` and the Board's "Archive done"
  button); `Store::delete_task` remains only behind the Board's explicit
  "Delete permanently", which refuses while a worktree is bound. Skip the
  untrack and a removed task's stale path lingers in the tracked-repos list
  forever, with the scheduler's `prs`/`issues` collectors retrying `gh`/`git`
  against a directory with no `.git` on every tick; skip the row-close and
  the board keeps a card claiming a worktree that no longer exists. `tt task
  rm`/`clean`/`hook-remove` and the app's `task_delete` are all shells over
  it.

## Architecture

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
  - `tt-git` — **the one way this workspace reads a git repository**, plus the
    GitHub helpers (branch-name slugging, remote-slug parsing, the issue→task
    assignment guard). `tt_git::repo` is an in-process
    [gitoxide](https://github.com/GitoxideLabs/gitoxide) layer — refs, graph
    walks, status, diffs, patch identity — behind a **per-folder cache of open
    repositories** (`tt_git::repo::open`, process-wide). Nothing outside it
    parses `git` output, because nothing outside it runs `git`: the Agentboard
    poll alone was ~100k subprocesses a day, and the same answers come back
    10–100× faster from a cached handle. **Two operations still shell out via
    `tt-exec`, both because gitoxide has no equivalent**: linked-worktree
    add/remove/prune (its worktree API is read-only) and `fetch` (network-bound,
    where in-process buys nothing and would put credential helpers, SSH and a
    TLS stack on the line). Adding a third git subprocess anywhere else is a
    regression — extend `tt_git::repo` instead. Read that module's docs before
    touching it; `repo::patch` in particular explains why its patch ids
    deliberately do not match `git patch-id`.
  - `tt-claude-sessions` — backs the app's Claude Sessions screen:
    session-JSONL token accounting, the single-parse ledger scan/search path,
    ranked waste insights (`insights`), and the per-session turn/tool
    drill-down (`breakdown`).
  - `tt-tasks` — the worktree-task convention (see the Worktree tasks section):
    the `${tt:...}` env-template renderer with port-pool claims, dotenv-lite
    parse/merge, task naming/layout, removal guards, and the shared
    orchestration in `ops` that both `tt task` and the app's `task_create`
    call. **`landed` is the one answer to "has this task's work reached the
    base branch"** — `tt task ls`/`rm`/`clean` and the Agentboard rail all go
    through `ops::work_state`, never their own git checks, because no single
    git signal covers all three landing shapes (a squash merge is invisible to
    both reachability and per-commit patch identity — it is caught only by
    comparing the branch's *cumulative* diff, which is what used to make merged
    tasks look like they still held work). It keeps *uncommitted changes* and
    *commits that never reached the base* as separate counts: only the first
    dies with the worktree, and only content-based evidence
    (`LandedVia::is_content_proof`) may justify `clean`'s `git branch -D` — a
    `[gone]` upstream looks identical whether the branch merged or was deleted
    unmerged. Read the module docs before touching the detection.
  - `tt-store` — the data-hub SQLite store (`~/.local/share/towles-tool/tt.db`):
    events, board tasks (#339: the unit of work — 0..N issue links + 0..N PR
    links in `task_issues`/`task_prs`, plus an optional worktree-task
    binding), issues, PR status, collector freshness. Collectors write
    events/issues/PRs and refresh link states; tasks are user-created
    (issues attachable/promotable via `gh`). The app UI and MCP server read.
    Timestamps are epoch ms, passed in (`now_ms`) — never read the clock in
    logic. **Calendar events are the exception**: their `starts_at`/`ends_at`
    are RFC 3339 text keeping the offset the calendar reported, with a
    STORED generated `starts_at_utc` as the sort/range key — never sort or
    range on the authored column, whose lexical order is not chronological
    across offsets.
  - `tt-collect` — collectors that fill tt.db: calendar via `claude -p`
    (strict-JSON prompt + lenient extraction; one run per enabled
    `CalendarSource`, each with its own user-editable prompt and its own store
    lane) — **off by default** since it burns tokens
    per tick; issues + PRs via `gh`; a watched Slack DM via the Slack Web API
    (escalating banner in the app). Collector keys are `claude:calendar`,
    `issues`, `prs`, `slack:dm` — the frontend matches on them. Email was
    removed in the day-screens pivot. See
    [`crates/tt-collect/CLAUDE.md`](crates/tt-collect/CLAUDE.md) for the
    never-panic contract, per-repo isolation, and where the Slack
    protocol/socket split lives.
  - `tt-mcp` — hand-rolled JSON-RPC MCP server, **transport-free** (the same
    split as `tt-ide`): `Dispatcher::handle_at` takes a request string and an
    injected `now_ms` and returns a response string, so the whole tool surface
    is unit-testable with no server to stand up. The transport is
    `crates-tauri/tt-app/src/mcp_http.rs` — read that module's doc before
    touching either half. Tools: `task_list`, `task_status`, `task_create`
    (a #339 board task in a tracked repo's swimlane, same store path as the
    app's `store_add_task`), `task_summary`, `task_start`, `task_delete`,
    `preview_show`, plus the calendar family `calendar_today`, `calendar_next`
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
    **`preview_show` is the third host-backed tool, and the only one pointing
    the other way**: an agent writes a self-contained HTML page and asks for it
    to be put on screen in its own task's Preview pane. It is the agent→human
    half of the channel whose human→agent half already existed (draw on the
    pane, send the annotated screenshot back), and the two share a surface
    deliberately, so the user can circle a line of the agent's own plan and
    reply to it. A hand-off like `task_start` and for a related reason — only
    the frontend knows which tracked folder a path lives under, and a path
    under none of them falls back to the folder on screen rather than being
    refused, since one instance serves every session on the machine. The
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

    Served **one per machine, bind-or-skip**: whichever app instance takes the
    port serves every session, the rest serve none, and the OS bind is the
    mutex. App closed = MCP down; there is no headless fallback (the stdio
    server and `tt mcp serve` were deleted). The port is a **fixed default**
    (`mcp.port`, 8787) rather than a `${tt:port}` claim — the one legitimate
    exception to the no-hardcoded-ports rule, because a machine-wide singleton
    has nothing to collide with, and a stable port is what lets the
    `towles-tool-app` plugin ship a static checked-in `.mcp.json`.
  - `tt-telemetry` — telemetry: the `tracing` subscriber/writer and the reader
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
  - `tt-ide` — Claude Code IDE-protocol core: the MCP/JSON-RPC dispatcher and
    lockfile schema the app uses to pose as an "IDE" a Claude Code CLI session
    connects to. Transport-free by design (sockets, auth, clocks live in
    `tt-app`); the lockfile's *filename* is the port (Claude Code parses it
    from the path, there's no port field in the JSON).
  - `tt-vt` — libghostty-vt terminal-state engine used by the app's canvas
    terminals. Needs zig 0.15.x on PATH to build; see
    [`crates/tt-vt/CLAUDE.md`](crates/tt-vt/CLAUDE.md) for the Debug-mode
    parser perf trap and other gotchas.
  - `tt-agent` — drives a local Claude Code session over its **`stream-json`**
    protocol and turns it into a structured event feed the app renders as UI —
    an **Agentboard pane** (`~agent:<dir>`, one per folder, beside that
    folder's terminals) rather than PTY scrollback. This is the same
    mechanism Anthropic's own GUIs use — the VS Code extension and the desktop
    app both spawn the CLI with `--input-format stream-json --output-format
    stream-json --verbose` via `@anthropic-ai/claude-agent-sdk` and render the
    message stream — so it is a supported interface, not a reverse-engineered
    one. **We don't use the Node SDK**: the wire format is JSONL over pipes,
    and the SDK's value is its TypeScript types, which `protocol.rs` replaces
    with the handful of shapes we actually render. Embedding the extension's own
    webview bundle was evaluated and rejected — it is licensed all-rights-
    reserved, and its host protocol is private and re-minified every release.
    The parser **deliberately models only what it renders**: everything else
    becomes `AgentEvent::Other` carrying its discriminant, so a CLI release
    that adds message types can't break the feed. `AgentEvent::Exited` is the
    one variant synthesized by the host rather than read off the wire, so the
    UI has a single ordered feed instead of a second channel to interleave.
    Transport lives in `crates-tauri/tt-app/src/agent.rs` (`agent://event`),
    which inherits the terminal host's lock discipline for the same reason.
    **The pane id is the backend session key**, and it is folder-scoped, so a
    folder has exactly one rendered agent — two panes on one folder would share
    a single `claude` process and interleave their turns.
    The transcript renders assistant text through the shared `Markdown`
    component (`apps/client/src/components/markdown.tsx` — GFM + Monaco-
    tokenized fences, also the files pane's preview), and **echoes the user's
    own turn locally**: the CLI does not replay user messages without
    `--replay-user-messages`, and the only `user` messages on the wire are tool
    results, so without the echo a sent prompt vanishes.
    **Slash commands need no special transport** — `/context`, `/tt:plan` and
    the rest are ordinary message content, and the CLI resolves them. What the
    pane adds is *discovery*: `system/init` lists ~90 command names (names
    only), `system/commands_changed` re-sends them with descriptions and
    argument hints, and both fold into one `SlashCommand` list behind the
    composer's `/` menu. The menu's logic is pure and unit-tested
    (`slashQuery`/`matchCommands`/`slashMenuKey` in `lib/agent.ts`) rather than
    living in the component, because a synthetic-keydown test of a composer
    proves nothing about the real platform.
  - `tt-jarvis` — the **native pane**: a Bevy scene rendered into a surface it
    did not create, so a region of the app window is real GPU output rather
    than DOM. Native rather than WebAssembly or streamed frames because only a
    native surface can host Solari's ray-tracing pipeline (see
    [README.md](README.md)).

    **Opt-in, off by default** while it's a proof-of-concept
    (`agentboard.jarvisPane`; the cube button in the rail header, or Settings →
    Agentboard). Off means the frontend doesn't render `NativePane` at all
    rather than passing `visible={false}`: unmounting is what runs
    `pane_detach`, and only that drops the subsurface and joins the render
    thread. A hidden-but-attached pane keeps a vsync-paced Bevy loop alive for
    the app's whole life, so hiding is not turning it off.

    Bevy comes from **`slyedoc/bevy@solari-rt-pipeline` (0.20.0-dev)**. Keep it
    there — tracking that fork is the goal, and `Cargo.lock` pins the revision
    so builds stay reproducible. Bevy accepts a foreign surface through public
    API with no renderer fork; `surface.rs`'s module docs explain how, and are
    the place to read before changing it.

    Two traps, both of which fail as something else:
    **(1)** a host driving `App::update()` by hand calls
    `finalize_embedded_app` first, or every `Res<RenderDevice>` system panics
    with "Resource does not exist" — after a healthy-looking `AdapterInfo`.
    **(2)** a `wl_subsurface` is *synchronized* by default; `set_desync()` is
    what keeps the pane's framerate off the parent's. Measured at 0.65 fps
    synced against 60 desynced, so it is a ceiling rather than a tax.
    **(3)** an occluded Wayland surface receives **no frame callbacks**, so a
    vsync'd pane stalls when its window is hidden or on another workspace. Right
    behaviour for a pane, reads as a hang, and makes any vsync benchmark arm
    unmeasurable on a desktop in use.

    The pane's framerate is **paced by the display** because both faster present
    modes flood the compositor and lose the Wayland connection —
    `tt-pane/src/render.rs` carries that decision and
    `tt-jarvis/examples/jarvis_demo.rs` the per-mode measurements.

    **`bevy_solari` does not build, and not for local reasons:** cargo `[patch]`
    applies only from the top-level workspace, so a git dependency does not
    inherit its own repo's patches. `.cargo/solari-patch.toml` is the single home
    for the restated patch set, the five failure modes and the upstream blocker —
    read it before retrying Solari.
  - `tt-agentboard` — agentboard watchers/engine: repo list, session tracking,
    needs-you synthesis (consumed by the app shell). **Agent status is
    PTY-first**: `pty_status` folds what the app's terminal directly observes
    (output activity, Claude Code's `OSC 777` attention notification) over the
    `claude agents --all --json` verdict, which is cached 60s and used to be
    impossible to contradict — read that module's docs before touching status,
    the thresholds are measured against a real session, not guessed. Also
    **the one home of the
    task-removal sequence** (`task_removal`): guards → host teardown → worktree
    off disk → untrack from `repos.json` → board row closed last (with a
    `TaskOutcome` — see the task-removal bullet in Worktree tasks). It lives here
    because it needs `tt-tasks`, `repos.json` and `tt-store` at once — `tt-tasks`
    can't host it (this crate already depends on it, so the edge would be a
    cycle) and `tt-app` can't (the CLI has no Tauri and would have to restate
    the order, which is exactly how the two copies drifted). Host-specific work
    — killing PTYs, closing rail folders, reaching a store held behind a mutex —
    enters through the `RemovalHooks`/`BoardRows` traits. Change the order
    there, not in a shell.
  - `tt-claude-code` — Claude Code transcript/session parsing models.
  - `tt-doctor` — doctor checks logic (app screen consumes it; the CLI command
    was removed in the 2026-07-19 trim).
  - `tt-update` — checks GitHub Releases for a newer version than the running
    app. Uses `native-tls` (not rustls/webpki-roots) for the same
    Zscaler-proxy reason called out below.
- `crates-cli/tt-cli` — `clap` 4 CLI, binary `tt`. Deliberately small after the
  2026-07-19 trim (usage review showed everything else was dead or app-owned):
  `journal daily-notes|note|meeting|jot|open|list|search` (+ `today` alias),
  `task init|new|ls|rm|env|clean` (worktrees — see the Worktree tasks
  section), and the headless entry point
  `collect calendar|issues|prs|slack|all|nudge|status` (slated to move into
  the app per the CLI redesign). The MCP server is not a CLI surface — it
  runs inside the app over loopback HTTP. The removed groups (`gh`, `config`,
  `doctor`, `install`, `agentboard`) live in git history; don't reintroduce
  CLI surfaces for app-owned features. `ui::warning`/`ui::success` print to
  **stdout** — a `--json` command must gate every call behind `if !json` (or
  fold the message into a `"warnings"` array in the JSON payload instead),
  or a warning firing mid-command corrupts the JSON document.
- `crates-tauri/tt-app` — Tauri 2.11 shell. Identifier `dev.towles.tool`.
  `npm run dev` (root) resolves the per-task dev-server port from the
  checkout's rendered `.env` (`scripts/dev-port.mjs` / `task-port.mjs`,
  running `tt task env` automatically when the checkout has no claim yet) —
  the `${tt:port}` claims in `.env.example` are the single source of truth,
  never a hardcoded 1420 or a derived/hashed port; anything already
  listening on the claimed port (almost always this task's own orphaned
  session) is killed first rather than scanned past. Pin a task to a fixed
  port with `TT_DEV_PORT` in a gitignored root `.env.local` (dev-port reads
  it and passes it through to vite). Each window is
  labeled by task: the title bar reads `Towles Tool — <task>` and the app
  header shows a colored task badge (`app_task` command). See
  [`crates-tauri/tt-app/CLAUDE.md`](crates-tauri/tt-app/CLAUDE.md) for the
  crate's internal locking/ordering/singleton invariants — it's the largest
  crate in the repo and the easiest one to introduce a subtle bug in.
- `apps/client` — React 19 + Vite frontend styled with Tailwind CSS v4 +
  shadcn/ui (`@/*` → `src/*` alias, components vendored into
  `src/components/ui/`, light/dark via the `.dark` class). Yaak-style app
  shell: resizable sidebar (the only nav UI — no visible tab strip; screens
  stay mounted in the background across switches), command palette (⌘K),
  settings dialog, status bar, keyboard shortcuts (`?` opens the help overlay).
  Screens live in `src/screens/`; the three "Focus" screens are **Cockpit**
  (default day home — next-meeting countdown + PRs + issue queue), **Board**
  (cross-repo kanban of tasks — #339's unit of work: issue/PR link chips,
  task branch, attach/detach + promote-to-issue; done rolls up from GitHub),
  and **Agentboard** (repos + per-repo terminals; its `+` flow creates a
  task whose worktree is an attribute of the task).
  Terminals are a canvas renderer over **libghostty-vt** terminal state in
  Rust (`crates/tt-vt`); the PTY host
  (`crates-tauri/tt-app/src/terminal.rs`) spawns shells with portable-pty and
  streams frames over `terminal://frame`. No cross-restart persistence;
  closing the app kills the shells. Product rules: the app is for getting in
  the zone — manage PRs and work issues across repos; calendar is only *time
  until the next meeting*. Agent status is **reported, never re-rendered**
  (interaction happens in the real PTY via the terminal view); the day bar
  (`day-bar.tsx`) and the Agentboard needs-you feed unify agents, PRs, and
  calendar into one attention model. See
  [`apps/client/CLAUDE.md`](apps/client/CLAUDE.md) for frontend-internal
  conventions (screen registration, the shortcuts registry, invoke-wrapper
  semantics, the terminal wire protocol). Verify frontend/IPC changes by
  driving the real shell with `npm run e2e` (see the Commands section and
  [e2e/README.md](e2e/README.md)) — not just the mock browser dev server.

## Claude Code plugin marketplace

The repo root doubles as a Claude Code plugin marketplace
(`.claude-plugin/marketplace.json`); each plugin lives in its own
`packages/<name>/` with a `.claude-plugin/plugin.json` manifest, following
the standard plugin layout (`commands/`, `skills/`, `hooks/`, `.mcp.json` —
see [docs](https://docs.claude.com/en/docs/claude-code/plugins)). Two
plugins ship today:

- `tt` (`packages/core`) — the map-vs-territory workflow commands/skills
  (`/tt:blindspot` … `/tt:memories`).
- `towles-tool-app` (`packages/app`) — bridges Claude Code to the desktop
  app itself: registers the app's MCP server with a static checked-in
  `.mcp.json` (`{"type":"http","url":"http://127.0.0.1:8787/mcp"}` — board
  tasks `task_list`/`task_status`/`task_create`/`task_summary`/`task_start`/`task_delete`,
  `preview_show` (put an HTML page the agent wrote on screen in that task's
  Preview pane) plus the calendar family
  `calendar_today`/`calendar_next`/`calendar_set`; the app must be running),
  ships the `towles-tool` skill (the `tt` command reference — journaling
  plus the `tt task` subcommands) and the `task-onboarding` skill (guides
  onboarding any repo onto worktrees — port discovery, template authoring,
  `tt task init`), and a `PostToolUse` hook
  (`hooks/scripts/gh-pr-nudge.sh`) that nudges a running app instance to
  refresh its PR or issue data immediately after a `gh pr`/`gh issue`
  mutation via `tt collect nudge prs`/`tt collect nudge issues`, rather than
  waiting for the app's normal poll interval — see the "nudge" mechanism note in
  [`crates-tauri/tt-app/CLAUDE.md`](crates-tauri/tt-app/CLAUDE.md). Meant to
  be enabled globally (its MCP tools are useful from any project), so its
  hook fails open/no-ops outside a towles-tool-relevant session — don't
  drop that guard when touching it.

A new hook/skill/MCP entry belongs in one of these plugin packages, not
loose in `.claude/` — `.claude/hooks/` is reserved for hooks scoped to
*this repo's own* Claude Code sessions (e.g. `guard-task-pkill.sh`), not
things meant to ship to other checkouts.

**Any change to `tt task`'s surface — a new/renamed subcommand, a new
env-template token or `.env.example` var, a changed removal/lifecycle
guarantee — must update `packages/app/skills/towles-tool/SKILL.md` and, if
it affects onboarding a repo onto tasks,
`packages/app/skills/task-onboarding/SKILL.md`, in the same PR.** These
skill files are the docs Claude Code itself reads when asked about
`tt task`; a lifecycle feature landing only in `crates/tt-tasks` and
`.env.example` is invisible to a session working from the skill alone.
Treat these skills as part of the feature's surface, not optional
follow-up docs.

Any commit touching a plugin package is auto-checked by the
`.githooks/pre-commit` hook (`core.hooksPath .githooks`): it bumps that
plugin's version and runs `claude plugin validate .` against the
marketplace + both manifests before the commit lands.

## Migration

The port from the TypeScript CLI at
`~/code/p/towles-tool-cli-repos/towles-tool-primary` is **finished** —
[docs/MIGRATION.md](docs/MIGRATION.md) is a historical record of what came
across, not a backlog to work from. Porting was selective: a TS feature landed
only if still wanted, and on its natural surface (app screen or CLI command —
see the no-CLI-parity convention below), so don't treat something described
there as owed. When deriving code from an upstream repo, the commit message
should still cite the source path (yaak `path/to/file` or slot-1
`src/commands/...`).

## Conventions

See [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md) for the full
Rust/TypeScript coding standards (errors-as-values, parse-don't-validate,
branded/newtype domain types, deep modules, testing through real seams,
etc.). The points below are repo-specific specializations of that doc.

- **Rust conventions** (errors, tests, formatting, TTY guards, shared-file
  serde, etc.): see [`.claude/rules/rust.md`](.claude/rules/rust.md) — it
  auto-loads for any `.rs` file under `crates/`, `crates-cli/`, or
  `crates-tauri/`, so don't restate it here.
- **TypeScript errors are values**, the same as Rust's `Result` — via
  [better-result](https://better-result.dev). Expected failures belong in the
  return type, not in a `throw`, a rejected promise, or a `null` sentinel that
  conflates "absent" with "broken". `apps/client/src/lib/tauri.ts` is the model:
  one `invoke` returning `Result<T, IpcError>` that never throws, with tagged
  errors in `src/lib/errors.ts` (`TaggedError`, matched via `SomeError.is(e)`).
  See [`apps/client/CLAUDE.md`](apps/client/CLAUDE.md) for the call-site
  patterns. Reserve `throw` for unrecoverable defects (the shortcuts registry's
  module-eval validation) and for foreign interfaces that require it (monaco's
  `IFileSystemProvider`, vscode-jsonrpc) — translate at those boundaries.
  The `scripts/*.mjs` follow the same rule and are typechecked via
  `scripts/tsconfig.json` (`checkJs`), but keep `process.exit(N)` at the
  top-level CLI boundary — a non-zero exit code is the correct terminal
  behavior there, and `Result` is for the seams beneath it.
- **Frontend styling:** Tailwind + shadcn/ui only — no CSS modules, no
  hand-rolled stylesheets, no CSS-in-JS. Add components with
  `npx shadcn@latest add <name>`, don't hand-write Radix wrappers. The one
  carve-out is **animation**, where there are two idioms and the choice is not
  a preference: `tw-animate-css` classes (`data-open:animate-in …`, as the
  vendored `components/ui/*` use) for anything that animates while mounted,
  and the `motion` library for enter/exit of *dynamic lists* — a row removed
  from a backend snapshot unmounts before CSS can run, and only `motion`'s
  `AnimatePresence` can hold it on screen or `layout`-animate the rows that
  survive it. `apps/client/src/lib/rail-motion.ts` is the canonical config.
- **Every user action in the app must emit its OTel event** — event shape
  and exclusions in the `tt-telemetry` bullet in Architecture.
- **This is an agent interface, not a harness.** The classification is the
  rule. An agent interface owns the channel between the human and the agents
  in both directions — precision handing work in, comprehension getting it
  back (Karpathy's Software 3.0 framing: generation is cheap, *verification*
  is the bottleneck, and a GUI is what makes checking fast). A harness owns
  how the model does the work. Claude Code is the harness, and it gets smarter
  on a budget no one here can match; the interface is the half this repo can
  actually move. So a feature earns its place by widening the channel, never by
  trying to make the agent better at its job — that second kind can't even be
  evaluated here, since honestly improving a harness means A/B-testing against
  measured output quality, and anything cheaper is vibe testing under ten
  scenarios. The fix is never "test it better", it's "that belongs in the
  harness."

  The tell in code is a prompt authored in this repo that reads like a
  procedure — "implement it, then run /code-review, then rebase, then open the
  PR". Every prompt here asks a question and parses a JSON answer back (the
  `+` form's improvers via `task_suggest`, the calendar collectors), and every
  one is a user-editable string in settings rather than a pipeline compiled
  into the app: **a question this app acts on, never a procedure the model
  follows.** Wanting a multi-step agent workflow is legitimate — it belongs in
  `packages/core` as a slash command or skill, invoked deliberately, where
  Claude Code runs it.
- **No CLI-parity requirement.** The app is the primary product; each feature
  picks its natural surface. App-only features don't need a `tt` subcommand,
  and terminal-native tools (journal, gh, doctor) don't need app screens. The
  CLI remains the home for terminal workflows and headless entry points
  (`collect`). Either way, the logic lands in a
  Tauri-free `crates/` library with unit tests — the e2e harness is not the
  primary correctness seam.
- **Hard cutover, no back-compat shims** — replace, don't wrap. (No compat
  layers, no dual-name aliases — the `ttr`→`tt` rename left no `ttr` behind.)
- **`cargo ... | tail` reports `tail`'s exit code, not cargo's.** A failed
  build piped into `tail`/`grep`/`head` looks like success — this has already
  produced a confident "builds clean" on a build with four errors. Either
  redirect to a file and check the status separately
  (`cargo build > out.log 2>&1; echo $?`), or grep the output for `^error`
  and trust that rather than the exit code. Same trap with `set -o pipefail`
  absent in `scripts/*.sh`.
- **A measurement can outlive its subject and go *vacuous* — still reporting,
  no longer measuring.** Discarding transport errors (`let _ = …`) once let a
  harness keep "rendering" into a dead Wayland connection and report the
  embedded pane as *28% faster* than baseline, because nothing was being
  composited any more. Note the direction: removing the real work improved the
  number, so the bug arrived disguised as success. Two defences, both cheap:
  panic on the failure of whatever you are measuring *through*, and confirm
  pixels reached the screen (`cosmic-screenshot`, or a renderer-side capture
  like `tt_jarvis::jarvis::capture_frame_after` when the window may be
  offscreen) before believing any figure.
- **Test windows go on the secondary monitor.** Chris works on the primary
  while a harness runs, so a window landing there interrupts him once per run.
  Wayland clients cannot position their own toplevels; target an output by
  fullscreening on it — GTK `fullscreen_on_monitor(&screen, i)` or
  `xdg_toplevel.set_fullscreen(output)` — picking the monitor whose geometry
  `x > 0`, and no-opping on a single-monitor machine.
- **An occluded Wayland window receives no frame callbacks**, so anything
  vsync-paced stalls outright rather than slowing down, and reads as a hang.
  Correct compositor behaviour, and what the real pane wants; it also makes
  vsync arms unmeasurable on a desktop in use. Measure throughput with
  `AutoNoVsync`, in short runs — unthrottled presentation floods the
  compositor, which then hangs up with no protocol error. Monitors differ in
  refresh (60Hz secondary, 100Hz primary here), so vsync arms compare only
  within one screen.
- **Dev tooling must not hardcode ports/paths.** Chris runs multiple worktree
  tasks of this repo concurrently (see the Worktree tasks section above), so
  a fixed port, lockfile path, or other singleton resource makes copies
  collide. Ports belong in `.env.example` as `${tt:port A-B}` claims rendered
  per checkout by `tt task env` (what `scripts/dev-port.mjs` resolves) —
  never a hardcoded value like `1420`, and never a second derivation scheme
  outside the claim system.
- **No planning/implementation-notes docs committed to the repo** (e.g.
  `docs/<feature>/plan.html`, `implementation-notes.md`), even when a
  planning skill calls for writing one during implementation. Write them to
  the scratchpad directory instead — checked-in plans drift out of sync with
  the code and it's unclear which is authoritative. Git history retains any
  that were committed in the past; no need to preserve them elsewhere before
  removing.
- **TLS clients must trust the machine's trust store, not a bundled root
  list.** Chris develops behind a Zscaler-style TLS-inspecting proxy, which
  installs its own root CA into the OS trust store; `rustls` + `webpki-roots`
  (or any other bundled Mozilla root list) never sees that CA and fails to
  connect. Any new outbound HTTP/WebSocket client (`ureq`, `reqwest`,
  `tokio-tungstenite`, etc.) must be configured to verify against the OS store
  — `native-tls` (used by the Slack integration: `crates/tt-collect/src/
  slack.rs`'s `agent()`, `crates-tauri/tt-app/src/slack_socket.rs`) or an
  OS-native-roots rustls variant (e.g. `rustls-native-certs` /
  `rustls-tls-native-roots`) — never the crate's bundled-webpki-roots default.
