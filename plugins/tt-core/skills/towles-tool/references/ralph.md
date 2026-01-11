# Ralph Wiggum Autonomous Loop - Complete Guide

## Table of Contents
- [Philosophy](#philosophy)
- [How It Works](#how-it-works)
- [Writing Good Tasks](#writing-good-tasks)
- [Prompt Patterns](#prompt-patterns)
- [State File Format](#state-file-format)
- [When to Use Ralph](#when-to-use-ralph)
- [Cost Considerations](#cost-considerations)
- [Troubleshooting](#troubleshooting)

## Philosophy

The Ralph Wiggum technique (named after The Simpsons character) embodies persistent iteration despite setbacks. Core principles:

1. **Iteration > Perfection** - Don't aim for perfect on first try; let the loop refine
2. **Failures Are Data** - Each failure informs the next attempt
3. **Operator Skill Matters** - Success depends on writing good prompts
4. **Persistence Wins** - Keep trying until success

The fundamental insight: rather than step-by-step human guidance, define success criteria upfront and let Claude iterate toward convergence.

## How It Works

### The Loop

```
┌─────────────────────────────────────────┐
│  1. Read ralph-state.json               │
│  2. Read ralph-progress.md              │
│  3. Pick pending task (or use --taskId) │
│  4. Work on single task                 │
│  5. Run tests/typecheck                 │
│  6. Update state file (mark done)       │
│  7. Update progress file                │
│  8. Commit (if --autoCommit)            │
│  9. Check for RALPH_DONE marker         │
│  10. Loop or exit                       │
└─────────────────────────────────────────┘
```

### Iteration Prompt

Each iteration, Claude receives:
```
Review the state and progress files.

state_file: @ralph-state.json
progress_file: @ralph-progress.md

Then:
1. Choose which pending task to work on (or focus on Task #N if specified)
2. Work on that single task
3. Run type checks and tests
4. Mark the task done using CLI: tt ralph task done <id>
5. Update @ralph-progress.md with what you did
6. Make a git commit (if autoCommit enabled)

ONE TASK PER ITERATION

When ALL tasks are done, Output: <promise>RALPH_DONE</promise>
```

### Self-Referential Feedback

Each iteration sees:
- Modified files from previous work
- Git history of changes
- Updated state file with task statuses
- Progress notes from prior iterations

This creates a feedback loop where Claude builds on its own work.

## Writing Good Tasks

### Must Have

1. **Clear completion criteria** - How does Claude know it's done?
2. **Verifiable success** - Tests pass, typecheck passes, build works
3. **Single responsibility** - One focused outcome per task
4. **Self-contained context** - References specific files or patterns

### Must Avoid

- Vague goals ("make it better", "improve performance")
- Tasks requiring human judgment or design decisions
- Multiple unrelated changes in one task
- Dependencies on external systems without mocking

### Task Template

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

### Examples

**Good tasks:**
```bash
tt ralph task add "Add UserProfile type to src/types/user.ts with id, email, name, createdAt fields"
tt ralph task add "Create getUserById in src/services/user.ts following existing service patterns in src/services/post.ts"
tt ralph task add "Add unit tests for getUserById covering success, not-found, and invalid-id cases"
```

**Bad tasks:**
```bash
tt ralph task add "Implement user feature"           # Too vague
tt ralph task add "Add types, service, and tests"   # Multiple things
tt ralph task add "Make it work like the other one" # Unclear reference
tt ralph task add "Refactor the whole auth system"  # Too broad
```

## Prompt Patterns

### Incremental Goals

Break large features into phases:
```bash
tt ralph task add "Phase 1: Add auth types and JWT validation util"
tt ralph task add "Phase 2: Create auth middleware with token verification"
tt ralph task add "Phase 3: Add login/logout endpoints with tests"
tt ralph task add "Phase 4: Integrate auth middleware with protected routes"
```

### Self-Correction Pattern

Include retry logic in task description:
```
Implement feature X using TDD:
1. Write failing tests first
2. Implement minimal code to pass
3. Run tests - if fail, debug and fix
4. Refactor if needed
5. Repeat until all green
```

### Escape Hatch

Always use `--maxIterations`:
```bash
tt ralph run --maxIterations 20
```

In complex tasks, include fallback:
```
After 10 iterations if not complete:
- Document what's blocking progress
- List approaches attempted
- Suggest alternatives
```

## State File Format

`ralph-state.json`:
```json
{
  "version": 1,
  "tasks": [
    {
      "id": 1,
      "description": "Add input validation",
      "status": "done",
      "addedAt": "2025-01-10T12:00:00Z",
      "completedAt": "2025-01-10T12:15:00Z"
    },
    {
      "id": 2,
      "description": "Write validation tests",
      "status": "in_progress",
      "addedAt": "2025-01-10T12:00:00Z",
      "sessionId": "abc123..."
    },
    {
      "id": 3,
      "description": "Update API docs",
      "status": "pending",
      "addedAt": "2025-01-10T12:00:00Z"
    }
  ],
  "startedAt": "2025-01-10T12:00:00Z",
  "iteration": 5,
  "maxIterations": 10,
  "status": "running",
  "sessionId": "abc123..."
}
```

Task statuses:
- `pending` - Not started (○)
- `in_progress` - Currently working (→)
- `done` - Completed (✓)
- `hold` - On hold (⏸)
- `cancelled` - Cancelled (✗)

### Task-Level Session IDs

Tasks can have their own `sessionId` for resumable execution:
```bash
tt ralph task add "Complex task" --sessionId abc123
```

When running with `--taskId`, the run command auto-resumes using the task's sessionId if present.

### Viewing Tasks

Use `task list` to view all tasks:
```bash
tt ralph task list                    # Default format (colored terminal output)
tt ralph task list --format markdown  # Markdown with checkboxes and status badges
```

Markdown format groups tasks by status (In Progress, Pending, Done) with summary counts.

### Viewing Plan Summary

Use `plan` subcommand to get a comprehensive plan overview:
```bash
tt ralph plan                         # Markdown with summary, tasks, and mermaid graph
tt ralph plan --format json           # JSON format for programmatic use
tt ralph plan --copy                  # Also copy output to clipboard
```

The markdown format includes:
- Summary section with status, iteration progress, and task counts
- Tasks section with checkbox indicators
- Progress graph as a mermaid diagram showing task status

Loop statuses:
- `running` - Loop active
- `completed` - All tasks done (RALPH_DONE found)
- `max_iterations_reached` - Hit limit without completion
- `error` - Interrupted or failed

## When to Use Ralph

### Good For

- **Well-defined tasks** with clear success criteria
- **Iterative refinement** (getting tests to pass)
- **Greenfield projects** where you can walk away
- **Batch operations** (migrations, standardization)
- **Tasks with automatic verification** (tests, linters, typecheck)

Examples:
- "Add validation to all form inputs"
- "Migrate from library X to Y"
- "Increase test coverage to 80%"
- "Add TypeScript types to JavaScript files"

### Not Good For

- Tasks requiring **human judgment**
- **Architectural decisions**
- **Security-sensitive code** review
- **Exploratory work** with unclear goals
- **Production debugging**
- One-shot operations (use regular Claude)

## Cost Considerations

Autonomous loops burn tokens rapidly:
- 50-iteration loop on large codebase: $50-100+ API credits
- On Claude Code subscription: hits usage limits faster

Mitigate with:
- `--maxIterations` - Always set a reasonable limit
- Smaller, focused tasks - Less context per iteration
- Session forking (default) - Forks from prior session context

## Troubleshooting

### Loop won't complete

1. Check if tasks have clear completion criteria
2. Review `ralph-progress.md` for what's blocking
3. Try `--taskId N` to focus on specific stuck task
4. Reduce scope of remaining tasks

### Tasks not being marked done

Ensure tasks include verifiable criteria:
```
Success: pnpm test passes, pnpm typecheck passes
```

### Context growing too large

1. Session forking is on by default - forks from prior session
2. Clear completed tasks: manually remove `done` tasks from state
3. Split into separate ralph runs

### Interrupted loop

State is saved after each iteration. Just resume:
```bash
tt ralph run
```

Or start completely fresh:
```bash
tt ralph task add "..."
tt ralph run
```

## Resources

- Original technique: https://ghuntley.com/ralph/
- Official plugin: https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/
- Tips article: https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum
