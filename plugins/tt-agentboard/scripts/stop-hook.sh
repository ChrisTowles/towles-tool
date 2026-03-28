#!/usr/bin/env bash
# stop-hook.sh — Called by Claude Code Stop/StopFailure/Notification hooks.
# Reads JSON from stdin, extracts hook_event_name, POSTs to AgentBoard with retry.
# Survives transient server restarts via exponential backoff.

set -euo pipefail

INPUT=$(cat)
CARD_ID="${AGENTBOARD_CARD_ID:?AGENTBOARD_CARD_ID not set}"
PORT="${AGENTBOARD_PORT:-4200}"

# Determine endpoint from hook event name
EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
case "$EVENT" in
  Stop)         ENDPOINT="complete" ;;
  StopFailure)  ENDPOINT="failure" ;;
  Notification) ENDPOINT="notification" ;;
  *)            ENDPOINT="complete" ;;
esac

URL="http://localhost:${PORT}/api/agents/${CARD_ID}/${ENDPOINT}"

MAX_RETRIES=10
DELAY=1

for i in $(seq 1 $MAX_RETRIES); do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -d "$INPUT" \
    --connect-timeout 3 \
    --max-time 10 2>/dev/null || echo "000")

  if [ "$STATUS" -ge 200 ] && [ "$STATUS" -lt 300 ]; then
    exit 0
  fi

  # Exponential backoff: 1, 2, 4, 8, 16, 32, 60, 60, 60, 60
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
  if [ "$DELAY" -gt 60 ]; then DELAY=60; fi
done

# All retries exhausted — write marker file so sweep can detect
echo "{\"cardId\":$CARD_ID,\"endpoint\":\"$ENDPOINT\",\"ts\":$(date +%s)}" \
  > "/tmp/agentboard-hook-failed-${CARD_ID}.json"
exit 1
