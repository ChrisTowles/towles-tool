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
pnpm lint               # Run oxlint
pnpm lint:fix           # Auto-fix lint issues
pnpm format             # Format with oxfmt
pnpm format:check       # Check formatting without writing
```

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- [Auto-Claude Pipeline](docs/auto-claude.md) - 4-step issue-to-PR pipeline (plan → implement → simplify → review) with retry loop and label management
- [Testing](docs/testing.md) - Test conventions
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Skill & Prompt Guide](docs/skill-and-prompt-guide.md) - Rules for writing skills, prompts, and CLAUDE.md
