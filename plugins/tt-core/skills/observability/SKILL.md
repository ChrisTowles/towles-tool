---
name: observability
description: Claude Code token observability setup and analysis. Use when setting up OTEL telemetry, analyzing token usage, creating visualizations, or tracking session costs.
---

# Claude Code Observability

Track, analyze, and visualize token usage in Claude Code sessions.

## tt observe Quick Reference

```bash
# Setup
tt observe setup              # Configure settings, hooks, OTEL env vars
tt observe status             # Show current observability config

# Cost/Token Reports
tt observe report             # Daily token/cost breakdown (default)
tt observe report --weekly    # Weekly breakdown
tt observe report --monthly   # Monthly breakdown
tt observe report --output    # Save JSON to ~/.claude/reports/

# Session Analysis
tt observe session            # List recent sessions with token counts
tt observe session -n 30      # List 30 most recent sessions
tt observe session <id>       # Detailed turn-by-turn breakdown

# Treemap Visualization
tt flame                      # Generate HTML treemap of all sessions
tt flame --session <id>       # Treemap for specific session
tt flame --open               # Generate and open in browser
```

## Setup Checklist

1. **Run setup command:**

   ```bash
   tt observe setup
   ```

   This configures:
   - `cleanupPeriodDays: 99999` (prevents log deletion)
   - SubagentStop hook for lineage tracking
   - OTEL environment variables in `~/.claude/settings.json`

2. **Verify status:**

   ```bash
   tt observe status
   ```

3. **Optional: Start OTEL collector** for real-time metrics:
   ```bash
   # Using Docker Compose from Anthropic's monitoring guide
   docker-compose -f claude-code-monitoring-guide/docker-compose.yml up
   ```

## OTEL Environment Variables

These are added to `~/.claude/settings.json` by `tt observe setup`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317"
  }
}
```

## Session Data Location

Claude Code stores JSONL session files at:

```
~/.claude/projects/<encoded-directory>/<session-uuid>.jsonl
```

Each file contains:

- Full message content (user and assistant)
- Tool invocations with inputs/outputs
- Token counts per message (input_tokens, output_tokens)
- Model identifiers (claude-opus-4-5-20251101, etc.)
- Cache metrics (cache_read_tokens, cache_creation_tokens)

**Important:** Default cleanup is 30 days. The setup command sets `cleanupPeriodDays: 99999` to preserve logs.

## Treemap Visualization

The `tt flame` command generates interactive HTML treemaps:

**Hierarchy:** Project → Date → Session

**Colors indicate waste level (input/output ratio):**

- 🟢 Green (<2:1) - Efficient, good cache utilization
- 🟡 Yellow (2-5:1) - Moderate, some optimization possible
- 🔴 Red (>5:1) - High waste, lots of input tokens per output

**Tips:**

- Large rectangles = high token sessions (investigate for optimization)
- Red rectangles = high input/output ratio (poor cache hits or verbose prompts)
- Hover for details: session ID, model, tokens, ratio

## Model Pricing Reference

Use for cost estimation:

| Model                     | Input/1M | Output/1M |
| ------------------------- | -------- | --------- |
| claude-opus-4-5-20251101  | $15      | $75       |
| claude-sonnet-4-20250514  | $3       | $15       |
| claude-haiku-3-5-20241022 | $0.80    | $4        |

## Subagent Tracking

Claude Code spawns subagents via the Task tool. Track them with the SubagentStop hook:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '. + {parent: env.SESSION_ID, timestamp: now}' >> ~/.claude/reports/subagent-log.jsonl"
          }
        ]
      }
    ]
  }
}
```

**Limitation:** All hooks share the same `session_id`. Correlate parent-child by timestamp and transcript paths.

## Community Tools

| Tool                          | Install                                      | Use                  |
| ----------------------------- | -------------------------------------------- | -------------------- |
| ccusage                       | `npx ccusage@latest`                         | Cost/token analytics |
| claude-conversation-extractor | `pipx install claude-conversation-extractor` | Export to Markdown   |
| sniffly                       | `pip install sniffly`                        | Dashboard on :8081   |
| claude-code-log               | `pip install claude-code-log`                | TUI session browser  |

## Optimization Patterns

**High input/output ratio (>5:1):**

- Too much context in prompts
- Reading large files unnecessarily
- Poor cache utilization

**Solutions:**

- Use `--resume` to fork from prior sessions
- Enable cache via OTEL metrics
- Focus reads on specific line ranges

**Repeated file reads:**

- Same file read multiple times in session
- Use session detail view to identify patterns:
  ```bash
  tt observe session <id>
  ```

**Model costs:**

- Opus is 5x more expensive than Sonnet
- Use session breakdown to see model distribution
- Consider when Haiku could handle simpler tasks
