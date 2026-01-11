# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a dual-purpose repository:
1. **CLI tool** (`@towles/tool`) - Collection of quality-of-life scripts for daily development workflows
2. **Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use

The project evolved from a private toolbox of personal scripts to a public Node.js package and now also serves as a Claude Code plugin marketplace.

## Commands

### Development
```bash
pnpm build              # Build the project using unbuild
pnpm dev                # Development mode with unbuild --stub
pnpm start              # Run the CLI with tsx src/index.ts
pnpm typecheck          # Run TypeScript type checking (no emit)
```

### Testing
```bash
pnpm test               # Run all tests with vitest
pnpm test:watch         # Run tests in watch mode (sets CI=DisableCallingClaude)
```

### Linting
```bash
pnpm lint               # Run oxlint
pnpm lint:fix           # Auto-fix linting issues in changed files
pnpm lint:fix_all       # Auto-fix linting issues in all files
pnpm lint:package       # Validate package with publint and knip
```

### Release
```bash
pnpm release            # Bump version and create tag (GitHub Actions publishes to npm)
pnpm release:local      # Bump version and publish directly (for local testing)
```

The release process is automated via GitHub Actions when a tag starting with `v*` is pushed.

### Plugin Validation
```bash
claude plugin validate .  # Validate Claude Code plugins before publishing
```

## Architecture

### CLI Application Structure

**Entry point**: `src/index.ts` - Sets up the command router and context
- Loads settings from `~/.config/towles-tool/towles-tool.settings.json`
- Parses arguments via `yargs`
- Routes to command handlers in `src/commands/`

**Configuration System**:
- `src/config/settings.ts` - User settings management with Zod validation
- `src/config/context.ts` - Context object passed to all commands
- Settings are stored in JSON with comment support via `comment-json`

**Available CLI Commands**:
- `journal` - Create journal entries (daily-notes, meetings, notes)
- `gh-branch` - GitHub branch operations
- `config` - Manage configuration settings
- `ralph` - Autonomous Claude Code runner for task execution

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

- **TypeScript**: ESNext target with strict mode, bundler module resolution
- **Build**: unbuild for compilation
- **Testing**: Vitest with vitest-package-exports
- **Linting**: oxlint
- **Package Manager**: pnpm with catalog dependencies
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxlint on pre-commit)


## Ralph Usage

When using `tt ralph` for autonomous task execution:
- By default, ralph **auto-commits** after each completed task
- Use `--no-autoCommit` to disable auto-commits
- Use `--maxIterations` to limit token burn
- Use `--dryRun` to preview config before running

```bash
# Task management
tt ralph task add "description"     # Add a task
tt ralph task list                  # View tasks
tt ralph task done 1                # Mark task #1 complete
tt ralph task remove 1              # Remove task #1

# Execution
tt ralph run                        # Run (auto-commits by default)
tt ralph run --no-autoCommit        # Run without auto-commits

# Plan
tt ralph plan                       # Show plan with mermaid graph
```

## Important Notes

- **Zod types**: Always derive TypeScript types from Zod schemas using `z.infer<typeof Schema>` - never define types manually alongside schemas
- **Breaking changes are fine** - this is a personal tool; don't worry about backwards compatibility
- When modifying CLI commands (`src/commands/`), also update the corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/` to reflect any argument/flag changes
- When tempted to directly edit ralph-state.json or similar state files, use `AskUserQuestion` to ask if it should be added as a CLI feature instead
- Tests that call the Anthropic API are skipped when `CI=DisableCallingClaude` is set
- Settings file automatically creates with defaults on first run (prompts user)
- Pre-commit hooks run `pnpm i --frozen-lockfile` and `oxlint --fix` on staged files
- The CLI is available as both `towles-tool` and `tt` commands when installed
