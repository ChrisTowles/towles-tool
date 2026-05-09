---
description: Verify the working tree is mergeable. Runs format-check, lint, typecheck, and tests. Use when asked to "verify", "check before commit", "run all checks", or before opening a PR.
allowed-tools: Bash(bun*), Read(*), Grep(*), Glob(*)
---

Run the full pre-merge gate. This mirrors the `simple-git-hooks` pre-commit checks plus the test suite.

$ARGUMENTS

## Order of operations

Run in this order; stop on the first failure and report it. Do not silently swallow errors.

1. **Format check** — `bun run format:check`
2. **Lint** — `bun run lint`
3. **Typecheck** — `bun typecheck`
4. **Tests** — `bun test`

## On failure

- Report the failing step verbatim (do not summarize away the error).
- Suggest the fix:
  - Format: `bun run format`
  - Lint: `bun run lint:fix`
  - Typecheck/tests: investigate the specific error.
- If the user asks, apply the safe auto-fixes (`format`, `lint:fix`) and re-run.

## On success

Output a single line: `verify: ok (format, lint, typecheck, test)`. Nothing else.
