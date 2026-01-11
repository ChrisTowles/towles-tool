---
name: towles-tool
description: Use towles-tool (`tt`) CLI for development workflows. Triggers when user wants to create journal entries (daily notes, meetings), generate commit messages, create git branches from GitHub issues, run ralph autonomous task loops, or manage tt config. Also use when discussing autonomous Claude Code execution, ralph wiggum technique, or AFK coding.
---

# towles-tool CLI

Personal CLI toolkit for daily development workflows. Alias: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Commands Quick Reference

| Command | Alias | Purpose |
|---------|-------|---------|
| `tt journal` | `j` | Create markdown journal files |
| `tt git-commit` | `gc` | Generate/use commit messages |
| `tt gh-branch` | `br` | Create branch from GitHub issue |
| `tt config` | `cfg` | Manage settings |
| `tt ralph` | - | Autonomous task runner |
| `tt completion` | - | Shell completions |

## Journal (`tt j`)

Creates markdown files from templates with date-based paths.

```bash
tt j daily-notes    # Weekly file, sections per day (alias: today)
tt j meeting TITLE  # Meeting notes (alias: m)
tt j note TITLE     # General notes (alias: n)
```

Path templates in config use Luxon tokens: `{yyyy}`, `{MM}`, `{dd}`, `{monday:yyyy}` etc.

Default paths:
- Daily: `journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md`
- Meeting: `journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md`
- Note: `journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md`

## Git Commit (`tt gc`)

```bash
tt gc              # Interactive: shows status, prompts for message
tt gc "message"    # Direct commit with message
```

Workflow:
1. Shows staged/unstaged/untracked files
2. If nothing staged, offers to `git add .`
3. Prompts for message if not provided
4. Creates commit

## GitHub Branch (`tt br`)

Creates feature branches from GitHub issues. Requires `gh` CLI.

```bash
tt br                  # All open issues (fuzzy search)
tt br --assignedToMe   # Only your assigned issues
```

Branch format: `feature/{issue-number}-{slugified-title}`

## Config (`tt cfg`)

Opens settings file in editor. Creates defaults on first run.

Settings schema:
```json
{
  "preferredEditor": "code",
  "journalSettings": {
    "baseFolder": "~",
    "dailyPathTemplate": "...",
    "meetingPathTemplate": "...",
    "notePathTemplate": "..."
  }
}
```

## Ralph - Autonomous Task Runner

Ralph implements the "Ralph Wiggum" technique for autonomous Claude Code execution. See [references/ralph.md](references/ralph.md) for complete guide.

### Quick Start

```bash
# Add tasks
tt ralph --addTask "implement user validation in src/utils/validate.ts"
tt ralph --addTask "add tests for validation in src/utils/validate.test.ts"

# Review
tt ralph --listTasks

# Execute
tt ralph --run                    # No auto-commit (default)
tt ralph --run --autoCommit       # Commit after each task
tt ralph --run --maxIterations 5  # Limit iterations
```

### Task Management

```bash
tt ralph --addTask "desc"   # Add task (min 3 chars)
tt ralph --listTasks        # View all tasks with status
tt ralph --clear            # Remove all ralph files
tt ralph --dryRun           # Preview config without running
```

### Execution Options

| Flag | Description |
|------|-------------|
| `--run` | Start loop (required) |
| `--autoCommit` | Git commit after each task |
| `--maxIterations N` | Safety limit (default: 10) |
| `--taskId N` | Focus on specific task |
| `--resume` | Continue with session context |

### Files Created

- `ralph-state.json` - Task list and loop state
- `ralph-progress.md` - Claude's progress notes
- `ralph-log.md` - Full output log
- `ralph-history.log` - JSON lines per iteration

## Critical Rules

1. **Always use CLI** for ralph state - never edit `ralph-state.json` directly
2. **Run `tt cfg`** before journal commands to set `baseFolder`
3. **Set `--maxIterations`** as safety net - autonomous loops burn tokens
4. **One task = one outcome** - break complex work into focused tasks
5. **Include verification** in tasks - "tests pass", "typecheck passes"
