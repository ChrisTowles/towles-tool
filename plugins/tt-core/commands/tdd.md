---
description: Implement a feature or fix using strict red-green-refactor TDD
allowed-tools: Read(*), Edit(*), Write(*), Glob(*), Grep(*), Bash(*), AskUserQuestion(*)
---

Implement using strict Test-Driven Development. Red → Green → Refactor.

**Your very first code output is always a test. Never implementation first.**

$ARGUMENTS

## Process

### 1. Write a test immediately

You can almost always write a test from the request. Even if details are missing, write a test for the obvious happy path.

Examples:
- "validate email addresses" → test that a valid email returns true
- "search autocomplete component" → test that it renders and shows suggestions
- "rate limiter for API" → test that requests under the limit succeed
- "fix the auth timeout" → test that reproduces the timeout bug
- "refactor X into a service" → write characterization tests for existing X behavior first

Only ask clarifying questions when you truly cannot write any meaningful test (e.g., "add caching" with no context). After asking, STOP and wait.

**For refactoring:** always write characterization tests for the existing behavior BEFORE changing any code. This is non-negotiable. Read the existing code, then write tests that lock in its current behavior.

### 2. Red phase — write test, confirm failure

- Write a test file describing the expected behavior. This is the ONLY code in this phase.
- Run the test to confirm it fails
- Say: "Running the test to confirm it fails (Red phase)"

**After confirming the test fails, outline the full plan — do NOT write implementation code:**
- "Next: Green phase — I'll write the minimal implementation to make this test pass, then run the test to confirm it passes (Green phase). After that: Refactor phase — clean up, run all tests to confirm nothing broke, then commit."
- "Test progression: starting with the happy path, then edge cases (e.g., [list specific edge cases from the request]), then error handling."
- Then STOP. Implementation comes in the next interaction.

### 3. Green phase — minimal implementation

- Write the minimum code to make the test pass
- Run the test to confirm it passes
- Say: "Running the test to confirm it passes (Green phase)"

### 4. Refactor phase

- Clean up implementation (no behavior change)
- Run all tests — confirm nothing broke
- Commit

### 5. Repeat — next behavior

Order: happy path → edge cases → error handling → integration points

### 6. Final check

- Run full test suite
- Run typecheck (`pnpm typecheck`)
- Run lint (`pnpm lint`)
- Commit

## Rules

- **NEVER write implementation before the test.** The first code block is always a test.
- The Red phase produces ONLY a test. No implementation code in the same response.
- Tests describe behavior ("should return true for valid emails"), not implementation internals.
- Tests must fail before implementation — if they pass immediately, the test is wrong.
- Always run the test and state pass/fail at each phase.
- Each commit = one red-green-refactor cycle.
- Keep implementation minimal.
- Unsure what to test next? Ask.
