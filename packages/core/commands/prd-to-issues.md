---
description: Break a PRD into vertical-slice GitHub issues with dependency ordering
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Bash(gh *), Bash(git *)
---

Convert a PRD into independent, parallel-friendly GitHub issues.

$ARGUMENTS

## Process

1. **Find the PRD** — Read given path or check `docs/plans/`. If none, suggest `/tt:write-prd`.
2. **Get repo and labels**:
   - `gh repo view --json nameWithOwner --jq '.nameWithOwner'`
   - `gh label list --json name --jq '.[].name'`
3. **Draft vertical slices** — testable functionality, riskiest unknowns early, parallelizable, clear acceptance criteria.
4. **Present** via `AskUserQuestion` — titles, summaries, blocking relationships. Get approval first.
5. **Create issues** with `gh issue create`:
   - Prefix: `feat:`, `fix:`, `refactor:`, `chore:`
   - Add repo labels, dependency info (Blocked by / Blocks)
   - Create in dependency order (blockers first)
6. **Report** — Table with URLs and dependency graph.

## Issue Body Template

```markdown
## Summary

[What this delivers]

## Context

From PRD: [link or reference]

## Acceptance Criteria

- [ ] ...

## Dependencies

- Blocked by: #N (if any)
- Blocks: #M (if any)
```

## Rules

- Vertical slices, not horizontal layers.
- Each issue completable in a single session.
- Riskiest slices first in ordering.
