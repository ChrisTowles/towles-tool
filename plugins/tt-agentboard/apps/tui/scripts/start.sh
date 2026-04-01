#!/usr/bin/env bash
# Start the agentboard TUI (tmux only).

if [ -n "${TMUX:-}" ]; then
    TT_AGENTBOARD_DIR="$(tmux show-environment -g TT_AGENTBOARD_DIR 2>/dev/null | cut -d= -f2)"
fi
TT_AGENTBOARD_DIR="${TT_AGENTBOARD_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"
TUI_DIR="$TT_AGENTBOARD_DIR/apps/tui"

BUN_PATH="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

cd "$TUI_DIR"
export REFOCUS_WINDOW
export TT_AGENTBOARD_DIR
exec "$BUN_PATH" run src/index.tsx 2>/tmp/agentboard-err.log
