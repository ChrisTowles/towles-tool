---
name: claude-code
description: Run Claude Code CLI for autonomous coding tasks, parallel sessions, and PR reviews.
---

# Claude Code Skill

Patterns for running Claude Code (`claude`) in automated and parallel workflows.

## Quick Start

```bash
# Interactive session in a project
claude

# One-shot task (runs and exits)
claude "Add error handling to the API"

# One-shot with print mode (no file changes, just output)
claude -p "Explain the architecture of this project"
```

## Autonomous Mode

For long-running tasks without interaction:

```bash
# Full auto - approve all file changes (use in trusted projects)
claude --yes "Implement the feature described in docs/plans/my-feature.md"

# With dangerously skip permissions (no approval prompts at all)
claude --dangerously-skip-permissions "Fix all linting errors"
```

## Parallel Sessions (Git Worktrees)

Run multiple Claude Code sessions on different branches simultaneously:

```bash
# Create isolated worktrees for parallel work
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# Launch Claude in each (background)
cd /tmp/issue-78 && claude --yes "Fix issue #78: description" &
cd /tmp/issue-99 && claude --yes "Fix issue #99: description" &

# Monitor with jobs or claude-squad
jobs -l

# After completion - push and PR
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --title "fix: issue #78" --body "..."

# Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

## PR Reviews

```bash
# Review a PR (clone to temp for safety)
REVIEW_DIR=$(mktemp -d)
gh repo clone owner/repo $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 42

# Run review
claude -p "Review this PR. Run: git diff origin/main...HEAD"

# Cleanup
rm -rf $REVIEW_DIR
```

## Integration with Ralph

Combine with Ralph's plan system for structured autonomous execution:

```bash
# 1. Create plan with /tt:plan command
# 2. Add to Ralph
tt ralph plan add docs/plans/2026-01-28-my-feature.md

# 3. Run Ralph (calls Claude Code under the hood)
tt ralph run --maxIterations 20

# Or run Claude Code directly on a plan
claude --yes "Complete the tasks in docs/plans/2026-01-28-my-feature.md"
```

## Context Management

```bash
# Add files to context explicitly
claude --add-file src/api/routes.ts "Review the error handling"

# Ignore certain paths
echo "node_modules/\ndist/\n*.log" >> .claudeignore
```

## Model Selection

```bash
# Use a specific model
claude --model claude-sonnet-4-20250514 "Quick task"
claude --model claude-opus-4-20250514 "Complex refactor"
```

## Tips

- **Commit often**: Use `--yes` with auto-commit workflows so progress is saved
- **Use worktrees**: Keep main clean, run experiments in isolated worktrees
- **Plan first**: Complex tasks benefit from a written plan (use `/tt:plan`)
- **Review output**: Even in auto mode, review commits before pushing
- **Dangerously flag**: Only use `--dangerously-skip-permissions` in sandboxed environments

## Related Tools

- **claude-squad**: Manage multiple Claude Code sessions with tmux
- **crystal**: Parallel git worktrees with Codex/Claude  
- **Ralph** (`tt ralph`): Structured autonomous task runner
