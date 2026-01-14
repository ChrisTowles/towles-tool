---
description: Create isolated project folders for one-off tasks, experiments, and reasoning chains. Use when starting a new task, spike, or exploration that deserves its own workspace.
---

# One-Off Project Folders

One-off folders are isolated workspaces for tasks that deserve their own context - spikes, experiments, bug investigations, feature explorations, or any chain of reasoning that might branch.

## Folder Structure

```
one-offs/
├── 2025/
│   ├── 2025-12-05-switchback/
│   │   ├── README.md
│   │   └── ... project files
│   ├── 2025-12-05-api-spike/
│   └── 2025-12-06-auth-exploration/
```

**Pattern:** `one-offs/{yyyy}/{yyyy-MM-dd}-{slug}/`

- Year folder for organization
- Date prefix for chronological sorting
- Slug from title (kebab-case, lowercase)

## README Template

Each one-off gets a README.md with:

```markdown
# {Title}

**Created:** {date} {time}
**Status:** in-progress | completed | abandoned

## Goal

{What are we trying to accomplish?}

## Context / Reasoning Chain

{How did we get here? What led to this task?}

-
-
-

## Notes

## Outcome

{What was learned or decided?}
```

## When to Create One-Offs

- **Spikes**: Exploring a technical approach before committing
- **Bug investigations**: Isolating reproduction steps
- **Feature explorations**: Prototyping before implementation
- **Learning**: Trying out a new library or pattern
- **Reasoning chains**: When thoughts branch and need their own space

## Key Principles

1. **Isolation**: Each one-off is self-contained
2. **Date-first**: Easy to find recent work, easy to archive old
3. **Disposable**: Low friction to create, low cost to abandon
4. **Context preserved**: README captures the "why"

## Usage

Use the `/tt:one-off` command to create a new one-off folder:

```
/tt:one-off fix login timeout bug
/tt:one-off explore graphql subscriptions
/tt:one-off spike: redis caching layer
```

The command will:

1. Create the folder structure
2. Generate README.md with template
3. Open in your editor
