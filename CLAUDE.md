# towles-tool

## Build & Test
- `pnpm test` — run all tests (vitest)
- `pnpm lint` — oxlint (pre-commit hook runs format + lint:fix + typecheck)
- `cd plugins/tt-agentboard && pnpm vitest run test/services/ test/plugins/` — agentboard tests only
- Pre-existing console.log warnings in `scripts/sync-versions.ts` are expected, not errors

## AgentBoard Architecture
- Server code: `plugins/tt-agentboard/server/domains/` (cards, execution, infra)
- Plugins: `plugins/tt-agentboard/server/plugins/` (Nitro auto-loaded)
- DB: drizzle ORM + SQLite, schema in `server/domains/*/schema.ts`
- Agent slots: git clones in `~/code/p/towles-tool-repos/towles-tool-slot-{1..5}`
- Agents run in tmux sessions named `card-{id}`

## Testing Conventions
- vi.mock is BANNED (oxlint rule: error). Use constructor dependency injection instead.
- Mock helpers: `test/helpers/mock-deps.ts` exports `createMockExecSync`, `createMockLogger`, `createMockEventBus`
- Test DI pattern: `new Service({ execSync: mockExecSync as never, logger: mockLogger })`

## Claude Code Hooks
- Stop hooks fire reliably in `-p` (print) mode
- HTTP hooks silently fail if server is down (no retry) — use command hooks with retry script
- Hook config: `.claude/settings.local.json` in each slot directory
- Completion sweep plugin detects missed hooks via tmux `pane_current_command`

## Git & PRs
- Always rebase merge: `gh pr merge --rebase --admin`
- Branch protection enabled with admin bypass
- `tt auto-claude` wraps `claude -p --output-format stream-json`
