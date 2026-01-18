---
name: ralph-planning
description: Plan and structure tasks for ralph autonomous loops. Use when breaking down features into autonomous tasks, planning ralph runs, or structuring work for tt ralph execution.
---

# Ralph Task Planning

Break down work into tasks for autonomous execution via `tt ralph`.

For full ralph documentation, see the [towles-tool skill](../towles-tool/SKILL.md) and [ralph reference](../towles-tool/references/ralph.md).

## tt ralph Quick Reference

```bash
# Plan management
tt ralph plan add --file path/to/plan.md      # Add plan from file
tt ralph plan list                            # View plans (default format)
tt ralph plan list --format markdown          # View plans as markdown
tt ralph plan done 1                          # Mark plan #1 complete
tt ralph plan remove 1                        # Remove plan #1

# Plan view
tt ralph show                         # Show plan with mermaid graph
tt ralph show --format json           # Show plan as JSON
tt ralph show --copy                  # Show plan and copy to clipboard

# Execution
tt ralph run                          # Execute (auto-commits by default)
tt ralph run --no-autoCommit          # Execute without auto-commits
tt ralph run --maxIterations 10       # Safety limit
tt ralph run --planId 5               # Focus on specific plan
```

## Task Requirements

Each task **must have**:

1. **Clear completion criteria** - How does Claude know it's done?
2. **Verifiable success** - Tests pass, typecheck passes
3. **Single responsibility** - One focused outcome
4. **Self-contained context** - References specific files

Each task **must avoid**:

- Vague goals ("make it better")
- Human judgment requirements
- Multiple unrelated changes
- Missing verification steps

## Task Template

```
[Imperative description]

Context:
- Files: [specific paths]
- Patterns: [reference existing code]

Success Criteria:
- [ ] [Specific outcome]
- [ ] Tests pass: pnpm test
- [ ] Types pass: pnpm typecheck
```

<examples>
**Task descriptions should read like a half-page GitHub issue** - detailed enough that Claude can execute autonomously without asking questions.

<good_task>

Write each task to `docs/plans/tasks/` then add via CLI:

**docs/plans/tasks/01-user-profile-type.md:**

```markdown
# Add UserProfile type to src/types/user.ts

## Background

Shared type for profile data used across services and API responses.

## Requirements

- Fields: id (string, UUID), email (string), name (string), createdAt (Date)
- Export for use in other modules
- Follow patterns in src/types/post.ts

## Files

- src/types/user.ts (create)
- src/types/index.ts (add export)
```

**docs/plans/tasks/02-get-user-service.md:**

```markdown
# Create getUserById service function

## Background

Service function to fetch user profiles by ID.

## Requirements

- Signature: getUserById(id: string): Promise<UserProfile | null>
- Use db client from src/lib/db.ts
- Return null for non-existent users (don't throw)
- Follow patterns in src/services/post.ts

## Files

- src/services/user.ts (create)
- src/services/index.ts (add export)
```

**docs/plans/tasks/03-user-service-tests.md:**

```markdown
# Add unit tests for getUserById

## Test Cases

1. Valid ID returns user profile
2. Non-existent ID returns null
3. Empty string returns null
4. DB error propagates

## Files

- src/services/user.test.ts (create)
```

Then add them:

```bash
tt ralph plan add --file docs/plans/tasks/01-user-profile-type.md
tt ralph plan add --file docs/plans/tasks/02-get-user-service.md
tt ralph plan add --file docs/plans/tasks/03-user-service-tests.md
```

</good_task>

<bad_task>

Task files that are too vague or combine multiple concerns:

```markdown
# Bad: Too vague - no context

Implement user feature

# Bad: Multiple things in one task

Add types, service, and tests

# Bad: Unclear reference

Make it work like the other one

# Bad: Too terse - missing details

Add UserProfile type
```

</bad_task>
</examples>

## Planning Process

1. **Understand goal** - What's the end state?
2. **Identify phases** - Logical chunks of work
3. **Order by dependency** - What must come first?
4. **Add verification** - How to confirm each step?
5. **Write clear prompts** - Standalone instructions

## Output Format

After planning, write task files to `docs/plans/tasks/` then add via CLI:

```bash
# Write task files first (e.g., docs/plans/tasks/01-phase-one.md)
tt ralph plan add --file docs/plans/tasks/01-phase-one.md
tt ralph plan add --file docs/plans/tasks/02-phase-two.md
tt ralph show                           # Review plan with mermaid graph
tt ralph show --copy                    # Copy plan to clipboard for review
```

Then run:

```bash
tt ralph run --maxIterations 20
```

## Red Flags

- "Refactor the whole..." → Break it down
- "Make it work like..." → Specify requirements
- "Fix all the..." → One fix per task
- No test command → Add verification
