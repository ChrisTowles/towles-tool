#!/usr/bin/env bash

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$CURRENT_DIR/scripts"
BUN_PATH="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

# Read tmux options with defaults
key=$(tmux show-option -gqv @agentboard-key)
key=${key:-a}

# Export to tmux environment so scripts can read them
tmux set-environment -g AGENTBOARD2_DIR "$CURRENT_DIR"
tmux set-environment -g AGENTBOARD2_PORT "${AGENTBOARD2_PORT:-4201}"
tmux set-environment -g AGENTBOARD2_HOST "${AGENTBOARD2_HOST:-127.0.0.1}"

AB2_PORT="${AGENTBOARD2_PORT:-4201}"
AB2_HOST="${AGENTBOARD2_HOST:-127.0.0.1}"

# Bootstrap: install deps if missing
if [ ! -d "$CURRENT_DIR/apps/tui/node_modules" ]; then
  (cd "$CURRENT_DIR" && pnpm install >> /tmp/agentboard-install.log 2>&1 &)
fi

# Bind keybindings via command table "agentboard"
tmux bind-key -T prefix "$key" switch-client -T agentboard
tmux bind-key -T agentboard t run-shell "$BUN_PATH run $SCRIPTS_DIR/toggle.ts"
tmux bind-key -T agentboard s run-shell "$BUN_PATH run $SCRIPTS_DIR/focus.ts"

# Number keys 1-9 switch to session by index
# #{q:...} shell-escapes tmux variables to prevent injection from session names
for i in $(seq 1 9); do
  tmux bind-key -T agentboard "$i" run-shell "curl -s -X POST 'http://${AB2_HOST}:${AB2_PORT}/switch-index?index=$i' -d \"\$(tmux display-message -p '#{q:client_tty}|#{q:session_name}|#{q:window_id}')\" >/dev/null 2>&1 || true"
done

# Hooks: server manages hooks via provider.setupHooks() at runtime.
# These are fallback hooks for when the server isn't running yet (e.g. first load).
# #{q:...} shell-escapes tmux variables to prevent injection from session names.
tmux set-hook -g client-session-changed "run-shell -b \"curl -s -X POST http://${AB2_HOST}:${AB2_PORT}/focus -d \\\"\$(tmux display-message -p '#{q:client_tty}|#{q:session_name}|#{q:window_id}')\\\" >/dev/null 2>&1 || true\""
tmux set-hook -g after-select-window "run-shell -b \"curl -s -X POST http://${AB2_HOST}:${AB2_PORT}/ensure-sidebar -d \\\"\$(tmux display-message -p '#{q:client_tty}|#{q:session_name}|#{q:window_id}')\\\" >/dev/null 2>&1 || true\""

# Hook: on pane resize, sync sidebar width
tmux set-hook -g after-resize-pane "run-shell -b \"curl -s -X POST http://${AB2_HOST}:${AB2_PORT}/resize-sidebars -d \\\"\$(tmux display-message -p '#{q:pane_id}|#{q:session_name}|#{q:window_id}|#{q:pane_width}|#{q:window_width}')\\\" >/dev/null 2>&1 || true\""
