# Ralph Usage

Ralph is the autonomous Claude Code task runner.

## Behavior

- By default, ralph **auto-commits** after each completed task
- Use `--no-autoCommit` to disable auto-commits
- Use `--maxIterations` to limit token burn
- Use `--dryRun` to preview config before running

## Commands

```bash
# Plan management
tt ralph plan add --file path.md    # Add plan from file
tt ralph plan list                  # View plans
tt ralph plan done 1                # Mark plan #1 complete
tt ralph plan remove 1              # Remove plan #1

# Execution
tt ralph run                        # Run (auto-commits by default)
tt ralph run --no-autoCommit        # Run without auto-commits

# Show
tt ralph show                       # Show plan with mermaid graph
```

## State Management

When tempted to directly edit `ralph-state.json` or similar state files, use `AskUserQuestion` to ask if it should be added as a CLI feature instead.
