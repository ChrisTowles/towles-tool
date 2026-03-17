---
name: auto-claude
description: Use the auto-claude pipeline (`tt auto-claude` / `tt ac`) for automated issue-to-PR workflows — labels a GitHub issue, then runs plan → implement → simplify → review autonomously.
---

# Auto-Claude Pipeline

Automated issue-to-PR pipeline. Label a GitHub issue with `auto-claude` and the pipeline runs Claude Code locally through 4 steps: **plan → implement → simplify → review**.

## Pipeline Steps

1. **Plan** — Research, planning, and annotations. Produces `plan.md`.
2. **Implement** — Executes the plan: writes code, tests, commits. Produces `completed-summary.md`.
3. **Simplify** — Code-simplify pass: removes dead code, simplifies logic. Produces `simplify-summary.md`.
4. **Review** — Automated review outputs `PASS` or `FAIL` on first line of `review.md`.

## Label Flow

1. Issue labelled `auto-claude` triggers the pipeline.
2. Pipeline removes `auto-claude`, adds `auto-claude-in-progress`.
3. On success: removes `auto-claude-in-progress`, adds `auto-claude-review`, creates PR.
4. On failure: removes `auto-claude-in-progress`, adds `auto-claude-failed`.

## Retry Behavior

If review outputs FAIL, the pipeline loops back to **implement → simplify → review** (clearing previous artifacts). Configurable via `maxReviewRetries` (default 2), so up to 3 total attempts.

## CLI Commands

```bash
# Process specific issue
tt auto-claude --issue 42
tt ac --issue 42

# Stop after planning step (review before implementation)
tt ac --issue 42 --until plan

# Rebase stale PR branch onto current main
tt ac --refresh --issue 42

# Reset state for an issue (force restart)
tt ac --reset 42

# Start polling loop (default 30min interval)
tt ac --loop

# Custom interval and limit
tt ac --loop --interval 15 --limit 3

# Interactively pick an auto-claude issue to process
tt ac list
```

## Config

Auto-detects repo and main branch from cwd. Key settings:

| Field | Default | Description |
|---|---|---|
| `triggerLabel` | `auto-claude` | Label that triggers the pipeline |
| `model` | `opus` | Claude model to use |
| `maxReviewRetries` | `2` | Review failure retries |
| `loopIntervalMinutes` | `30` | Polling interval for loop mode |
| `maxImplementIterations` | `5` | Max Claude turns per implement step |

## Conventions

- Artifacts: `.auto-claude/issue-{N}/`
- Branch naming: `auto-claude/issue-{N}`
- Steps are idempotent — check for output artifact before running
- `--until <step>` pauses pipeline after the named step
