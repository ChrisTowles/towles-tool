# AgentBoard

Kanban-style orchestration board for autonomous Claude Code agents. Create cards, assign them to repos, and let agents plan, implement, and open PRs — all from a web UI.

## Features

- **Kanban board** — drag cards through Backlog → Ready → In Progress → Review → Done
- **Agent execution** — each card spawns a Claude Code session in tmux
- **Multi-step workflows** — define YAML pipelines (plan → implement → review → PR)
- **GitHub integration** — import issues, sync labels, auto-create PRs
- **Real-time updates** — WebSocket-driven board with terminal and diff viewers
- **Voice dictation** — create cards or respond to agents hands-free
- **Plan DAG view** — visualize card dependencies as a directed graph

## Prerequisites

- **tmux** — required for agent execution (`sudo apt install tmux` or `brew install tmux`)
- **Claude Code CLI** — agents run via the `claude` command
- **GITHUB_TOKEN** (optional) — enables GitHub features (issues, PRs, label sync). Export it in your shell: `export GITHUB_TOKEN=ghp_...`

## Quick Start

```bash
# Start the board (default port 4200)
tt agentboard

# Or use the short alias
tt ag

# Custom port
tt ag --port 3000

# Start without opening browser
tt ag --no-open
```

On first launch, a SQLite database is created at `~/.config/towles-tool/agentboard/agentboard.db`.

## Setup Steps

1. **Launch** — Run `tt ag` and open http://localhost:4200
2. **Add repos** — The board auto-registers repos from workspace slots
3. **Configure workspaces** — Click "Workspaces" → "+ Add Slot". Each slot is a directory where an agent will execute (a git checkout of a repo)
4. **Create a card** — Click "+ New Card", give it a title and optionally select a repo
5. **Run it** — Drag the card to "In Progress" (or "Ready" for queuing). An agent session starts in tmux
6. **Monitor** — Click a card to see live terminal output and diffs in the side panel
7. **Review** — When the agent finishes, the card moves to Review. Check the diff, then archive to Done

## Workflows

Define multi-step pipelines by adding YAML files to `.agentboard/workflows/` in any registered repo. See the Workflows page in the UI for loaded definitions.

## CLI Commands

```bash
tt ag                  # Start the board
tt ag --port 3000      # Custom port
tt ag --no-open        # Don't open browser
tt ag attach <cardId>  # Attach to a running card's tmux session
```
