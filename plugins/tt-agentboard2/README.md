# AgentBoard2

Tmux sidebar TUI for monitoring sessions and AI agents. Based on [opensessions](https://github.com/nicholasgasior/opensessions).

## Why

AgentBoard v1 was a Nuxt web UI with embedded terminal rendering in the browser, built around a Kanban board workflow — create tickets, watch them move across columns as agents work. In practice, most tasks only need one or two touches before they're done, so constantly tracking which state a card is in added friction instead of removing it. The real unit of work is just a tmux session — when it's ready, merge it.

On top of that, fighting the gap between a web page and the real terminal meant losing Claude Code's native TUI goodness — keybindings, scrollback, copy/paste, all the little things that just work in a real terminal. Less is more. A tmux sidebar that lives right next to your sessions keeps everything terminal-native, no translation layer needed.

## Quick Start

```bash
# Install into tmux (one-time)
tt agentboard2 setup

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
| `t`                       | Theme picker                |
| `r`                       | Refresh                     |
| `u`                       | Show all sessions           |
| `n` / `c`                 | New session                 |
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
plugins/tt-agentboard2/
  apps/
    server/        WebSocket server (port 7392)
    tui/           OpenTUI + Solid.js terminal UI
  packages/
    runtime/       Shared types, themes, agent watchers
    mux-tmux/      Tmux provider (session/pane management)
  scripts/         Tmux keybinding scripts
  agentboard2.tmux Tmux plugin entry
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
- 19 builtin themes (Catppuccin, Tokyo Night, Gruvbox, Nord, Dracula, etc.)
- Mouse support (click, drag to resize)

## Configuration

Config file: `~/.config/towles-tool/agentboard2/config.json`

```json
{
  "theme": "catppuccin-mocha",
  "sidebarWidth": 26,
  "sidebarPosition": "left"
}
```

## CLI Commands

```bash
tt agentboard2 setup      # Install tmux plugin
tt agentboard2 uninstall  # Remove from tmux
tt agentboard2 server     # Start server manually
tt agentboard2 tui        # Start TUI manually
tt agentboard2 keys       # Show keybindings
```

## Agent Watchers

Detects and tracks AI coding agents running in tmux sessions:

- **Claude Code** - reads `~/.claude/sessions/` and project journals
- **Amp** - detects from pane titles
- **Codex** - reads `~/.codex/logs_1.sqlite`
- **OpenCode** - reads log files via `lsof`

## Themes

Press `t` in the sidebar to open the theme picker. Available themes:

catppuccin-mocha, catppuccin-latte, catppuccin-frappe, catppuccin-macchiato, tokyo-night, gruvbox-dark, nord, dracula, github-dark, one-dark, kanagawa, everforest, material, cobalt2, flexoki, ayu, aura, matrix, transparent
