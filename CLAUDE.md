# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a dual-purpose repository:

1. **CLI tool** (`tt`) - Ralph autonomous task runner, observability, git workflows, and journaling (distributed via npm, runs with tsx)
2. **Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use

## Commands

### Development

```bash
pnpm start              # Run the CLI directly with tsx
pnpm typecheck          # Run TypeScript type checking (no emit)
```

### Testing

```bash
pnpm test               # Run all tests with vitest
pnpm test:watch         # Run tests in watch mode
```

### Linting & Formatting

```bash
pnpm lint               # Run oxlint
pnpm lint:fix           # Auto-fix linting issues
pnpm format             # Format code with oxfmt
pnpm format:check       # Check formatting without writing
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
- `graph` - Claude Code token visualization treemap
- `ralph plan add/list/done/remove` - Plan task management
- `ralph run` - Autonomous Claude Code runner
- `ralph show` - Show plan with mermaid graph

**Key Utilities**:

- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/lib/ralph/` - Ralph state, formatting, execution helpers
- `src/lib/journal/` - Journal template and file generation utilities

### Claude Code Plugin Architecture

**Plugin Marketplace**: `.claude-plugin/marketplace.json`

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
```

**Reinstall from local path** (for development):

```bash
claude plugin uninstall tt@towles-tool && claude plugin marketplace remove towles-tool && claude plugin marketplace add /home/ctowles/code/p/towles-tool && claude plugin install tt@towles-tool
```

**Available Plugin**: `tt-core` (named `tt`)

Plugin commands (invoked as `/tt:<command>`):

- `commit` - AI-powered conventional commit messages
- `plan` - Interview user and create implementation plan
- `improve` - Explore codebase and suggest improvements
- `refine` - Fix grammar/spelling in files

Plugins are located in `plugins/` with `.claude-plugin/plugin.json` manifests.

### Technology Stack

- **Runtime**: Node.js + tsx (runs TypeScript via tsx loader)
- **CLI Framework**: oclif (commands auto-discovered in `src/commands/`)
- **Testing**: vitest with `@oclif/test` for command testing
- **Linting**: oxlint
- **Formatting**: oxfmt
- **Package Manager**: pnpm
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxfmt + oxlint on pre-commit)
- **Terminal Graphics**: consola - use `consola.box({ title, message })` for styled boxes, `consola.info/warn/error` for styled logs

## Ralph Usage

When using `tt ralph` for autonomous task execution:

- By default, ralph **auto-commits** after each completed task
- Use `--no-autoCommit` to disable auto-commits
- Use `--maxIterations` to limit token burn
- Use `--dryRun` to preview config before running

```bash
# Plan management
tt ralph plan add --file path.md    # Add plan from file
tt ralph plan list                  # View plans
tt ralph plan done 1                # Mark plan #1 complete
tt ralph plan remove 1              # Remove plan #1

# Execution
tt ralph run                        # Run (auto-commits by default)
tt ralph run --no-autoCommit        # Run without auto-commits

# Show
tt ralph show                       # Show plan with mermaid graph
```

## Observability

```bash
tt graph                        # Generate HTML treemap of all sessions
tt graph --session <id>         # Single session treemap
tt graph --open                 # Auto-open in browser
```

Treemap colors indicate input/output token ratio (waste): green <2:1, yellow 2-5:1, red >5:1.

## Important Notes

- **Dates in local timezone**: Always use local time for user-facing dates. Use `toLocaleDateString("en-CA")` for YYYY-MM-DD format or Luxon with local zone. Never use `toISOString()` for date grouping/display - it converts to UTC and causes dates to shift (e.g., 11pm local becomes next day in UTC).
- **Use pnpm/tsx**: Run `.ts` files with `tsx file.ts`, use `pnpm dlx` instead of `npx`, use `pnpm install/add/remove` for packages
- **Zod types**: Always derive TypeScript types from Zod schemas using `z.infer<typeof Schema>` - never define types manually alongside schemas
- **Breaking changes are fine** - this is a personal tool; don't worry about backwards compatibility
- When modifying CLI commands (`src/commands/`), also update the corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/` to reflect any argument/flag changes
- When tempted to directly edit ralph-state.json or similar state files, use `AskUserQuestion` to ask if it should be added as a CLI feature instead
- Tests that call the Anthropic API are skipped when `CI=DisableCallingClaude` is set
- Settings file automatically creates with defaults on first run (prompts user)
- Pre-commit hooks run oxlint via lint-staged
