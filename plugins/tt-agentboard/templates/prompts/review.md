You are reviewing code changes for issue #{issue}: {issue_title}.

The plan is in `.auto-claude/issue-{issue}/plan.md`.

## Automated checks

Run the project's type-check, test, and lint commands first. Fix any failures before manual review.

## Manual review

Run `git diff main...HEAD` and check:

1. **Correctness** — does it implement what the plan describes?
2. **Imports** — all present and correct?
3. **Type errors** — any obvious issues?
4. **Unused code** — variables, imports, or functions added but never used?
5. **Pattern consistency** — follows existing codebase conventions?
6. **Security** — any injection vulnerabilities or unsafe operations?
7. **Edge cases** — anything that could break under unusual input?
8. **Incomplete work** — TODOs, placeholders, unfinished implementations?
9. **Test coverage** — new behaviors covered by tests? Existing tests updated?

Fix issues directly, commit as `fix(scope): review fixes for issue #{issue}`.

## Write `.auto-claude/issue-{issue}/review.md`

**CRITICAL**: The first line of review.md must be exactly `PASS` or `FAIL` (no markdown, no prefix, just the word). This is machine-parsed.

Followed by:

- **Issues found** — what was wrong and what you fixed (if any)
- **Confidence level** — high/medium/low
- **Notes** — anything the PR reviewer should check
- **Recommended follow-ups** — only if genuinely valuable. Omit if nothing worth flagging.

### When to PASS vs FAIL

- **PASS** — implementation is correct, tests pass, code quality is acceptable. Minor fixes you made during review are fine.
- **FAIL** — fundamentally broken: wrong approach, missing core functionality, unfixable regressions, or critical bugs you cannot fix in review. Explain what's wrong and what the implementer should change.

## Guidelines

- Follow the project's coding conventions from CLAUDE.md
- Be thorough but pragmatic — don't fail for style nits
- If you fix issues during review, that's a PASS (with fixes noted), not a FAIL
