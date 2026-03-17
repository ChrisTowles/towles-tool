# Architecture

## CLI Application Structure

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
- `graph` - Claude Code token visualization
  **Key Utilities**:

- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/lib/journal/` - Journal template and file generation utilities

- `auto-claude` (alias: `ac`) - Automated issue-to-PR pipeline using Claude Code (research → plan → implement → review → PR)
- `auto-claude list` - Interactively pick an auto-claude labeled issue to process

## Claude Code Plugin Architecture

**Plugin Marketplace**: `.claude-plugin/marketplace.json`

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
claude plugin update tt@towles-tool
```

**Reinstall from local path** (for development):

```bash
claude plugin uninstall tt@towles-tool && claude plugin marketplace remove towles-tool && claude plugin marketplace add /home/ctowles/code/p/towles-tool && claude plugin install tt@towles-tool
```

**Available Plugins**:

### `tt-core` (named `tt`)

Dev workflow commands (invoked as `/tt:<command>`):

- `interview-me` - Relentless interviewing to clarify ideas before implementation
- `write-prd` - Transform conversations into structured PRDs with user stories
- `prd-to-issues` - Break PRDs into vertical-slice GitHub issues
- `tdd` - Strict red-green-refactor test-driven development
- `improve-architecture` - Codebase architecture analysis for agent-friendliness
- `refine-text` - Improve copy for readability and grammar
- `refactor-claude-md` - Analyze and reorganize CLAUDE.md files

Skill: `towles-tool` - Reference for `tt` CLI (git, journal, utils)

### `tt-auto-claude` (named `tt-ac`)

Auto-claude pipeline commands (invoked as `/tt-ac:<command>`):

- `create-issue` - Create GitHub issue with auto-claude label and pipeline labels
- `list` - List current auto-claude issues

Skill: `auto-claude` - How the auto-claude pipeline works

Plugins are located in `plugins/` with `.claude-plugin/plugin.json` manifests.

## Technology Stack

- **Runtime**: Node.js + tsx (runs TypeScript via tsx loader)
- **CLI Framework**: oclif (commands auto-discovered in `src/commands/`)
- **Testing**: vitest with `@oclif/test` for command testing
- **Linting**: oxlint
- **Formatting**: oxfmt
- **Package Manager**: pnpm
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxfmt + oxlint on pre-commit)
- **Terminal Graphics**: consola - use `consola.box({ title, message })` for styled boxes, `consola.info/warn/error` for styled logs
