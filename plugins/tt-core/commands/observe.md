---
description: View Claude Code token usage, costs, and session analytics
allowed-tools: Bash(tt observe:*), Bash(npx ccusage:*)
---

## Context

The `tt observe` command provides observability into Claude Code token usage and costs.

## Available Subcommands

| Command | Description |
|---------|-------------|
| `tt observe status` | Show current observability config (OTEL env vars, hooks, cleanup settings) |
| `tt observe report` | Run ccusage for cost/token breakdown (flags: --daily, --weekly, --monthly, --output) |
| `tt observe graph` | Generate Speedscope-compatible treemap graph HTML (flags: --session, --open) |
| `tt observe session` | List recent sessions with token counts and costs |
| `tt observe session <id>` | Show turn-by-turn breakdown for specific session |
| `tt observe setup` | Configure observability (set cleanupPeriodDays, add SubagentStop hook, show OTEL env vars) |

## Your Task

1. Ask the user which observe subcommand they want to run using AskUserQuestion
2. Run the appropriate `tt observe` command
3. Interpret the results:
   - **status**: Explain what's configured vs missing
   - **report**: Summarize costs, highlight high-usage models
   - **flamegraph**: Explain how to open in speedscope.app
   - **session**: Help user find sessions of interest, explain cost drivers
   - **setup**: Confirm what was configured

## Interpreting Results

### Token/Cost Analysis
- **Opus** (🔴): Most expensive ($15/1M input, $75/1M output) - check if justified
- **Sonnet** (🔵): Mid-tier ($3/1M input, $15/1M output) - good for complex tasks
- **Haiku** (🟢): Cheapest ($0.25/1M input, $1.25/1M output) - best for simple tasks

### Flamegraph Tips
- Wide bars = high token consumers
- Frame colors encode model (red=Opus, blue=Sonnet, green=Haiku)
- Open output JSON at speedscope.app for interactive visualization

### Session Analysis
- Cache read tokens reduce costs (re-using context)
- High output tokens often indicate verbose responses
- Compare token/cost across sessions to find optimization opportunities
