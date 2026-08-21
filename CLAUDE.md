# CLAUDE.md

Rust rewrite of `towles-tool`: a Tauri 2 desktop app plus the `tt` CLI, modeled
on the [Yaak](https://github.com/mountain-loop/yaak) repo structure (see
[ATTRIBUTION.md](ATTRIBUTION.md)).

## Commands

```sh
cargo fmt --check                   # rustfmt, 100-col
cargo clippy --all -- -D warnings   # warnings are errors
cargo test --all                    # unit + assert_cmd black-box tests
cargo comment-budget                # comment volume — what CI gates on
bun run dev / bun start             # tauri dev (laggy) / release build + run
bun run dev:drive                   # dev, with the window automatable
bun run drive -- <verb>             # drive it (status|invoke|shot|winshot|click|…)
bun run e2e                         # regression suite vs the real shell
cd apps/client && bun run lint      # oxlint  (`bun run format` for oxfmt)
```

`clippy --all`/`test --all` need zig, webkit2gtk/GTK and a Bevy fork; without
those prereqs use CI's variant, and **a new crate needing GTK must be added to
both its `--exclude` list and the `vt_or_app` paths-filter in
`.github/workflows/ci.yml`, or it silently gets no Rust CI**. Full list, flags
and Linux gotchas: **[docs/COMMANDS.md](docs/COMMANDS.md)**. The binary is
**`tt`** — the `ttr` cutover was hard ([docs/CUTOVER.md](docs/CUTOVER.md)).

**`comment-budget` is the one gate on comment sprawl**, per-surface in
`comment-budget.toml`. `///` and `//` count, and `//!` past its first
`exempt_free` lines — not a place to move prose to. No baseline or exception
list, only `comment-budget: allow(<reason>)`, reason mandatory; an unclaimed file
is an error. **CI judges every file a PR touches, whole**, and **an error is
addressed in the PR that surfaced it** — never by narrowing the change,
`allow(…)`, or a lowered budget. The gate is `crates/comment-budget`, **the one
crate here that ships to the public**, so its CLI and config schema are someone
else's build.

**Verifying UI/IPC changes — drive the real app**, never a bare browser or the
mock dev server: `bun run dev:drive` plus a `drive` verb (`shot` is blind to the
native pane — use `winshot`), or `bun run e2e` for pass/fail. A screenshot that
looks right is not proof the render was clean: every verb prints a console-error
summary, and React reports bad markup only at runtime. **After a task that
touches the app, leave `bun start` running for Chris.**

## Worktree tasks — you are probably working in one

Tasks are branch-named git worktrees nested **inside** the checkout at
`<checkout>/.claude/worktrees/<name>/`, one per parallel line of work, created
and removed with `tt task` (`new`/`ls`/`rm`/`clean`) — never raw `git worktree`
or new clones. Claude Code's own worktree surfaces (`claude --worktree`,
background agents) are **not** tasks; nothing here renders or removes them.

The rules that bite: **the main checkout is load-bearing** (every task's git
state lives in its `.git`); **one branch per task, named after it**; **ports come
from the rendered `.env`**, never hardcoded; **never touch sibling task
directories**, since other agents work there concurrently; and **attribute a
running process to its worktree before acting on it** (`readlink
/proc/<pid>/cwd` — a bare `pkill -f "tauri dev"` hits every task, which
`.claude/hooks/guard-task-pkill.sh` rejects). "The MCP tools aren't there" means
the app for *your* checkout isn't running: each instance serves its own MCP on
its own `TT_MCP_PORT` claim. Full convention — layout, removal guards, the
`${tt:...}` env template, the rail's discovery rules:
**[docs/WORKTREE-TASKS.md](docs/WORKTREE-TASKS.md)**.

Task logic lives in `crates/tt-tasks` with shared orchestration in
`tt_tasks::ops` (the CLI and the app's `task_create` are thin shells over it);
removing a checkout goes through `tt_agentboard::task_removal` — never hand-roll
that sequence.

## Architecture

Crate by crate: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. The invariants
that decide where code goes:

- `crates/` is **Tauri-free**, a hard rule: nothing there may depend on `tauri`,
  so logic stays fast to compile and unit-testable without the shell.
- `tt-config` is **the single resolver for every mutable state path** (shared
  stores vs. per-checkout instance state) and `tt-git` is **the one way this
  workspace reads a git repository**. Never build a state path ad-hoc; nothing
  but `tt-git` runs `git`.
- `tt-tasks`' `ops::work_state` is the one answer to "has this landed?", and
  `tt-store` takes epoch-ms times **passed in**, never read from the clock.
- `tt-agentboard` holds the task-removal sequence, and **agent status is
  PTY-first**. `tt-mcp` serves one instance per checkout
  ([docs/MCP.md](docs/MCP.md)); `tt-browser` runs a real Chrome on an app-owned
  profile so **sign-ins in the pane persist**
  ([docs/BROWSER-PANE.md](docs/BROWSER-PANE.md)). `tt-codeserver` puts a **real VS Code in
  the Files pane** — one server, one workbench per checkout, the app as a
  multiplexer over the VS Code windows it replaces; Monaco stays only for the
  diff pane ([docs/CODE-SERVER.md](docs/CODE-SERVER.md)).
- TLS clients must trust the machine's trust store, not a bundled root list: a
  TLS-inspecting proxy's root CA is in the OS store and `webpki-roots` never sees
  it, so use `native-tls` or an OS-native-roots rustls variant.

`crates-cli/tt-cli` is deliberately small (`journal`, `task`, `open`): no
`collect` group, and the MCP server is not a CLI surface — **the CLI is only ever
a *client* of it**, for terminal workflows run by hand and the process boundary a
non-Rust caller needs. Every invocation emits a `cli.command` span; operands
never go in, since they are user content.

`apps/client`'s product rules — the app is for getting in the zone, agent status
is **reported, never re-rendered**, calendar is only *time until the next
meeting* — plus its conventions: [`apps/client/CLAUDE.md`](apps/client/CLAUDE.md).
`crates-tauri/tt-app`'s locking/ordering/singleton invariants are the easiest
place in the repo to introduce a subtle bug:
[`crates-tauri/tt-app/CLAUDE.md`](crates-tauri/tt-app/CLAUDE.md).

## Claude Code plugin marketplace

The repo root doubles as a plugin marketplace; `tt` (`packages/core`) and
`towles-tool-app` (`packages/app`) ship. What each contains, and where a new
hook/skill/MCP entry goes:
**[docs/PLUGIN-DISTRIBUTION.md](docs/PLUGIN-DISTRIBUTION.md)**. **Any change to
`tt task`'s surface — a new/renamed subcommand, env-template token, or lifecycle
guarantee — must update `packages/app/skills/towles-tool/SKILL.md` (and
`task-onboarding/SKILL.md` if it affects onboarding) in the same PR**: those
skills are what a session reads when asked about `tt task`.

## Conventions

Full list: **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)**. The ones that bite:

- **Hard cutover, no back-compat shims** — replace, don't wrap; no aliases.
- **This is an agent interface, not a harness.** A feature earns its place by
  widening the channel between the human and the agents, never by trying to make
  the agent better at its job. The tell in code is a prompt authored here that
  reads like a procedure; every prompt here asks a question, parses a JSON
  answer, and is user-editable in settings. Multi-step agent workflows belong in
  `packages/core` as a slash command or skill.
- **Every user action in the app emits its OTel event** — see
  [docs/TELEMETRY.md](docs/TELEMETRY.md) for the shape and the exclusions.
- **`cargo ... | tail` reports `tail`'s exit code, not cargo's**, so a failed
  build piped into `tail`/`grep`/`head` looks like success. Redirect to a file
  and check the status separately, or grep for `^error`.
- **Dev tooling must not hardcode ports/paths**, since several worktree tasks run
  concurrently; ports belong in `.env.example` as `${tt:port A-B}` claims. **No
  planning docs committed to the repo** either — those go in the scratchpad.
- **Frontend styling is Tailwind + shadcn/ui only.** The one carve-out is
  animation: `tw-animate-css` while mounted, `motion` for enter/exit.
- **No CLI-parity requirement.** The app is the primary product; each feature
  picks its natural surface, and the logic lands in a Tauri-free `crates/`
  library with unit tests. The port from the TypeScript CLI is **finished** and
  selective — [docs/MIGRATION.md](docs/MIGRATION.md) is a record, not a backlog.
