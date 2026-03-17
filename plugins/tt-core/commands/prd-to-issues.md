---
description: Break a PRD into vertical-slice GitHub issues with dependency ordering
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Bash(gh *), Bash(git *)
---

Convert a PRD into independent, parallel-friendly GitHub issues.

$ARGUMENTS

## Process

1. **Find the PRD** — Read given path, or check `docs/plans/` for recent PRDs. If none, suggest `/tt:write-prd` first.
2. **Get repo and labels**:
   - `gh repo view --json nameWithOwner --jq '.nameWithOwner'`
   - `gh label list --json name --jq '.[].name'`
3. **Draft vertical slices** — Break PRD into tasks that:
   - Are vertical slices (not horizontal layers) — each delivers testable functionality
   - Surface riskiest unknowns early
   - Can be worked in parallel where possible
   - Have clear acceptance criteria from the PRD
4. **Present breakdown** via `AskUserQuestion` — show titles, summaries, blocking relationships. Get approval before creating.
5. **Create issues** with `gh issue create`:
   - Prefix titles with conventional type (`feat:`, `fix:`, `refactor:`, `chore:`)
   - Add appropriate labels from repo
   - Include dependency info in body (Blocked by / Blocks)
   - Create in dependency order (blockers first)
6. **Report** — Table of created issues with URLs and dependency graph.

## Issue Body Template

```markdown
## Summary

[What this issue delivers]

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
