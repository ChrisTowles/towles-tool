---
name: ralph-planning
description: Plan and structure tasks for ralph autonomous loops. Use when breaking down features into autonomous tasks, planning ralph runs, or structuring work for tt ralph execution.
---

# Ralph Task Planning

Break down work into tasks for autonomous execution via `tt ralph`.

For full ralph documentation, see the [towles-tool skill](../towles-tool/SKILL.md) and [ralph reference](../towles-tool/references/ralph.md).

## tt ralph Quick Reference

```bash
# Marker workflow (CRITICAL for token efficiency)
tt ralph marker create                        # Generate marker for session tracking
# Then tell Claude to output the marker during research
tt ralph task add "{detailed-description}" --findMarker <marker> # Find session by marker

# Task management
tt ralph task add "{detailed-description}"               # Add task (no session)
tt ralph task add "{detailed-description}" --findMarker <m>     # Add task, find session by marker
tt ralph task list                            # View tasks (default format)
tt ralph task list --format markdown          # View tasks as markdown
tt ralph task done 1                          # Mark task #1 complete
tt ralph task remove 1                        # Remove task #1

# Plan view
tt ralph plan                         # Show plan with mermaid graph
tt ralph plan --format json           # Show plan as JSON
tt ralph plan --copy                  # Show plan and copy to clipboard

# Execution
tt ralph run                          # Execute (auto-commits, auto-resumes by default)
tt ralph run --no-autoCommit          # Execute without auto-commits
tt ralph run --maxIterations 10       # Safety limit
tt ralph run --taskId 5               # Focus on specific task
tt ralph run --noResume               # Start fresh session (rare)
```

## CRITICAL: Session Markers Prevent Token Burn

**Every task should have a sessionId** to resume from prior research. Use markers to link research sessions to tasks:

1. **Generate marker before research**: `tt ralph marker create` → outputs `RALPH_MARKER_abc123`
2. **Tell Claude to output the marker** during research (Claude will echo it in conversation)
3. **Add task with marker**: `tt ralph task add "implement X" --findMarker abc123`
4. This finds the session containing the marker and attaches it to the task

This workflow prevents ralph from burning tokens re-discovering context that was already researched.

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
- src/services/user.test.ts (create)"
```

</good_task>

<bad_task>

```bash
tt ralph task add "Implement user feature"           # Too vague - no context
tt ralph task add "Add types, service, and tests"   # Multiple things in one
tt ralph task add "Make it work like the other one" # Unclear reference
tt ralph task add "Add UserProfile type"            # Too terse - missing details
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
tt ralph task add "Phase 1: [description with context and success criteria]"
tt ralph task add "Phase 2: [description with context and success criteria]"
tt ralph plan                           # Review plan with mermaid graph
tt ralph plan --copy                    # Copy plan to clipboard for review
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
