---
description: Interview user and create tasks for ralph autonomous loop
allowed-tools: AskUserQuestion(*), Task(*), Bash(*), Read(*), Write(*), Edit(*)
---

# Ralph Task Planning

Interview the user and create well-structured tasks for autonomous execution via `tt ralph`.

## Interview Phase

Use `AskUserQuestion` to gather:

1. **Goal**: What are you trying to build or accomplish?
2. **Done State**: What does "done" look like? How do we verify?
3. **Scope**: What files/areas will this touch?
4. **Constraints**: Patterns to follow, things to avoid?

For codebase questions, use `Task` with `subagent_type=Explore` to research existing patterns.

Keep interview focused - 3-5 questions max.

## Task Structure

Each task must have:

1. **Clear completion criteria** - How does Claude know it's done?
2. **Verifiable success** - Tests pass, typecheck passes, build works
3. **Single responsibility** - One focused outcome
4. **Self-contained context** - References specific files

### Task Template

```
[Imperative description of what to do]

Context:
- Files: [specific paths to modify]
- Patterns: [reference existing code]

Success Criteria:
- [ ] [Specific outcome]
- [ ] Tests pass: pnpm test
- [ ] Types pass: pnpm typecheck

When complete, output: <promise>TASK_DONE</promise>
```

### Good vs Bad Tasks

Good:
- "Add UserProfile type to src/types/user.ts with id, email, name fields"
- "Create getUserById in src/services/user.ts following existing service patterns"
- "Add unit tests for getUserById covering success and not-found cases"

Bad:
- "Implement user feature" (too vague)
- "Add types, service, and tests" (multiple things)
- "Make it work like the other module" (unclear reference)

## Output

1. Present proposed task list with full prompts
2. Ask for approval/modifications via `AskUserQuestion`
3. Once approved, add tasks:

```bash
tt ralph --addTask "Task 1: [full task prompt]"
tt ralph --addTask "Task 2: [full task prompt]"
```

4. Show final list:

```bash
tt ralph --listTasks
```

5. Tell user to run `tt ralph` to start autonomous execution.
