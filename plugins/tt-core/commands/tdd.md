---
description: Implement a feature or fix using strict red-green-refactor TDD
allowed-tools: Read(*), Edit(*), Write(*), Glob(*), Grep(*), Bash(*), AskUserQuestion(*)
---

Implement using strict Test-Driven Development. Red -> Green -> Refactor.

**Your first code output is always a test. Never implementation first.**

$ARGUMENTS

## Process

### 1. Write a test immediately

Write a test from the request. Even if details are missing, test the obvious happy path.

Examples:

- "validate email addresses" -> test valid email returns true
- "rate limiter for API" -> test requests under limit succeed
- "fix the auth timeout" -> test reproducing the timeout bug
- "refactor X into a service" -> characterization tests for existing behavior first

Only ask clarifying questions when you truly cannot write any meaningful test. After asking, STOP and wait.

**For refactoring:** always write characterization tests for existing behavior BEFORE changing code. Non-negotiable.

### 2. Red phase — confirm failure

- Write test describing expected behavior. This is the ONLY code in this phase.
- Run test to confirm it fails.
- Say: "Running the test to confirm it fails (Red phase)"
- Outline full plan — do NOT write implementation yet:
  - "Next: Green phase — minimum code to pass, then Refactor phase — clean up, run all tests, commit."
  - "Test progression: happy path, then edge cases, then error handling."
- STOP. Implementation comes next interaction.

### 3. Green phase — minimum code to pass

- Write minimum code to make the test pass
- Run test to confirm it passes
- Say: "Running the test to confirm it passes (Green phase)"

### 4. Refactor phase

- Clean up (no behavior change)
- Run all tests — confirm nothing broke
- Commit

### 5. Repeat

Order: happy path -> edge cases -> error handling -> integration points

### 6. Final check

- Run full test suite, `pnpm typecheck`, `pnpm lint`
- Commit

## Rules

- **NEVER write implementation before the test.** First code block is always a test.
- Red phase produces ONLY a test. No implementation in the same response.
- Tests describe behavior, not implementation internals.
- Tests must fail before implementation — if they pass immediately, the test is wrong.
- Always run test and state pass/fail at each phase.
- Each commit = one red-green-refactor cycle.
- Keep implementation minimal.
- Unsure what to test next? Ask.
