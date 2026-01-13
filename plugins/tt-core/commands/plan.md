---
title: plan
description: "Interview user and create implementation plan as ralph tasks"
allowed-tools: AskUserQuestion(*), Task(*), Bash(*), Read(*), Write(*), Edit(*)
---

Interview user, research codebase, create `tt ralph` tasks for autonomous execution.

For detailed ralph documentation, see skill `towles-tool` and its `references/ralph.md`.

## Phase 1: Interview

Use `AskUserQuestion` to gather details about:
- Technical implementation requirements
- UI & UX considerations
- Concerns and tradeoffs
- Edge cases

Ask non-obvious questions. Continue until requirements are clear (3-7 questions typically).

## Phase 2: Research

Use Task agents (`subagent_type=Explore`) to:
- Find relevant files, patterns, conventions
- Understand existing architecture
- Identify dependencies and conflicts

## Phase 3: Plan

Based on interview + research, design implementation as ordered tasks.

Each task must have:
- **Clear completion criteria** - How does Claude know it's done?
- **Verifiable success** - Tests pass, typecheck passes
- **Single responsibility** - One focused outcome
- **Self-contained context** - References specific files/patterns

Task template:
```
[Imperative description]

Context:
- Files: [specific paths to modify]
- Patterns: [reference existing code]

Success Criteria:
- [ ] [Specific outcome]
- [ ] Tests pass: pnpm test
- [ ] Types pass: pnpm typecheck
```

## Phase 4: Present & Confirm

Present the task list to user with:
1. Brief summary of approach
2. Mermaid diagram if helpful
3. Numbered task list with descriptions

Use `AskUserQuestion` to confirm or adjust.

## Phase 5: Add Tasks

**CRITICAL: Always use markers to link tasks to research sessions.**

Before starting research, generate a marker:
```bash
tt ralph marker create
# Outputs: RALPH_MARKER_abc123
```

Then tell Claude: "Output this marker: RALPH_MARKER_abc123"

Once approved, clear any old tasks and add new ones with the marker:

```bash
tt ralph clear  # Only if starting fresh
tt ralph task add "Task 1: [full description]" --findMarker abc123
tt ralph task add "Task 2: [full description]" --findMarker abc123
# ... continue for all tasks
tt ralph plan
```

The `--findMarker` flag searches ~/.claude for the session containing `RALPH_MARKER_abc123` and attaches that session ID to the task. This prevents ralph from burning tokens re-discovering context.

## Phase 6: Instruct User

Tell user:
```
Tasks ready! Start autonomous execution:

  tt ralph run --maxIterations 20

Or with auto-commits after each task:

  tt ralph run --maxIterations 20

To run without auto-commits:

  tt ralph run --no-autoCommit --maxIterations 20

Monitor progress:
  tt ralph plan                       # Full overview with mermaid graph
  tt ralph plan --copy                # Copy to clipboard
  tt ralph task list --format markdown # Task list with checkboxes
```

<examples>
**Task descriptions should read like a half-page GitHub issue** - detailed enough that Claude can execute autonomously without asking questions.

<good_task>
```bash
tt ralph task add "Add UserProfile type to src/types/user.ts

## Background
Shared type for profile data used across services and API responses.

## Requirements
- Fields: id (string, UUID), email (string), name (string), createdAt (Date)
- Export for use in other modules
- Follow patterns in src/types/post.ts

## Files
- src/types/user.ts (create)
- src/types/index.ts (add export)"

tt ralph task add "Create getUserById service function

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

tt ralph task add "Add unit tests for getUserById

## Test Cases
1. Valid ID returns user profile
2. Non-existent ID returns null
3. Empty string returns null
4. DB error propagates

## Files
- src/services/user.test.ts (create)

## Patterns
- Use vitest mocking from src/services/post.test.ts
- Mock db client"
```
</good_task>

<with_session>
```bash
tt ralph task add "Complex task requiring prior research context" --findMarker RALPH_MARKER_abc123
```
</with_session>

<bad_task>
```bash
tt ralph task add "Implement user feature"           # Too vague - no context
tt ralph task add "Add types, service, and tests"   # Multiple things in one
tt ralph task add "Make it work"                    # No criteria
tt ralph task add "Add UserProfile type"            # Too terse - missing details
```
</bad_task>
</examples>

## Optional: GitHub Issue

After tasks are added, ask if user wants a GitHub issue created summarizing the plan.
