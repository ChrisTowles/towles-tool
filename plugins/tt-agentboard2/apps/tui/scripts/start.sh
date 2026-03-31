#!/usr/bin/env bash
# Start the agentboard2 TUI (tmux only).

if [ -n "${TMUX:-}" ]; then
    AGENTBOARD2_DIR="$(tmux show-environment -g AGENTBOARD2_DIR 2>/dev/null | cut -d= -f2)"
fi
AGENTBOARD2_DIR="${AGENTBOARD2_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"
TUI_DIR="$AGENTBOARD2_DIR/apps/tui"

BUN_PATH="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

cd "$TUI_DIR"
export REFOCUS_WINDOW
export AGENTBOARD2_DIR
exec "$BUN_PATH" run src/index.tsx 2>/tmp/agentboard2-err.log
