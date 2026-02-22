---
name: towles-tool
description: Use towles-tool (`tt`) CLI for developer utilities, journaling, and the auto-claude pipeline for automated issue-to-PR workflows.
---

# towles-tool CLI

Personal CLI toolkit. Alias: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Auto-Claude Pipeline

Automated issue-to-PR pipeline using Claude Code. Label a GitHub issue with `auto-claude` and the pipeline handles research, planning, implementation, review, and PR creation. Auto-detects repo and main branch from cwd.

### Commands

```bash
# Process specific issue
tt auto-claude --issue 42

# Stop after planning step (review before implementation)
tt auto-claude --issue 42 --until plan

# Rebase stale PR branch onto current main
tt auto-claude --refresh --issue 42

# Reset state for an issue (force restart)
tt auto-claude --reset 42

# Start polling loop
tt auto-claude --loop

# Custom interval and limit
tt auto-claude --loop --interval 15 --limit 3
```

Alias: `tt ac --issue 42`

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
