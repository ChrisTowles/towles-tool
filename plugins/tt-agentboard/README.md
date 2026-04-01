# AgentBoard

Tmux sidebar TUI for monitoring sessions and AI agents. Based on [opensessions](https://github.com/nicholasgasior/opensessions).

## Why

AgentBoard v1 was a Nuxt web UI with embedded terminal rendering in the browser, built around a Kanban board workflow — create tickets, watch them move across columns as agents work. In practice, most tasks only need one or two touches before they're done, so constantly tracking which state a card is in added friction instead of removing it. The real unit of work is just a tmux session — when it's ready, merge it.

On top of that, fighting the gap between a web page and the real terminal meant losing Claude Code's native TUI goodness — keybindings, scrollback, copy/paste, all the little things that just work in a real terminal. Less is more. A tmux sidebar that lives right next to your sessions keeps everything terminal-native, no translation layer needed.

## Quick Start

```bash
# Install into tmux (one-time)
tt agentboard setup

# Reload tmux, then toggle the sidebar:
# prefix a t
```

## Keybindings

### Tmux (prefix defaults to `C-a`)

| Key            | Action                   |
| -------------- | ------------------------ |
| `prefix a t`   | Toggle sidebar           |
| `prefix a s`   | Focus sidebar            |
| `prefix a 1-9` | Jump to session by index |

### In Sidebar

| Key                       | Action                      |
| ------------------------- | --------------------------- |
| `Tab` / `Shift+Tab`       | Cycle sessions              |
| `j` / `k` / `Up` / `Down` | Move focus                  |
| `Enter`                   | Switch to session           |
| `1-9`                     | Jump to session             |
| `d`                       | Hide session                |
| `x`                       | Kill session (with confirm) |
| `r`                       | Refresh                     |
| `u`                       | Show all sessions           |
| `n` / `c`                 | New session (fzf picker)    |
| `?`                       | Help overlay                |
| `q`                       | Quit                        |

### Agent Detail Panel

| Key                     | Action                 |
| ----------------------- | ---------------------- |
| `Right` / `l`           | Switch to agents panel |
| `Left` / `h` / `Escape` | Back to sessions       |
| `Enter`                 | Focus agent pane       |
| `d`                     | Dismiss agent          |
| `x`                     | Kill agent pane        |
| `Alt+Up/Down`           | Reorder sessions       |

## Architecture

```
plugins/tt-agentboard/
  apps/
    server/        WebSocket server (port 4201)
    tui/           OpenTUI + Solid.js terminal UI
  packages/
    runtime/       Shared types, themes, agent watchers
    mux-tmux/      Tmux provider (session/pane management)
  scripts/         Tmux keybinding scripts
  agentboard.tmux Tmux plugin entry
```

### Server

WebSocket server on `127.0.0.1:4201`. Auto-started by the TUI or tmux scripts.

- Scans tmux sessions, git info, listening ports
- Tracks agent status (Claude Code, Amp, Codex, OpenCode)
- Broadcasts state to connected TUI clients
- HTTP endpoints for tmux hooks (`/focus`, `/toggle`, `/ensure-sidebar`, etc.)

### TUI

Solid.js app rendered via OpenTUI. Connects to server over WebSocket.

- Session cards with accent bars, status icons, branch info
- Resizable detail panel with agent list + metadata
- Mouse support (click, drag to resize)
- Help overlay (`?`)

#### TUI Components

**`SessionCard`** (`components/SessionCard.tsx`) — session list item

- Row 1: session name (truncated to 18 chars) + status icon (braille spinner when running, `●` for unseen terminal states)
- Row 2: git branch + listening port hint (`⌁4201`, or `⌁4201+2` for multiple)
- Row 3: metadata summary (status text + progress like `3/5` or `42%`)
- Left accent bar colored by state: green (current), yellow (running), red (error), peach (interrupted), lavender (focused), teal (unseen done)

**`DetailPanel`** (`components/DetailPanel.tsx`) — expanded view for focused session

- Drag-resizable separator (height persisted per session in config)
- Truncated working directory
- Agent list via `AgentListItem` sub-component (see below)
- Metadata section: status line with tone icon + progress, last 8 log entries

**`AgentListItem`** (inside `DetailPanel.tsx`) — single agent instance row

- Status icon: braille spinner (running), `◉` (waiting), `✓` (done), `✗` (error), `⚠` (interrupted)
- Agent name, thread name, status text
- Dismiss `✕` button (hover turns red), click row to focus the agent's tmux pane
- Flash animation on click

**`HelpOverlay`** (inline in `index.tsx`) — modal overlay

- Shows all keybindings in a bordered dialog
- Dismissed by pressing any key

#### TUI Utilities

- `constants.ts` — shared icons (`SPINNERS`, `UNSEEN_ICON`, `TONE_ICONS`), spark blocks for sparkline charts, theme list, tone-to-color mapping
- `mux-context.ts` — tmux detection, pane refocus after startup, client TTY and session name resolution
- `detail-panel-height.ts` — per-session detail panel height persistence (min 4 rows, default 10)

## Configuration

Config file: `~/.config/towles-tool/agentboard/config.json`

```json
{
  "theme": "catppuccin-mocha",
  "sidebarWidth": 26,
  "sidebarPosition": "left"
}
```

## CLI Commands

```bash
tt agentboard setup      # Install tmux plugin
tt agentboard uninstall  # Remove from tmux
tt agentboard server     # Start server manually
tt agentboard tui        # Start TUI manually
tt agentboard keys       # Show keybindings
tt agentboard restart    # Kill stash sessions, ensure server, toggle sidebar on
```

## Agent Watchers

Detects and tracks AI coding agents running in tmux sessions:

- **Claude Code** - reads `~/.claude/projects/` JSONL journals
- **Amp** - detects from pane titles
- **Codex** - reads `~/.codex/logs_1.sqlite`
- **OpenCode** - reads log files via `lsof`

## Themes

Theme is set via config file. Available themes:

catppuccin-mocha, catppuccin-latte, catppuccin-frappe, catppuccin-macchiato, tokyo-night, gruvbox-dark, nord, dracula, github-dark, one-dark, kanagawa, everforest, material, cobalt2, flexoki, ayu, aura, matrix, transparent
