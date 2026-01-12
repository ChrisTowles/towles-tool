# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a dual-purpose repository:
1. **CLI tool** (`tt`) - Collection of quality-of-life scripts for daily development workflows (distributed as compiled executable)
2. **Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use

The project evolved from a private toolbox of personal scripts to a compiled Bun executable and Claude Code plugin marketplace.

## Commands

### Development
```bash
bun run start           # Run the CLI directly with bun
bun run typecheck       # Run TypeScript type checking (no emit)
```

### Build
```bash
bun run build           # Build executable for current platform
bun run build:linux     # Build for Linux x64
bun run build:macos     # Build for macOS ARM64
bun run build:windows   # Build for Windows x64
bun run build:all       # Build for all platforms
```

### Testing
```bash
bun run test            # Run all tests with bun test
bun run test:watch      # Run tests in watch mode
```

### Linting
```bash
bun run lint            # Run oxlint
bun run lint:fix        # Auto-fix linting issues
```

## Architecture

### CLI Application Structure

**Entry point**: `bin/run.ts` - oclif command router
- Loads settings from `~/.config/towles-tool/towles-tool.settings.json`
- Routes to oclif commands in `src/commands/`

**Configuration System**:
- `src/config/settings.ts` - User settings management with Zod validation
- `src/config/context.ts` - Context object passed to commands
- `src/commands/base.ts` - BaseCommand class extending oclif Command with shared flags/settings

**Available CLI Commands**:
- `config` (alias: `cfg`) - Display current configuration settings
- `doctor` - Check system dependencies and environment
- `gh branch` - Create git branch from GitHub issue
- `gh pr` - Create PR from current branch
- `gh branch-clean` - Delete merged branches
- `install` - Configure Claude Code settings
- `journal daily-notes` (alias: `today`) - Weekly files with daily sections
- `journal meeting` (alias: `m`) - Structured meeting notes
- `journal note` (alias: `n`) - General-purpose notes
- `observe setup/status/report/graph/session` - Claude Code observability
- `ralph task add/list/done/remove` - Task management
- `ralph run` - Autonomous Claude Code runner
- `ralph plan` - Show plan with mermaid graph

**Key Utilities**:
- `src/utils/anthropic/` - Claude API integration for AI-powered features
- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/utils/exec.ts` - Command execution utilities with `tinyexec`

### Claude Code Plugin Architecture

**Plugin Marketplace**: `.claude-plugin/marketplace.json`
- Defines available plugins for installation via `/plugins marketplace add`

**Available Plugins**:
- `notifications` - Audio notifications when Claude stops
- `git-tools` - Git workflow automation (commit messages, etc.)

Plugins are located in `plugins/` with each having a `.claude-plugin/plugin.json` manifest.

### Technology Stack

- **Runtime**: Bun (runs TypeScript natively)
- **CLI Framework**: oclif (commands in `src/commands/`)
- **Build**: `bun build --compile` for standalone executables
- **Testing**: `bun test` with `@oclif/test` for command testing
- **Linting**: oxlint
- **Package Manager**: Bun
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxlint on pre-commit)


## Ralph Usage

When using `tt ralph` for autonomous task execution:
- By default, ralph **auto-commits** after each completed task
- Use `--no-autoCommit` to disable auto-commits
- Use `--maxIterations` to limit token burn
- Use `--dryRun` to preview config before running
- **Iterations are a run-level concern** - task commands should not accept iteration params

### CRITICAL: Session Markers Prevent Token Burn

**Every task should have a sessionId** to enable resumption from prior research. This is the most important optimization to prevent ralph from burning through tokens re-discovering context.

**Marker Workflow (preferred):**
1. Generate marker: `tt ralph marker create` → `RALPH_MARKER_abc123`
2. Tell Claude to output the marker during research
3. Add tasks with marker: `tt ralph task add "desc" --findMarker RALPH_MARKER_abc123`

The `--findMarker` flag searches ~/.claude for the session containing the marker, attaches the session ID to the task, and stores the full marker.

- **Session forking is ON by default** - ralph forks from task's sessionId
- Use `--noFork` only when you want a fresh start (rare)
- Session IDs are stored per-task and persist across runs

```bash
# Marker workflow
tt ralph marker create                               # Generate marker
tt ralph task add "desc" --findMarker abc123         # Find session by marker

# Task management
tt ralph task add "description"                      # Add task (no session)
tt ralph task add "description" --sessionId abc123   # Add task with explicit session
tt ralph task list                                   # View tasks
tt ralph task done 1                                 # Mark task #1 complete
tt ralph task remove 1                               # Remove task #1

# Execution
tt ralph run                        # Run (auto-commits, forks session by default)
tt ralph run --no-autoCommit        # Run without auto-commits
tt ralph run --noFork               # Start fresh session (no fork)

# Plan
tt ralph plan                       # Show plan with mermaid graph
```

## Observability

The `observe` command provides Claude Code session analysis and cost tracking.

```bash
# Setup (run once)
tt observe setup                # Configure settings.json, add hooks

# Status
tt observe status               # Show current config and OTEL vars

# Session analysis
tt observe session              # List recent sessions with cost estimates
tt observe session <id>         # Detailed turn-by-turn breakdown

# Reports
tt observe report               # Daily token/cost report via ccusage
tt observe report --weekly      # Weekly report
tt observe report --output      # Save JSON to ~/.claude/reports/

# Visualization
tt observe graph                # Generate HTML treemap of all sessions
tt observe graph --session <id> # Single session treemap
tt observe graph --open         # Auto-open in browser
tt flame                        # Alias for observe graph
```

Treemap colors indicate input/output token ratio (waste): green <2:1, yellow 2-5:1, red >5:1.

**Troubleshooting treemap**: Use Chrome MCP tools (`mcp__claude-in-chrome__*`) to view and interact with the treemap in browser. Run `tt observe graph` then use `tabs_context_mcp`, `navigate`, and `computer screenshot` to inspect the visualization.

**Treemap reference**: https://d3js.org/d3-hierarchy/treemap - d3-hierarchy treemap tiling algorithms and layout options.

## Important Notes

- **Use bun for everything**: Run `.ts` files with `bun file.ts`, use `bunx` instead of `npx`, use `bun install/add/remove` for packages
- **Zod types**: Always derive TypeScript types from Zod schemas using `z.infer<typeof Schema>` - never define types manually alongside schemas
- **Breaking changes are fine** - this is a personal tool; don't worry about backwards compatibility
- When modifying CLI commands (`src/commands/`), also update the corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/` to reflect any argument/flag changes
- When tempted to directly edit ralph-state.json or similar state files, use `AskUserQuestion` to ask if it should be added as a CLI feature instead
- Tests that call the Anthropic API are skipped when `CI=DisableCallingClaude` is set
- Settings file automatically creates with defaults on first run (prompts user)
- Pre-commit hooks run oxlint via lint-staged
