---
name: ralph-planning
description: Plan and structure tasks for ralph autonomous loops. Use when breaking down features into autonomous tasks, planning ralph runs, or structuring work for tt ralph execution.
---

# Ralph Task Planning

Break down work into tasks for autonomous execution via `tt ralph`.

For full ralph documentation, see the [towles-tool skill](../towles-tool/SKILL.md) and [ralph reference](../towles-tool/references/ralph.md).

## tt ralph Quick Reference

```bash
# Task management
tt ralph plan add "{detailed-description}"    # Add task
tt ralph plan list                            # View tasks (default format)
tt ralph plan list --format markdown          # View tasks as markdown
tt ralph plan done 1                          # Mark task #1 complete
tt ralph plan remove 1                        # Remove task #1

# Plan view
tt ralph show                         # Show plan with mermaid graph
tt ralph show --format json           # Show plan as JSON
tt ralph show --copy                  # Show plan and copy to clipboard

# Execution
tt ralph run                          # Execute (auto-commits by default)
tt ralph run --no-autoCommit          # Execute without auto-commits
tt ralph run --maxIterations 10       # Safety limit
tt ralph run --taskId 5               # Focus on specific task
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

```bash
tt ralph plan add "Add UserProfile type to src/types/user.ts

## Background
Shared type for profile data used across services and API responses.

## Requirements
- Fields: id (string, UUID), email (string), name (string), createdAt (Date)
- Export for use in other modules
- Follow patterns in src/types/post.ts

## Files
- src/types/user.ts (create)
- src/types/index.ts (add export)"

tt ralph plan add "Create getUserById service function

## Background
Service function to fetch user profiles by ID.

## Requirements
- Signature: getUserById(id: string): Promise<UserProfile | null>
- Use db client from src/lib/db.ts
- Return null for non-existent users (don't throw)
- Follow patterns in src/services/post.ts

## Files
- src/services/user.ts (create)
- src/services/index.ts (add export)"

tt ralph plan add "Add unit tests for getUserById

## Test Cases
1. Valid ID returns user profile
2. Non-existent ID returns null
3. Empty string returns null
4. DB error propagates

## Files
- src/services/user.test.ts (create)"
```

</good_task>

<bad_task>

```bash
tt ralph plan add "Implement user feature"           # Too vague - no context
tt ralph plan add "Add types, service, and tests"   # Multiple things in one
tt ralph plan add "Make it work like the other one" # Unclear reference
tt ralph plan add "Add UserProfile type"            # Too terse - missing details
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

After planning, add tasks via CLI:

```bash
tt ralph plan add "Phase 1: [description with context and success criteria]"
tt ralph plan add "Phase 2: [description with context and success criteria]"
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
