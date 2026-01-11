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
tt ralph --clear  # Only if starting fresh
tt ralph --addTask "Task 1: [full description with context and success criteria]"
tt ralph --addTask "Task 2: [full description with context and success criteria]"
# ... continue for all tasks
tt ralph --listTasks
```

## Phase 6: Instruct User

Tell user:
```
Tasks ready! Start autonomous execution:

  tt ralph --run --maxIterations 20

Or with auto-commits after each task:

  tt ralph --run --autoCommit --maxIterations 20

Monitor progress in:
  - ralph-progress.md (Claude's notes)
  - ralph-log.md (full output)
```

## Task Examples

**Good:**
```bash
tt ralph --addTask "Add UserProfile type to src/types/user.ts with id: string, email: string, name: string, createdAt: Date fields. Success: typecheck passes"
tt ralph --addTask "Create getUserById(id: string) in src/services/user.ts following patterns in src/services/post.ts. Success: function exists, typecheck passes"
tt ralph --addTask "Add unit tests for getUserById in src/services/user.test.ts covering: valid id returns user, invalid id throws, missing id returns null. Success: pnpm test passes"
```

**Bad:**
```bash
tt ralph --addTask "Implement user feature"           # Too vague
tt ralph --addTask "Add types, service, and tests"   # Multiple things
tt ralph --addTask "Make it work"                    # No criteria
```

## Optional: GitHub Issue

After tasks are added, ask if user wants a GitHub issue created summarizing the plan.
