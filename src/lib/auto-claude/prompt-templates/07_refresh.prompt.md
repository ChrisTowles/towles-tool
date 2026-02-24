You are updating an existing auto-claude branch to be compatible with the latest {{MAIN_BRANCH}}.

## Context

- Original issue: @{{ISSUE_DIR}}/initial-ramblings.md
- Checklist: @{{ISSUE_DIR}}/plan-implementation.md
- What was implemented: @{{ISSUE_DIR}}/completed-summary.md

The code lives primarily at `{{SCOPE_PATH}}/`.

## Your task

1. `git diff {{MAIN_BRANCH}}...HEAD` — what this PR changes
2. `git log {{MAIN_BRANCH}}..HEAD --oneline` — PR's commit history
3. `git diff HEAD...{{MAIN_BRANCH}}` — what {{MAIN_BRANCH}} changed since divergence
4. Check: do imports resolve? Do types/APIs still match? Conflicts with {{MAIN_BRANCH}}?
5. Fix issues directly. For merge conflicts, preserve PR intent while adopting {{MAIN_BRANCH}}'s patterns. Commit: `fix(scope): adapt to {{MAIN_BRANCH}} changes`
6. Run the project's type-check, test, and lint commands. Fix any errors.

**CRITICAL:**

- Do NOT re-implement. Only fix what broke due to {{MAIN_BRANCH}} changes.
- If {{MAIN_BRANCH}} changed so fundamentally the PR's approach is no longer viable, report `NEEDS-ATTENTION`. Do NOT force a fix.
- Do NOT push to remote. Do NOT modify plan or research files.

## Write @{{ISSUE_DIR}}/refresh-summary.md

- **Status**: UP-TO-DATE, ADAPTED, or NEEDS-ATTENTION
- **Changes made** — what broke and how you fixed it
- **Risk areas** — anything a reviewer should double-check
