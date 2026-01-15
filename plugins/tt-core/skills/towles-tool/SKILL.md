---
name: towles-tool
description: Use towles-tool (`tt`) CLI for ralph autonomous task runner, observability (token treemaps), git workflows, and journaling. Triggers when user wants ralph execution, session analysis, journal entries, git branches/PRs, or tt config.
---

# towles-tool CLI

Personal CLI toolkit. Alias: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Commands

**Ralph (autonomous runner)**
```bash
tt ralph task add "description"                      # Add task
tt ralph task add "desc" --findMarker RALPH_MARKER_x # Find session by marker
tt ralph task list                                   # View tasks
tt ralph task done 1                                 # Mark complete
tt ralph task remove 1                               # Remove task
tt ralph run                                         # Run (auto-commits, forks session)
tt ralph run --no-autoCommit                         # No auto-commits
tt ralph run --noFork                                # Fresh session
tt ralph plan                                        # Show plan with graph
tt ralph progress "message"                          # Append to progress (write-only)
tt ralph marker create                               # Generate marker
```

**Observability**
```bash
tt observe graph                 # Token treemap (alias: tt graph)
tt observe graph --session <id>  # Single session
tt observe graph --open          # Auto-open browser
tt observe session               # List recent sessions
tt observe session <id>          # Session breakdown
tt observe report                # Daily report
tt observe report --weekly       # Weekly report
tt observe setup                 # Configure settings
tt observe status                # Show config
```

**Git**
```bash
tt gh branch        # Create branch from GitHub issue
tt gh pr            # Create pull request (alias: tt pr)
tt gh branch-clean  # Delete merged branches
```

**Journaling**
```bash
tt journal daily-notes  # Weekly file, daily sections (alias: tt today)
tt journal meeting      # Meeting notes (alias: tt m)
tt journal note         # General notes (alias: tt n)
```

**Utilities**
```bash
tt config   # Show config (alias: cfg)
tt doctor   # Check dependencies
tt install  # Configure Claude Code settings
```

## Ralph Session Markers

**Session markers prevent token burn** by enabling ralph to resume from prior research instead of re-discovering context.

Workflow:
1. Generate marker: `tt ralph marker create` → `RALPH_MARKER_abc123`
2. Tell Claude to output the marker during research
3. Add task with marker: `tt ralph task add "desc" --findMarker RALPH_MARKER_abc123`

The `--findMarker` flag searches `~/.claude` for the session containing the marker and attaches the session ID to the task.

## Observability Treemaps

Token usage visualization with d3-hierarchy treemaps. Colors indicate input/output ratio (waste): green <2:1, yellow 2-5:1, red >5:1.

Use Chrome MCP tools (`mcp__claude-in-chrome__*`) to view and interact with treemaps in browser.

## Critical Rules

1. **Never read `ralph-progress.md`** - use `tt ralph progress "message"` to append (saves tokens)
2. **Always use CLI** for ralph state - never edit `ralph-state.json` directly
3. **Session markers save tokens** - use `--findMarker` to reuse research context
4. **Session forking is ON by default** - ralph forks from task's sessionId
