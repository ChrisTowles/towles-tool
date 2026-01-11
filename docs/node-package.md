# Towles Tool

Collection of quality-of-life tools and Claude Code plugins for daily development workflows.

## Overview

This is a dual-purpose repository:
1. **CLI tool** (`@towles/tool`) - Quality-of-life scripts for daily development tasks

The project evolved from a private toolbox of personal scripts to a public Node.js package and now also serves as a Claude Code plugin marketplace.

## Installation

### CLI Tool

Install globally via npm:

```bash
npm install -g @towles/tool
```

Use with either command:

```bash
towles-tool <command>
tt <command>  # Short alias
```

## CLI Commands

### Available Commands

- `journal` - Create journal entries (daily-notes, meetings, notes)
- `git-commit` - Generate AI-powered commit messages using Anthropic API
- `gh-branch` - GitHub branch operations
- `config` - Manage configuration settings
- `weather` - Weather information

### Configuration

Settings are stored in `~/.config/towles-tool/towles-tool.settings.json` with automatic creation on first run.


## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool

# Install dependencies
bun install
```

### Commands

**Development**:
```bash
bun run build           # Build the project using unbuild
bun run dev             # Development mode with unbuild --stub
bun run start           # Run the CLI with bun src/index.ts
bun run typecheck       # Run TypeScript type checking (no emit)
```

**Testing**:
```bash
bun run test            # Run all tests with vitest
bun run test:watch      # Run tests in watch mode (sets CI=DisableCallingClaude)
```

**Linting**:
```bash
bun run lint            # Run oxlint
bun run lint:fix        # Auto-fix linting issues in changed files
bun run lint:fix_all    # Auto-fix linting issues in all files
bun run lint:package    # Validate package with publint and knip
```

**Release**:
```bash
bun run release         # Bump version and create tag (GitHub Actions publishes to npm)
bun run release:local   # Bump version and publish directly (for local testing)
```

### Architecture

**Entry point**: `src/index.ts` - Sets up the command router and context
- Loads settings from `~/.config/towles-tool/towles-tool.settings.json`
- Parses arguments via `yargs`
- Routes to command handlers in `src/commands/`

**Configuration System**:
- `src/config/settings.ts` - User settings management with Zod validation
- `src/config/context.ts` - Context object passed to all commands
- Settings are stored in JSON with comment support via `comment-json`

**Key Utilities**:
- `src/utils/anthropic/` - Claude API integration for AI-powered features
- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/utils/exec.ts` - Command execution utilities with `tinyexec`

**Plugin Marketplace**: `.claude-plugin/marketplace.json`
- Defines available plugins for installation

### Technology Stack

- **Runtime**: Bun (runs TypeScript natively)
- **Build**: unbuild for compilation
- **Testing**: Vitest with vitest-package-exports
- **Linting**: oxlint
- **Package Manager**: Bun
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxlint on pre-commit)

### Important Notes

- Tests that call the Anthropic API are skipped when `CI=DisableCallingClaude` is set
- Settings file automatically creates with defaults on first run (prompts user)
- Pre-commit hooks run oxlint via lint-staged
- The release process is automated via GitHub Actions when a tag starting with `v*` is pushed


## Resources


### Project Documentation

- [Release Process](release-process.md) - How releases are managed

## History

This project started as a collection of personal scripts and utilities built up over time in a private toolbox. The original goal was to consolidate these into a public Node.js package. With the release of Claude Code Skills and plugins, the project evolved to package these command-line tools as Claude Code plugins, making them more accessible and reusable within the Claude Code ecosystem.

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)
