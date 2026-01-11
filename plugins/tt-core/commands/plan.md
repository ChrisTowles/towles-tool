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

Once approved, clear any old tasks and add new ones:

```bash
tt ralph clear  # Only if starting fresh
tt ralph task add "Task 1: [full description with context and success criteria]"
tt ralph task add "Task 2: [full description with context and success criteria]"
# ... continue for all tasks
tt ralph plan
```

For resumable tasks, attach a session ID:
```bash
tt ralph task add "Task description" --sessionId <session-id>
```

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

## Task Examples

**Good:**
```bash
tt ralph task add "Add UserProfile type to src/types/user.ts with id: string, email: string, name: string, createdAt: Date fields. Success: typecheck passes"
tt ralph task add "Create getUserById(id: string) in src/services/user.ts following patterns in src/services/post.ts. Success: function exists, typecheck passes"
tt ralph task add "Add unit tests for getUserById in src/services/user.test.ts covering: valid id returns user, invalid id throws, missing id returns null. Success: pnpm test passes"
```

**With session ID for resumable execution:**
```bash
tt ralph task add "Complex task requiring multiple sessions" --sessionId abc123
```

**Bad:**
```bash
tt ralph task add "Implement user feature"           # Too vague
tt ralph task add "Add types, service, and tests"   # Multiple things
tt ralph task add "Make it work"                    # No criteria
```

## Optional: GitHub Issue

After tasks are added, ask if user wants a GitHub issue created summarizing the plan.
