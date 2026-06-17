# towles-tool

## Commands

- `bun test` — run all tests (bun's native runner)
- `bun run test` — run all tests via vitest (node workers — no `Bun` global; keep src runtime-portable)
- `bun test -- auto-claude` — filter tests by path
- `bun run dev` — run CLI locally (`bin/run.ts`)
- `bun run lint` — oxlint
- `bun run format` — oxfmt
- `bun typecheck` — tsgo
- `bun run link` — register global `tt` symlink via `bun link`
- `bun run link:show` — show which slot the global `tt` points to
- Pre-commit hook runs: format + lint:fix + typecheck

## Claude workflow

- `/verify` — run format-check + lint + typecheck + test in one shot. Use before commits and PRs.
- `verify-app` subagent — same plus CLI entrypoint and AgentBoard workspace resolution. Dispatch when verifying after risky changes.
- `tt:parallel-slots` skill (shipped via the `tt` plugin) — when to fan out across `~/code/p/towles-tool-repos/towles-tool-slot-*`.

## Architecture

- CLI framework: oclif (`src/commands/`), citty for agentboard command
- Runtime: bun
- Formatter: oxfmt, Linter: oxlint, Type checker: tsgo

## AgentBoard

- Tmux sidebar TUI plugin: `packages/agentboard/`
- Single package, source split by domain under `src/`: `src/server`, `src/tui`, `src/runtime`, `src/mux-tmux`. Cross-domain imports are relative (e.g. `../runtime/index`) — no `@tt-agentboard/*` workspace packages. Runs as source under bun from a global install.
- Agent slots: git clones in `~/code/p/towles-tool-repos/towles-tool-slot-{1..5}`
- Multi-client invariant: "current"/"focused" session is per-client or per-TUI, never a server global. Resolve attached clients at action time (`fromSession` → `tmux list-clients`); stored ttys go stale.
- Sidebar handoff: each session has its own sidebar TUI process. A session switch moves the viewer to a _different_ TUI — click feedback must relay via the `session-viewed` event's `select` payload, not local state in the originating TUI.
- Live debugging: server WS on `127.0.0.1:4201`; `TT_AGENTBOARD_DEBUG=1` logs to `/tmp/agentboard-debug.log`; `tt agentboard restart` picks up source changes (runs from source via bun link).
- tmux format gotcha: in scripts, `display-message -p "#{session_name}"` is pane-context (where the script runs); use `list-clients -F "#{client_session}"` to verify what a client is actually viewing.

## Testing Conventions

- vi.mock is BANNED (oxlint rule: error). Use constructor dependency injection instead.

## Claude Code Hooks

- Stop hooks fire reliably in `-p` (print) mode
- HTTP hooks silently fail if server is down (no retry) — use command hooks with retry script
- Hook config: `.claude/settings.local.json` in each slot directory
- Completion sweep plugin detects missed hooks via tmux `pane_current_command`

## Bug Fixing

- If you find a pre-existing bug or test failure (not introduced by your changes), fix it anyway — don't skip it.

## Working Style

- Plan mode (`Shift+Tab` ×2) for any non-trivial change. Align on a plan first; one-shot the implementation after.
- Verification is the #1 quality multiplier. After edits: typecheck, lint, run the touched tests. Don't claim done without proof.
- Always finish migrations. Partial migrations confuse models the same way they confuse humans — leave the codebase in one shape, not half a shape.
- Hard cutover, no backwards-compat shims. Match the user's global rule.

## Git & PRs

- Always rebase merge: `gh pr merge --rebase --admin`
- Branch protection enabled with admin bypass
- `tt auto-claude` wraps `claude -p --output-format stream-json`
