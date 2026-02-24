You are reviewing code changes for the issue in @{{ISSUE_DIR}}/initial-ramblings.md. The plan is in @{{ISSUE_DIR}}/plan.md and checklist in @{{ISSUE_DIR}}/plan-implementation.md.

## Automated checks

Run the project's type-check, test, and lint commands first. Fix any failures before manual review.

## Manual review

Run `git diff {{MAIN_BRANCH}}...HEAD` and check:

1. **Correctness** — does it implement what the plan describes?
2. **Imports** — all present and correct?
3. **Type errors** — any obvious issues?
4. **Unused code** — variables, imports, or functions added but never used?
5. **Pattern consistency** — follows existing codebase conventions?
6. **Security** — any injection vulnerabilities or unsafe operations?
7. **Edge cases** — anything that could break under unusual input?
8. **Incomplete work** — TODOs, placeholders, unfinished implementations?
9. **Test coverage** — new behaviors covered by tests? Existing tests updated?

After review, run the code-simplify skill on changed files. Apply simplifications that improve clarity without changing behavior — commit separately.

Fix issues directly, commit as `fix(scope): review fixes for issue #N`.

## Write @{{ISSUE_DIR}}/review.md

- **Status**: PASS, PASS WITH FIXES, or FAIL
  - FAIL = fundamentally broken (wrong approach, missing core functionality, unfixable regressions). Explain what's wrong.
- **Issues found** — what was wrong and what you fixed
- **Confidence level** — high/medium/low
- **Notes** — anything the PR reviewer should check
- **Recommended follow-ups** — only if genuinely valuable. Omit if nothing worth flagging.
