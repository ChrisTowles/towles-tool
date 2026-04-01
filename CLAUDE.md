# towles-tool

## Commands

- `bun test` — run all tests (vitest)
- `bun test -- auto-claude` — filter tests by path
- `bun run dev` — run CLI locally (`bin/run.ts`)
- `bun run lint` — oxlint
- `bun run format` — oxfmt
- `bun typecheck` — tsgo
- `bun run link` — register global `tt` symlink via `bun link`
- `bun run link:show` — show which slot the global `tt` points to
- Pre-commit hook runs: format + lint:fix + typecheck

## Architecture

- CLI framework: oclif (`src/commands/`), citty for agentboard command
- Runtime: bun
- Formatter: oxfmt, Linter: oxlint, Type checker: tsgo

## AgentBoard

- Tmux sidebar TUI plugin: `plugins/tt-agentboard/`
- Bun monorepo with workspaces: `apps/server`, `apps/tui`, `packages/runtime`, `packages/mux-tmux`
- Agent slots: git clones in `~/code/p/towles-tool-repos/towles-tool-slot-{1..5}`

## Testing Conventions

- vi.mock is BANNED (oxlint rule: error). Use constructor dependency injection instead.

## Claude Code Hooks

- Stop hooks fire reliably in `-p` (print) mode
- HTTP hooks silently fail if server is down (no retry) — use command hooks with retry script
- Hook config: `.claude/settings.local.json` in each slot directory
- Completion sweep plugin detects missed hooks via tmux `pane_current_command`

## Bug Fixing

- If you find a pre-existing bug or test failure (not introduced by your changes), fix it anyway — don't skip it.

## Git & PRs

- Always rebase merge: `gh pr merge --rebase --admin`
- Branch protection enabled with admin bypass
- `tt auto-claude` wraps `claude -p --output-format stream-json`
