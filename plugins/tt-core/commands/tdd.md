---
description: Implement a feature or fix using strict red-green-refactor TDD
allowed-tools: Read(*), Edit(*), Write(*), Glob(*), Grep(*), Bash(*), AskUserQuestion(*)
---

Implement using strict Test-Driven Development. Red → Green → Refactor.

$ARGUMENTS

## Process

### 1. Understand the target
- Read the feature description, issue, or PRD
- Explore related code to understand interfaces and patterns
- Identify the module boundaries and public interfaces

### 2. Confirm the interface
Use `AskUserQuestion` to confirm:
- What functions/methods/endpoints will be created or modified?
- What are the inputs and outputs?
- What are the error cases?

### 3. Red-Green-Refactor loop

For each behavior:

**Red:**
- Write a failing test that describes the expected behavior
- Run the test — confirm it fails with the expected error

**Green:**
- Write the minimum code to make the test pass
- Run the test — confirm it passes

**Refactor:**
- Clean up implementation (no behavior change)
- Run all tests — confirm nothing broke
- Commit

### 4. Repeat
Move to the next behavior. Work from simple to complex:
1. Happy path
2. Edge cases
3. Error handling
4. Integration points

### 5. Final check
- Run full test suite
- Run typecheck (`pnpm typecheck`)
- Run lint (`pnpm lint`)
- Commit

## Rules

- **Never write implementation before the test.**
- Tests must fail before implementation — if they pass immediately, the test is wrong.
- Each commit should be one red-green-refactor cycle.
- Keep implementation minimal — don't over-engineer ahead of tests.
- If you're unsure what to test next, ask.
