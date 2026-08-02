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

```sh
cargo run -p tt-cli -- <args>       # the CLI (binary `tt`)
cargo fmt --check                   # rustfmt, 100-col
cargo clippy --all -- -D warnings   # warnings are errors
cargo test --all                    # unit + assert_cmd black-box tests
cargo xtask comment-budget          # comment volume — what CI gates on
npm run dev                         # tauri dev (debug build; laggy)
npm start                           # release build + run — for daily driving
npm run dev:drive                   # dev, with the window automatable
npm run drive -- <verb>             # drive that window (status|invoke|shot|click|…)
npm run e2e                         # regression suite vs the real shell
cd apps/client && npm run lint      # oxlint
cd apps/client && npm run format    # oxfmt, in place
```

`clippy --all`/`test --all` build `tt-vt` (zig 0.15.x), `tt-app`/`tt-pane`
(webkit2gtk/GTK) and `tt-jarvis` (Bevy from a git fork). Without those
prereqs use CI's variant, which excludes exactly those four — **and a new crate
needing GTK must be added to both that `--exclude` list and the `vt_or_app`
paths-filter in `.github/workflows/ci.yml`, or it silently gets no Rust CI.**

**`comment-budget` is the one gate on comment sprawl**, per-surface in
`comment-budget.toml`. `///` and `//` are counted; `//!` only for its first
`exempt_free` lines, so a module doc is not a place to move prose to. There is no
baseline and no per-file exception list, only a `comment-budget: allow(<reason>)`
directive with a mandatory reason; a file no surface claims is an error. **CI
judges every file a PR touches, whole** (`--whole-files`) — touch a file and you
own its comment volume. `--all` is the repo-wide backlog; never wire it to
`pull_request`, and never lower a budget to make either pass.
**An error is always addressed in the PR that surfaced it**, never deferred: it
is the prompt to do the cleanup that file is owed, which is the point of judging
touched files whole. Don't narrow a change to dodge one, don't reach for
`allow(…)` to keep a diff small, and don't file it as follow-up.

**Verifying UI/IPC changes — drive the real app**, never a bare browser or the
mock dev server: `npm run dev:drive` plus `node scripts/drive.mjs <verb>` for
live debugging (`shot` is blind to the native pane — use `winshot`), or
`npm run e2e` for pass/fail. A screenshot that looks right is not proof the
render was clean; every verb prints a console-error summary, and React reports
invalid markup only at runtime. **After finishing a task that touches the app,
leave `npm start` running for Chris to check.**

Full list, flags and the Linux gotchas: **[docs/COMMANDS.md](docs/COMMANDS.md)**.

> The binary is **`tt`**. The `ttr` → `tt` cutover was a hard one, no alias left
> behind ([docs/CUTOVER.md](docs/CUTOVER.md)).

## Worktree tasks — you are probably working in one

Tasks are branch-named git worktrees nested **inside** the checkout at
`<checkout>/.claude/worktrees/<name>/`, one per parallel line of work. Manage
them with `tt task` — never raw `git worktree` or new clones.

```sh
tt task new "<title>" --repo <name|dir> [-b feat/thing] [--base <ref>]
tt task ls [--json]                       # fleet: main checkout + tasks
tt task rm <name> [--force]               # guarded removal + docker cleanup
tt task clean [--dry-run]                 # every merged/gone task
```

The rules that bite: **the main checkout is load-bearing** (every task's git
state lives in its `.git`); **one branch per task, named after it**; **ports come
from the rendered `.env`**, never hardcoded; **never touch sibling task
directories**, since other agents work there concurrently; and **attribute a
running process to its worktree before acting on it** (`readlink
/proc/<pid>/cwd` — a bare `pkill -f "tauri dev"` hits every task, which
`.claude/hooks/guard-task-pkill.sh` rejects). "The MCP tools aren't there" means
the app for *your* checkout isn't running: each instance serves its own MCP on
its own `TT_MCP_PORT` claim.

Claude Code's own worktree surfaces (`claude --worktree`, background agents) are
**not** tasks — nothing here renders or removes them. A task is created
deliberately: `tt task new`, or the app's `+`.

Full convention — layout, removal guards, the `${tt:...}` env template, the
Agentboard rail's discovery rules, and why a filesystem check must not come
back: **[docs/WORKTREE-TASKS.md](docs/WORKTREE-TASKS.md)**.

Task logic lives in `crates/tt-tasks` with shared orchestration in
`tt_tasks::ops`; the CLI and the app's `task_create` are thin shells over it.
Removing a checkout goes through `tt_agentboard::task_removal` — don't hand-roll
the sequence.

## Architecture

Cargo workspace + npm workspace (`apps/client` only). Crate by crate:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

- `crates/` — **Tauri-free** shared libraries, and that is a hard rule: nothing
  here may depend on `tauri`, so logic stays fast to compile and unit-testable
  without the app shell. `tt-config` (settings + **the single resolver for every
  mutable state path**, shared stores vs. per-checkout instance state),
  `tt-exec`, `tt-journal`, `tt-git` (**the one way this workspace reads a git
  repository** — in-process gitoxide; nothing else runs `git`), `tt-tasks` (the
  worktree convention; `ops::work_state` is the one answer to "has this
  landed?"), `tt-store` (SQLite data hub; epoch-ms times passed in, never read
  from the clock), `tt-collect`, `tt-mcp` (`preview_file` renders a file, `file_open`
  reveals one — [docs/MCP.md](docs/MCP.md)),
  `tt-telemetry` ([docs/TELEMETRY.md](docs/TELEMETRY.md)), `tt-ide`, `tt-vt`,
  `tt-jarvis` ([docs/NATIVE-PANE.md](docs/NATIVE-PANE.md)),
  `tt-browser` (a real Chrome on an app-owned profile so **sign-ins made in
  the pane persist**; CDP frames onto a canvas, Linux *and* macOS —
  [docs/BROWSER-PANE.md](docs/BROWSER-PANE.md)), `tt-agentboard`
  (**agent status is PTY-first**, and the one home of the task-removal
  sequence), `tt-claude-sessions`, `tt-claude-code`, `tt-doctor`, `tt-update`.
- `crates-cli/tt-cli` — `clap` 4, binary `tt`, deliberately small: `journal`,
  `task`, and `open <path>[:<line>]`. There is no `collect` group and the MCP
  server is not a CLI surface — **the CLI is only ever a *client* of it**:
  `tt open` POSTs the `file_open` tool call to the instance serving this
  checkout, so the file lands beside the terminal it was typed in. It makes no
  editor decision of its own (no `preferredEditor` spawn, no fallback), because a
  command whose behavior depends invisibly on whether a window is up is worse
  than one that says the window isn't up. The per-checkout port therefore lives
  in `tt_mcp::port`, where both ends read it rather than in the transport.
  What the CLI is *for* narrowed to two things: terminal workflows run by hand,
  and the process boundary a non-Rust caller needs (`scripts/task-port.mjs`,
  `gh-pr-nudge.sh` → `tt task nudge`). Every invocation emits a `cli.command`
  span; operands never go in, since they are user content.
- `crates-tauri/tt-app` — the Tauri 2.11 shell, identifier `dev.towles.tool`,
  ports resolved per checkout from the rendered `.env` (never a hardcoded 1420).
  Its locking/ordering/singleton invariants are the easiest place in the repo to
  introduce a subtle bug:
  [`crates-tauri/tt-app/CLAUDE.md`](crates-tauri/tt-app/CLAUDE.md).
- `apps/client` — React 19 + Vite + Tailwind v4 + shadcn/ui, Yaak-style shell
  (resizable sidebar as the only nav, ⌘K palette, screens stay mounted across
  switches). Three Focus screens: **Agentboard** (repos + per-repo terminals;
  the cold-start screen), **Cockpit**, **Board**. Terminals are a canvas renderer
  over `tt-vt` state with the PTY host in Rust — no cross-restart persistence.
  Product rules: the app is for getting in the zone; agent status is **reported,
  never re-rendered**; calendar is only *time until the next meeting*.
  Frontend-internal conventions: [`apps/client/CLAUDE.md`](apps/client/CLAUDE.md).

## Claude Code plugin marketplace

The repo root doubles as a plugin marketplace
(`.claude-plugin/marketplace.json`); each plugin lives in `packages/<name>/`
with its own manifest. Two ship today: **`tt`** (`packages/core`) — the
map-vs-territory workflow commands/skills — and **`towles-tool-app`**
(`packages/app`), which bridges Claude Code to the app itself: the MCP server
via a static checked-in `.mcp.json`, the `towles-tool` and `task-onboarding`
skills, and a `PostToolUse` hook that nudges a running instance to refresh PR or
issue data after a `gh pr`/`gh issue` mutation. It's meant to be enabled
globally, so its hook fails open outside a relevant session — don't drop that
guard. A new hook/skill/MCP entry belongs in a plugin package, not loose in
`.claude/` (which is for hooks scoped to *this repo's* sessions).

**Any change to `tt task`'s surface — a new/renamed subcommand, a new
env-template token, a changed lifecycle guarantee — must update
`packages/app/skills/towles-tool/SKILL.md` (and `task-onboarding/SKILL.md` if it
affects onboarding) in the same PR.** Those skills are what a Claude Code
session reads when asked about `tt task`; a feature landing only in
`crates/tt-tasks` is invisible to it. Any commit touching a plugin package is
auto-checked by `.githooks/pre-commit`, which bumps the version and validates
the manifests. Distribution: [docs/PLUGIN-DISTRIBUTION.md](docs/PLUGIN-DISTRIBUTION.md).

## Migration

The port from the TypeScript CLI is **finished** —
[docs/MIGRATION.md](docs/MIGRATION.md) is a historical record, not a backlog.
Porting was selective, so don't treat something described there as owed.

## Conventions

The full list is **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)**. The ones that
bite hardest:

- **Hard cutover, no back-compat shims** — replace, don't wrap. No compat
  layers, no dual-name aliases.
- **This is an agent interface, not a harness.** A feature earns its place by
  widening the channel between the human and the agents, never by trying to make
  the agent better at its job. The tell in code is a prompt authored here that
  reads like a procedure; every prompt here asks a question and parses a JSON
  answer, and is user-editable in settings. Multi-step agent workflows belong in
  `packages/core` as a slash command or skill.
- **Every user action in the app emits its OTel event** — see
  [docs/TELEMETRY.md](docs/TELEMETRY.md) for the shape and the exclusions.
- **`cargo ... | tail` reports `tail`'s exit code, not cargo's.** A failed build
  piped into `tail`/`grep`/`head` looks like success. Redirect to a file and
  check the status separately, or grep for `^error`.
- **Dev tooling must not hardcode ports/paths.** Several worktree tasks run
  concurrently; ports belong in `.env.example` as `${tt:port A-B}` claims.
- **No planning/implementation-notes docs committed to the repo** — write them
  to the scratchpad directory instead.
- **TLS clients must trust the machine's trust store, not a bundled root list**
  — a TLS-inspecting proxy's root CA is in the OS store, and `webpki-roots`
  never sees it. Use `native-tls` or an OS-native-roots rustls variant.
- **Frontend styling is Tailwind + shadcn/ui only.** The one carve-out is
  animation: `tw-animate-css` while mounted, `motion` for enter/exit of dynamic
  lists (a row removed from a backend snapshot unmounts before CSS can run).
- **No CLI-parity requirement.** The app is the primary product; each feature
  picks its natural surface, and the logic lands in a Tauri-free `crates/`
  library with unit tests.
