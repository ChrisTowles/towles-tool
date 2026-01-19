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
- `ralph plan add/list/done/remove` - Plan task management
- `ralph run` - Autonomous Claude Code runner
- `ralph show` - Show plan with mermaid graph

**Key Utilities**:

- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/lib/ralph/` - Ralph state, formatting, execution helpers
- `src/lib/journal/` - Journal template and file generation utilities

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

**Available Plugin**: `tt-core` (named `tt`)

Plugin commands (invoked as `/tt:<command>`):

- `commit` - AI-powered conventional commit messages
- `plan` - Interview user and create implementation plan
- `improve` - Explore codebase and suggest improvements
- `refine` - Fix grammar/spelling in files
- `refactor-claude-md` - reduce and claude.md files

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
