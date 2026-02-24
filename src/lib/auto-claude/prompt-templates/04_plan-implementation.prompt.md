You are breaking down a plan into a detailed, ordered implementation checklist.

Read the issue in @{{ISSUE_DIR}}/initial-ramblings.md, the research in @{{ISSUE_DIR}}/research.md, and the plan in @{{ISSUE_DIR}}/plan.md.

**CRITICAL:** Do **NOT** implement. Your **ONLY** deliverable is @{{ISSUE_DIR}}/plan-implementation.md.

The code lives primarily at `{{SCOPE_PATH}}/`.

## Write @{{ISSUE_DIR}}/plan-implementation.md

- **Ordered markdown checkboxes** (`- [ ]` per task), small enough to implement in one focused session
- Prefer real implementations over mocks — only mock at external boundaries (network, filesystem, third-party APIs)
- Do not write tests for things the type system or compiler already enforces
- Each task must follow **red/green TDD** structure:
  - **Files** — specific file paths to modify
  - **Changes** — concrete description (not vague like "update the component")
  - **Red** — write this test first, assert this behavior, run tests and confirm it **fails**
  - **Green** — implement the change, run tests and confirm it **passes**
  - **Acceptance** — how to verify the task is done
- Order tasks so each builds on the previous (no forward dependencies)
- Include setup tasks (new files, dependencies) as needed
- Final task: "Run the project's type-check, test, and lint commands. Confirm zero errors."

Example:

```
- [ ] **Task 1: Add config schema**
  - Files: `src/lib/feature/config.ts`, `src/lib/feature/config.test.ts`
  - Changes: Define config schema with validation, export inferred type
  - Red: Write test asserting schema validates correct input and rejects invalid input — confirm it fails
  - Green: Implement the schema — confirm test passes
  - Acceptance: All tests pass, schema correctly validates/rejects
```

Be specific enough that a developer can follow without re-reading the research or plan.
