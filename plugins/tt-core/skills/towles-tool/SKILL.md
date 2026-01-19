---
name: towles-tool
description: Use towles-tool (`tt`) CLI for create plans to run claude code in a headless autonomous fashion.
---

# towles-tool CLI

Personal CLI toolkit. Alias: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Ralph (Autonomous Runner)

Ralph is a Claude Code autonomous runner built into `tt` for planning and executing tasks.'

It uses "plans" defined in markdown files and calls Claude Code to complete tasks iteratively in a headless manner.

### Commands

```bash
# Plan management
tt ralph plan add "path.md"         # Add plan from file
tt ralph plan list                  # View plans
tt ralph plan done 1                # Mark complete
tt ralph plan remove 1              # Remove plan

# View
tt ralph show                       # Show plan with mermaid graph
tt ralph show --copy                # Copy to clipboard

# Execution
tt ralph run                        # Run (auto-commits by default)
tt ralph run --no-autoCommit        # No auto-commits
tt ralph run --planId 5             # Focus on specific plan
tt ralph run --maxIterations 20     # Limit iterations
```

### Plan Files

Usally in `docs/plans/{YYYY}-{MM}-{DD}-{plan-goal}.md`

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
