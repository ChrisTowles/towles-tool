# Towles Tool (Rust)

> [!WARNING]
> **This is a personal playground.** It exists so I can learn by building.
> If you want to steer many coding agents, use
> [Claude Desktop](https://code.claude.com/docs/en/desktop-linux) instead —
> that goes for me too.

A [Tauri 2](https://v2.tauri.app/) desktop app plus the `tt` CLI, built for one
job: **going from steering one coding agent to steering many without going
insane.**

How well the agents work is Claude Code's problem. This is the **agent
interface** around it — how I hand work in, and how I know what came back.

## Why this exists

Two reasons:

1. **The Codex and Claude Code desktop apps didn't run on Linux.** This work
   happens on a Linux desktop, so the shell had to be built. (Claude Desktop
   [now has a Linux beta](https://code.claude.com/docs/en/desktop-linux) —
   released June 30, 2026, the day before this repo's first commit.)

2. **Existing tools were a good GUI or a good TUI, never both.** This app
   aims to be both: a real GUI around real terminals.

## Features: in towles-tool, not yet in Claude Desktop

Biggest gap first, checked against Claude Desktop 1.22209.0: **handing work to an
agent is one gesture** (the Agentboard `+` takes a half-formed thought, a pasted
screenshot and `#` to attach an issue, optionally through an editable prompt
improver, and mints the worktree); **the fleet is one screen** (every repo, task
and agent in one rail, with a standby board ranking blocked agents across repos);
**a task's panes tile beside its terminals** — diff, file tree, a live dev-server
preview you can draw on, and a native GPU pane; **attention is modelled, not
guessed** (PTY-first agent status, needs-you synthesis, notifications); and
**where your day went is answerable** from an on-disk event log — focused time,
gestures per screen, interruptions, and a keyboard-vs-mouse habit score.

The full tour, and the honest overlap list of what Desktop now does too:
**[docs/FEATURES.md](docs/FEATURES.md)**.

## What this is (and is not)

Claude Code is the harness. This is the **agent interface** around it —
everything between me and the agents, in both directions.

The harness improves without me, on eval budgets I'll never have. The interface
is the half I can actually move, and the half I feel every hour. Karpathy's
Software 3.0 framing is the one I keep returning to: generation is cheap,
**verification is the bottleneck**, and what speeds a human up is a GUI that
makes checking fast.

So every feature answers one question: does it widen that channel — more
precision going in, more understanding coming out? Making the agent better at its
job is out of scope: I could never afford to A/B-test whether it worked, and
anything cheaper is vibe testing under ten scenarios. That kind of feature
arrives disguised as a helpful checkbox — plan mode, then implement, review,
rebase, open the PR — which is a harness wearing a checkbox, and belongs in a
Claude Code slash command ([`packages/core`](packages/core/README.md)). The few
prompts here are one shape: ask claude a question, get JSON back, act on it, each
a string you edit in Settings rather than a pipeline compiled in.

That channel has two halves, and they're the two things this repo owns:

- **Handing work in.** One gesture: goal → branch → isolated worktree with its
  own ports, agent already started. That's `tt task` and the Agentboard `+`.
- **Understanding the work coming out.** Which session needs you *right now*,
  what each did, what it cost, and a real terminal to drop into when it's your
  turn — without re-reading every line an agent wrote.

The target is the space between a **dark factory**, where agents work and you
never see the code, and an **IDE**, where you see every line. One agent fits in an
IDE; a fleet doesn't fit in your head.

## Four media

Four ways of showing things, because none covers everything: **HTML/GUI**
(dashboards, queues, lists), **terminal** (a real PTY, where the agents work),
**git repos** (storage, and how you hand work to someone else), and **Bevy** (3D,
realistic environments — the newest and least built out).

## Critical goal: Solari, running natively inside the app

The app renders a live **Bevy** scene in a real region of its own window. A
native compositor surface (`wl_subsurface` on Wayland, `NSView`/`CAMetalLayer`
on macOS) sits in a rectangle of the Tauri window and Bevy draws into it on the
GPU — no WebAssembly, no frames streamed over IPC.

Bevy comes from [slyedoc/bevy](https://github.com/slyedoc/bevy), branch
`solari-rt-pipeline`, rather than crates.io. That fork is where **Solari**,
Bevy's real-time raytraced lighting, is being built, and the goal is to run it
live in a tool used all day — on a real desktop with real windows, not only in
engine demos. Only a native surface can host a hardware ray-tracing pipeline,
which is what settles the embedding approach.

`Cargo.lock` pins the revision, so builds stay reproducible and
`cargo update -p bevy` moves onto newer work deliberately. Upstream API churn
is the price of being close to the work.

The embedding lives in `crates/tt-jarvis` and `crates-tauri/tt-pane`.

## The two surfaces

**The desktop app** is the primary product — a day-focus shell for staying in
the zone while agents work:

- **Agentboard** — the fleet in one rail: every watched repo, its worktree
  tasks, and a live terminal per session, rendered on canvas from a real PTY
  (the `tt-vt` engine, built on libghostty-vt). Agent status is *reported,
  never re-rendered*: the app tells you a session needs attention, and you
  interact in the actual terminal, not a reconstruction of it.
- **Cockpit** — the default day home: time until the next meeting (that is the
  entire calendar feature, by design), your PRs with CI status, and the issue
  queue.
- **Board** — cross-repo kanban of tasks (#339): each links issues/PRs and usually a worktree; done rolls up from GitHub.
- **Claude Sessions** — where the tokens went: per-session accounting, ranked
  waste insights, and a turn/tool drill-down.

**The CLI** (`tt`) is the terminal-native half, and deliberately small: journal
and notes, worktrees (`tt task`), and the headless `collect` entry point
the store rides on. There is deliberately no CLI/app
parity: each feature lands on its natural surface, and the shared logic lives in
Tauri-free crates that both consume.

> **Status:** the port off the TypeScript CLI is done — the journal, worktrees,
> the data-hub store/collectors, the MCP server, the Claude Sessions screen, and
> the Agentboard screens (with live in-app terminals) all live here. New work is
> features of the app itself, not ports.

## Quick start

**Prerequisites**

- Node.js 24+
- Rust (stable toolchain)
- [zig](https://ziglang.org/) 0.15.x on `PATH` — the `tt-vt` terminal engine
  (used by the app's in-canvas terminals) builds against libghostty-vt
- Linux: `webkit2gtk` and the usual Tauri system dependencies
  (see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

**Run the desktop shell**

```sh
npm install
npm run dev      # tauri dev — launches the app with the Vite frontend
```

Each worktree picks its own dev-server port automatically, so multiple
tasks run concurrently.

**Run the CLI**

```sh
cargo run -p tt-cli -- task ls
```

## Worktree tasks

Tasks are the "handing work in" half made concrete: branch-named git worktrees
nested inside the checkout at `.claude/worktrees/<name>/`, one per parallel line
of work, each with its own rendered `.env` (port-pool claims, inherited secrets)
so concurrent agents never collide on ports or state. Any plain git checkout
becomes task-capable with `tt task init`; tasks are ephemeral — created for a
branch, removed when it merges.

```sh
tt task new "Add a thing" --repo myrepo   # board task + worktree + .env, ready to work
tt task ls                                # the fleet: branches, dirty state, ports
tt task rm feat-thing                      # guarded removal — refuses to lose work
tt task clean                              # sweep every merged or gone task
```

One gesture in, one command out, and every entry point — CLI, Claude Code's MCP
tools, or the app's `+` — runs the same machinery. The guide:
**[docs/TASKS-GUIDE.md](docs/TASKS-GUIDE.md)**; the conventions behind it:
**[docs/WORKTREE-TASKS.md](docs/WORKTREE-TASKS.md)**.

## Claude Code plugin

The repo doubles as a Claude Code plugin marketplace. The `tt` plugin (in
[`packages/core`](packages/core/README.md)) packages the map-vs-territory
workflow commands — before implementation (`/tt:blindspot`,
`/tt:brainstorm`, `/tt:interview`, `/tt:references`), plan/during
(`/tt:plan`), after (`/tt:pitch`, `/tt:comprehend`, `/tt:memories`,
`/tt:handoff`).

The `towles-tool-app` plugin (in
[`packages/app`](packages/app/README.md)) bridges Claude Code to the desktop
app itself: it registers the app's MCP server over loopback HTTP (board tasks
and the calendar family), ships the `towles-tool` CLI reference and
`task-onboarding` skills, and adds a hook that nudges a running app instance to
refresh its PR or issue data immediately after a `gh pr`/`gh issue` mutation,
instead of waiting for its normal poll interval.

Install in Claude Code:

```sh
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin enable tt@towles-tool
claude plugin enable towles-tool-app@towles-tool
```

Already installed? Pull the latest version with
`claude plugin marketplace update towles-tool`.

## Commands

The CLI binary is `tt`. Run any command with `--help` for its flags.

- `journal daily-notes|note|meeting|jot|open|list|search` — filesystem notes with date-token path templates (`today` is an alias for `daily-notes`; `jot` appends a timestamped bullet without opening an editor).
- `task init|new|ls|rm|env|ports|clean` — manage worktrees (see [Worktree tasks](#worktree-tasks) above). `ports` reports the repo's port picture (every checkout's claims merged with the registry, each probed for a listener; `--probe <port>` checks a single port instead).
- `collect calendar|issues|prs|slack|all|status|nudge <prs|issues>` — fill the local store: today's calendar via `claude -p`, assigned issues and open/review-requested PRs via `gh`, and a watched Slack DM; `status` reports each collector's health; `nudge <prs|issues>` makes a running app instance refresh that data immediately instead of waiting for its normal poll interval (used by the `towles-tool-app` plugin's `gh pr`/`gh issue` mutation hook).

## Crates

A Cargo workspace of Tauri-free shared crates (`crates/`) plus the CLI
(`crates-cli/tt-cli`, binary `tt`) and the Tauri shells (`crates-tauri/tt-app`,
`crates-tauri/tt-pane`) with `apps/client` as the React frontend. Nothing in
`crates/` may depend on `tauri`, so the logic stays unit-testable without the app
shell. Crate by crate: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Lineage

A Rust rewrite of the original TypeScript `towles-tool`, now archived as
[`towles-tool-tmux`](https://github.com/ChrisTowles/towles-tool-tmux), whose
tmux-based AgentBoard is kept there as a reference. The repo structure follows
the [Yaak](https://github.com/mountain-loop/yaak) golden template (see
[ATTRIBUTION.md](ATTRIBUTION.md)). The binary is **`tt`** — the `ttr` → `tt`
cutover happened 2026-07-13, hard, no alias left behind
([docs/CUTOVER.md](docs/CUTOVER.md)). The selective feature port is complete;
[docs/MIGRATION.md](docs/MIGRATION.md) records what came across.

## More

- [packages/core/README.md](packages/core/README.md) — the `tt` Claude Code plugin in detail
- [packages/app/README.md](packages/app/README.md) — the `towles-tool-app` Claude Code plugin in detail
- [ATTRIBUTION.md](ATTRIBUTION.md) — derivation from Yaak and its MIT license
- [docs/MIGRATION.md](docs/MIGRATION.md) — historical: the completed feature port off the TS CLI
- [.claude/rules/](.claude/rules) — Rust/TypeScript conventions, auto-loaded for the files they cover
- [e2e/README.md](e2e/README.md) — driving the real app shell (live-drive + regression suite)
- [CLAUDE.md](CLAUDE.md) — project instructions, architecture, and the worktree-task workflow

## License

