# CLAUDE.md

Personal CLI tool (`tt`) with auto-claude pipeline, developer tools, journaling, and Claude Code plugin marketplace.

## Quick Reference

- **Package manager**: pnpm (use `pnpm dlx` instead of `npx`)
- **Terminal output**: consola (`consola.box()`, `consola.info/warn/error`)
- **Lint rules**: oxlint requires top-level `import type` (not inline `type` in value imports), and `consola` instead of `console.log/error`.
- **Validation**: Zod for schemas, objects, and types. Derive types with `z.infer<typeof Schema>` — never define types manually alongside schemas.
- **Dates**: Use `toLocaleDateString("en-CA")` for YYYY-MM-DD or Luxon with local zone. Never `toISOString()` for display (UTC shifts dates).
- When modifying CLI commands (`src/commands/`), also update corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/`.

## Commands

```bash
pnpm dev                # Run CLI with tsx
pnpm typecheck          # TypeScript type checking
pnpm test               # Run vitest tests
pnpm test:watch         # Run vitest in watch mode
pnpm test -- path       # Run tests matching a path (e.g. pnpm test -- auto-claude)
pnpm test:prompts                  # Run all echo prompt tests
pnpm test:prompts:root             # Root prompt tests only
pnpm test:prompts:tt-core          # tt-core plugin prompt tests
pnpm test:prompts:tt-core:llm      # LLM-based eval (needs ANTHROPIC_API_KEY)
pnpm test:prompts:tt-auto-claude   # tt-auto-claude plugin prompt tests
pnpm lint               # Run oxlint
pnpm lint:fix           # Auto-fix lint issues
pnpm format             # Format with oxfmt
pnpm format:check       # Check formatting without writing

# AgentBoard
cd plugins/tt-agentboard
pnpm dev                # Start Nuxt dev server on port 4200
pnpm test               # Run vitest (222 tests, needs dev server running)
pnpm build              # Build for production
pnpm db:generate        # Generate Drizzle migration
pnpm db:migrate         # Apply migrations
```

## AgentBoard Plugin (`plugins/tt-agentboard/`)

- **Nuxt 4 app** — has its own `package.json`, `vitest.config.ts`, and `tsconfig.json`
- **Run agentboard tests**: `cd plugins/tt-agentboard && pnpm test` (222 tests, requires dev server on port 4200 for e2e tests)
- **Start dev server**: `cd plugins/tt-agentboard && AGENTBOARD_DATA_DIR=~/.config/towles-tool/agentboard pnpm dev`
- **DB location**: `~/.config/towles-tool/agentboard/agentboard.db` (SQLite via Drizzle ORM)
- **DB migrations**: `cd plugins/tt-agentboard && pnpm db:generate && pnpm db:migrate`
- **Root tsconfig excludes agentboard** — Nuxt has its own type system with auto-imports
- **Nuxt 4 component auto-imports**: nested dirs prefix components (`components/board/KanbanCard.vue` → `BoardKanbanCard`), except when filename already starts with dir name (`card/CardDetail.vue` → `CardDetail`, NOT `CardCardDetail`)
- **SSR gotcha**: `setInterval`, `WebSocket`, `SpeechRecognition` must be wrapped in `onMounted` or `<ClientOnly>` — Nuxt 4 errors on server-side usage
- **Server imports**: use `~~/server/` prefix (not `~/server/`) — Nuxt 4 resolves `~` to `app/` dir
- **GitHub integration uses `gh` CLI** (not Octokit/GITHUB_TOKEN) — requires `gh auth login`
- **Agent completion**: detected via Claude Code HTTP Stop hooks, not tmux polling
- **Shared server utils**: `server/utils/params.ts` (getCardId, requireCard), `server/utils/hook-writer.ts`, `server/utils/workflow-helpers.ts`

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- [Auto-Claude Pipeline](docs/auto-claude.md) - 4-step issue-to-PR pipeline (plan → implement → simplify → review) with retry loop and label management
- [Testing](docs/testing.md) - Test conventions
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Skill & Prompt Guide](docs/skill-and-prompt-guide.md) - Rules for writing skills, prompts, and CLAUDE.md
