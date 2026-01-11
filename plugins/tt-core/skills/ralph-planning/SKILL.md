---
name: ralph-planning
description: Plan and structure tasks for ralph autonomous loops. Use when breaking down features into autonomous tasks, planning ralph runs, or structuring work for tt ralph execution.
---

# Ralph Task Planning

Break down work into tasks for autonomous execution via `tt ralph`.

For full ralph documentation, see the [towles-tool skill](../towles-tool/SKILL.md) and [ralph reference](../towles-tool/references/ralph.md).

## tt ralph Quick Reference

```bash
tt ralph --addTask "description"  # Add task
tt ralph --listTasks              # View tasks
tt ralph --run                    # Execute (no auto-commit)
tt ralph --run --autoCommit       # Execute with commits
tt ralph --run --maxIterations 10 # Safety limit
tt ralph --clear                  # Clean up files
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

## Good vs Bad Tasks

**Good:**
```bash
tt ralph --addTask "Add UserProfile type to src/types/user.ts with id, email, name, createdAt fields"
tt ralph --addTask "Create getUserById in src/services/user.ts following patterns in src/services/post.ts"
tt ralph --addTask "Add unit tests for getUserById covering success and not-found cases"
```

**Bad:**
```bash
tt ralph --addTask "Implement user feature"           # Too vague
tt ralph --addTask "Add types, service, and tests"   # Multiple things
tt ralph --addTask "Make it work like the other one" # Unclear reference
```

## Planning Process

1. **Understand goal** - What's the end state?
2. **Identify phases** - Logical chunks of work
3. **Order by dependency** - What must come first?
4. **Add verification** - How to confirm each step?
5. **Write clear prompts** - Standalone instructions

## Output Format

After planning, add tasks via CLI:

```bash
tt ralph --addTask "Phase 1: [description with context and success criteria]"
tt ralph --addTask "Phase 2: [description with context and success criteria]"
tt ralph --listTasks  # Verify
```

Then run:
```bash
tt ralph --run --maxIterations 20
```

## Red Flags

- "Refactor the whole..." → Break it down
- "Make it work like..." → Specify requirements
- "Fix all the..." → One fix per task
- No test command → Add verification
