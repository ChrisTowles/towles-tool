# Towles Tool (Rust)

> [!WARNING]
> **This is a personal playground.** It exists so I can learn by building. If you
> want to steer many coding agents, use
> [Claude Desktop](https://code.claude.com/docs/en/desktop-linux) — that goes for
> me too.

A [Tauri 2](https://v2.tauri.app/) desktop app plus the `tt` CLI, built for one
job: **going from steering one coding agent to steering many without going
insane.** How well the agents work is Claude Code's problem; this is the **agent
interface** around it — how I hand work in, and how I know what came back.

## Why this exists

1. **The Codex and Claude Code desktop apps didn't run on Linux.** This work
   happens on a Linux desktop, so the shell had to be built. (Claude Desktop
   [got a Linux beta](https://code.claude.com/docs/en/desktop-linux) on June 30,
   2026 — the day before this repo's first commit.)
2. **Existing tools were a good GUI or a good TUI, never both.** This app aims to
   be both: a real GUI around real terminals.

Every feature answers one question: does it widen the channel between me and the
agents — more precision going in, more understanding coming out? Making the agent
better at its job is out of scope; that belongs in a Claude Code slash command
([`packages/core`](packages/core/README.md)). The few prompts here are one shape:
ask claude a question, get JSON back, act on it — each a string you edit in
Settings, not a pipeline compiled in. The target is the space between a **dark
factory**, where you never see the code, and an **IDE**, where you see every
line. One agent fits in an IDE; a fleet doesn't fit in your head.

## Features: in towles-tool, not yet in Claude Desktop

Biggest gap first, checked against Claude Desktop 1.22209.0: **handing work to an
agent is one gesture** (a half-formed thought, a pasted screenshot, `#` to attach
an issue — and the worktree is minted); **the fleet is one screen**; **a task's
panes tile beside its terminals** (diff, file tree, a live dev-server preview you
can draw on, a native GPU pane); **attention is modelled, not guessed**; and
**where your day went is answerable** from an on-disk event log. The full tour,
and the honest overlap with Desktop: **[docs/FEATURES.md](docs/FEATURES.md)**.
Four media carry it, because none covers everything: **HTML/GUI**, **terminal**
(a real PTY, where the agents work), **git repos** (storage, and how you hand
work to someone else), and **Bevy** (3D — the newest and least built out).

## Critical goal: Solari, running natively inside the app

The app renders a live **Bevy** scene in a real region of its own window: a
native compositor surface (`wl_subsurface` on Wayland, `NSView`/`CAMetalLayer` on
macOS) sits in a rectangle of the Tauri window and Bevy draws into it on the GPU
— no WebAssembly, no frames over IPC. Only a native surface can host a hardware
ray-tracing pipeline, which settles the embedding approach; it lives in
`crates/tt-jarvis` and `crates-tauri/tt-pane`. Bevy comes from
[slyedoc/bevy](https://github.com/slyedoc/bevy), branch `solari-rt-pipeline`,
rather than crates.io (`Cargo.lock` pins the revision) — that fork is where
**Solari**, Bevy's real-time raytraced lighting, is being built, and the goal is
running it live in a tool used all day, on a real desktop with real windows.

## The two surfaces

**The desktop app** is the primary product — a day-focus shell for staying in the
zone while agents work:

- **Agentboard** — the fleet in one rail: every watched repo, its worktree tasks,
  and a live terminal per session, rendered on canvas from a real PTY (the
  `tt-vt` engine, built on libghostty-vt). Agent status is *reported, never
  re-rendered*: the app tells you a session needs attention, and you interact in
  the actual terminal, not a reconstruction of it.
- **Cockpit** — the day home: time until the next meeting (that is the entire
  calendar feature, by design), your PRs with CI status, and the issue queue.
- **Board** — cross-repo kanban: tasks link issues/PRs and usually a worktree.
- **Claude Sessions** — where the tokens went: accounting, waste insights, drill-down.

**The CLI** (`tt`) is the terminal-native half, and deliberately small: journal
and notes, worktrees (`tt task`), and `tt open`. There is no CLI/app parity — each
feature lands on its natural surface, with the shared logic in Tauri-free crates.

## Quick start

Needs Node.js 24+, a stable Rust toolchain, [zig](https://ziglang.org/) 0.15.x on
`PATH` (the `tt-vt` terminal engine builds against libghostty-vt), and on Linux
`webkit2gtk` plus the usual [Tauri system
dependencies](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run dev                        # tauri dev — the app with the Vite frontend
cargo run -p tt-cli -- task ls     # the CLI
```

## Worktree tasks

Tasks are the "handing work in" half made concrete: branch-named git worktrees
nested inside the checkout at `.claude/worktrees/<name>/`, each with its own
rendered `.env` (port-pool claims, inherited secrets) so concurrent agents never
collide. Any git checkout becomes task-capable with `tt task init`; tasks are
ephemeral, removed when the branch merges.

```sh
tt task new "Add a thing" --repo myrepo   # board task + worktree + .env, ready to work
tt task ls                                # the fleet: branches, dirty state, ports
tt task rm feat-thing                     # guarded removal — refuses to lose work
tt task clean                             # sweep every merged or gone task
```

Every entry point — CLI, Claude Code's MCP tools, or the app's `+` — runs the
same machinery. The guide: **[docs/TASKS-GUIDE.md](docs/TASKS-GUIDE.md)**; the
conventions: **[docs/WORKTREE-TASKS.md](docs/WORKTREE-TASKS.md)**; every
command: **[docs/COMMANDS.md](docs/COMMANDS.md)**.

## Claude Code plugin

The repo doubles as a Claude Code plugin marketplace. **`tt`** (in
[`packages/core`](packages/core/README.md)) packages the map-vs-territory
workflow commands — `/tt:blindspot`, `/tt:brainstorm`, `/tt:interview`,
`/tt:references` before implementation, `/tt:plan` during, `/tt:pitch`,
`/tt:comprehend`, `/tt:memories`, `/tt:handoff` after. **`towles-tool-app`**
([`packages/app`](packages/app/README.md)) bridges Claude Code to the app itself:
its MCP server over loopback HTTP, the `towles-tool` and `task-onboarding`
skills, a hook that refreshes PR/issue data after a `gh` mutation.

```sh
claude plugin marketplace add ChrisTowles/towles-tool   # `update` to pull the latest
claude plugin enable tt@towles-tool
claude plugin enable towles-tool-app@towles-tool
```

## Layout and lineage

A Cargo workspace of Tauri-free shared crates (`crates/`) plus the CLI
(`crates-cli/tt-cli`) and the Tauri shells (`crates-tauri/`), with `apps/client`
as the React frontend. Nothing in `crates/` may depend on `tauri`, so the logic
stays unit-testable without the app shell. Crate by crate:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
It is a Rust rewrite of the bun+tmux v3 version which was `towles-tool`, now archived as
[`towles-tool-tmux`](https://github.com/ChrisTowles/towles-tool-tmux), whose
tmux-based AgentBoard is kept there as a reference; the repo structure follows
the [Yaak](https://github.com/mountain-loop/yaak) golden template. The binary is
**`tt`** — the `ttr` → `tt` cutover happened 2026-07-13, hard, no alias behind it
([docs/CUTOVER.md](docs/CUTOVER.md)), and
[docs/MIGRATION.md](docs/MIGRATION.md) records what came across.

## More

- [CLAUDE.md](CLAUDE.md) — project instructions, architecture, and the worktree-task workflow
- [.claude/rules/](.claude/rules) — Rust/TypeScript conventions, auto-loaded for the files they cover
- [e2e/README.md](e2e/README.md) — driving the real app shell (live-drive + regression suite)
- [ATTRIBUTION.md](ATTRIBUTION.md) — derivation from Yaak, and its MIT license

## License
