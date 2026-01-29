---
title: claude
description: "Launch Claude Code for the current task or plan"
allowed-tools: Bash(*), Read(*), Glob(*), Write(*), Task(*)
---

Launch Claude Code in the appropriate mode based on context.

## Phase 1: Assess Context

Check for:
- Active Ralph plan (`tt ralph show`)
- Existing plan files in `docs/plans/`
- User-provided task description
- Branch context (feature branch vs main)

## Phase 2: Prepare Environment

1. Ensure we're in a git repo with clean working state
2. If on main, create a feature branch:
   ```bash
   git checkout -b feat/$(date +%Y%m%d)-task-name
   ```
3. If plan exists, identify incomplete tasks

## Phase 3: Launch Strategy

Based on context, choose:

### Option A: Direct Task (no plan)
If user provides a direct task:
```bash
claude --yes "[user's task]"
```

### Option B: Plan Execution (Ralph plan exists)
If Ralph has an active plan:
```bash
tt ralph run --maxIterations 15
```

### Option C: Plan File Execution
If `docs/plans/*.md` exists but not in Ralph:
```bash
# Add to Ralph and run
tt ralph plan add "docs/plans/[latest-plan].md"
tt ralph run
```

## Phase 4: Monitor & Report

After execution:
1. Summarize what was changed: `git diff --stat HEAD~5..HEAD`
2. Run tests if available: `pnpm test`
3. Report status to user

## Success Criteria

- Task completes or plan progress is made
- Code compiles/type-checks
- Tests pass (if present)
- Changes committed to feature branch

## Notes

- Never run `--dangerously-skip-permissions` without explicit user request
- Prefer `--yes` for auto-approval of file changes
- Always work on a feature branch, never directly on main
