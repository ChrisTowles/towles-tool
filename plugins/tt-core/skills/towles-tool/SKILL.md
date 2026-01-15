---
name: towles-tool
description: Use towles-tool (`tt`) CLI for ralph autonomous task runner, observability (token treemaps), git workflows, and journaling. Triggers when user wants ralph execution, session analysis, journal entries, git branches/PRs, or tt config.
---

# towles-tool CLI

Personal CLI toolkit. Alias: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Ralph (Autonomous Runner)

### Task Management

```bash
tt ralph task add "description"                    # Add task
tt ralph task add "desc" --sessionId abc123        # Add with session ID
tt ralph task add "desc" --findMarker RALPH_...    # Find session by marker
tt ralph task add "desc" --label backend           # Add with label
tt ralph task list                                 # View tasks
tt ralph task done 1                               # Mark complete
tt ralph task remove 1                             # Remove task
```

### Execution

```bash
tt ralph run                        # Run (auto-commits, forks session)
tt ralph run --no-autoCommit        # No auto-commits
tt ralph run --noFork               # Fresh session (no fork)
tt ralph run --taskId 5             # Focus on specific task
tt ralph run --label backend        # Run only tasks with label
tt ralph run --maxIterations 20     # Limit iterations
tt ralph run --addIterations 5      # Add 5 to current count
tt ralph run --dryRun               # Preview config
```

### Progress & Planning

```bash
tt ralph progress "message"         # Append to progress (write-only)
tt ralph plan                       # Show plan with mermaid graph
tt ralph marker create              # Generate session marker
```

## Observability

```bash
tt graph                    # Token treemap (auto-opens browser)
tt graph --session <id>     # Single session treemap
tt graph --days 14          # Filter to last N days (default: 7)
tt graph --no-open          # Don't auto-open browser
tt graph --no-serve         # Don't start HTTP server
```

Treemap colors indicate input/output ratio: green <2:1, yellow 2-5:1, red >5:1.

## Git

```bash
tt gh branch        # Create branch from GitHub issue
tt gh pr            # Create pull request
tt gh branch-clean  # Delete merged branches
```

## Journaling

```bash
tt journal daily-notes  # Weekly file, daily sections (alias: tt today)
tt journal meeting      # Meeting notes (alias: tt m)
tt journal note         # General notes (alias: tt n)
```

## Utilities

```bash
tt config   # Show config (alias: cfg)
tt doctor   # Check dependencies
tt install  # Configure Claude Code settings
```

## Session Markers

**Markers prevent token burn** by enabling ralph to resume from prior research.

Workflow:

1. Generate marker: `tt ralph marker create` → `RALPH_MARKER_abc123`
2. Tell Claude to output marker during research
3. Add task with marker: `tt ralph task add "desc" --findMarker RALPH_MARKER_abc123`

The `--findMarker` flag searches `~/.claude` for the session containing the marker.

## Critical Rules

1. **Never read `ralph-progress.md`** - use `tt ralph progress "msg"` to append
2. **Always use CLI** for ralph state - never edit `ralph-state.json` directly
3. **Session markers save tokens** - use `--findMarker` to reuse research
4. **Session forking ON by default** - ralph forks from task's sessionId
