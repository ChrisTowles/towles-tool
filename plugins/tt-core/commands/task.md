---
description: Create, list, and manage Claude Code tasks in the current session
allowed-tools: TaskCreate(*), TaskUpdate(*), TaskList(*), TaskGet(*), AskUserQuestion(*)
---

Manage tasks for the current Claude Code session. Break work into trackable steps.

$ARGUMENTS

## Behavior

### No arguments — interactive mode

Ask what the user is working on, then break it into 3-7 concrete tasks. Create all tasks via TaskCreate. Print a summary table.

### With arguments — direct creation

Parse the arguments as task descriptions. If a single sentence, create one task. If comma-separated or bulleted, create multiple tasks.

Examples:
- `/tt:task add auth middleware` → one task
- `/tt:task fix login bug, add tests, update docs` → three tasks
- `/tt:task list` → show all tasks with status
- `/tt:task done 1` → mark task 1 completed

### Subcommands

| Input | Action |
|-------|--------|
| `list` | TaskList — show all tasks with status |
| `done <id>` | TaskUpdate — mark task completed |
| `start <id>` | TaskUpdate — mark task in_progress |
| `cancel <id>` | TaskUpdate — mark task cancelled |
| _(anything else)_ | Create task(s) from the text |

## Rules

- Task descriptions should be concrete and actionable — "add X" not "think about X"
- When creating multiple tasks, order them by dependency (do first → do last)
- After creating tasks, print a numbered summary so the user can reference them
- When marking done, confirm which task was completed
- Keep task names short (under 80 chars) — details go in the description field
