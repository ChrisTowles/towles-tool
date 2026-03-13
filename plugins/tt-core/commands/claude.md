---
title: claude
description: "Launch Claude Code for the current task or plan"
allowed-tools: Bash(*), Read(*), Glob(*), Task(*)
---

Launch Claude Code in the appropriate mode based on context.

## Steps

1. **Assess context**: Check for active Ralph plan (`tt ralph show`), plan files in `docs/plans/`, user-provided task, and branch context
2. **Prepare branch**: If on main, create feature branch (`git checkout -b feat/$(date +%Y%m%d)-task-name`). Ensure clean working state.
3. **Launch**:
   - Direct task: `claude --yes "[user's task]"`
   - Ralph plan active: `tt ralph run --maxIterations 15`
   - Plan file exists but not in Ralph: `tt ralph plan add "docs/plans/[plan].md" && tt ralph run`
4. **Report**: Summarize changes (`git diff --stat`), run tests if available, report status

## Rules

- Never use `--dangerously-skip-permissions` without explicit user request
- Prefer `--yes` for auto-approval of file changes
- Always work on a feature branch, never directly on main
