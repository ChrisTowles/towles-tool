# CLAUDE.md

## Project Overview

Dual-purpose repository:

1. **CLI tool** (`tt` or `towles-tool`) - Personal CLI tool with auto-claude pipeline, developer tools and journaling via markdown
2. **Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use

## Quick Reference

- **Package manager**: pnpm (use `pnpm dlx` instead of `npx`)
- **Run TypeScript**: `tsx file.ts`
- **Terminal output**: consola (`consola.box()`, `consola.info/warn/error`)
- **Lint rules**: oxlint requires top-level `import type` (not inline `type` in value imports), and `consola` instead of `console.log/error`.

## Commands

```bash
pnpm start              # Run CLI with tsx
pnpm typecheck          # TypeScript type checking
pnpm test               # Run vitest tests
pnpm lint               # Run oxlint
pnpm format             # Format with oxfmt
```

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testings.md) - Info about Tests

## Important Notes

- **Dates in local timezone**: Use `toLocaleDateString("en-CA")` for YYYY-MM-DD or Luxon with local zone. Never use `toISOString()` for date grouping/display (UTC shifts dates).
- **Zod types**: Always derive types from Zod schemas using `z.infer<typeof Schema>` - never define types manually alongside schemas.
- **Breaking changes are fine** - personal tool, no backwards compatibility concerns.
- When modifying CLI commands (`src/commands/`), also update corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/`.
- **oclif command aliases**: Use `static override aliases = ["ac"]` in command class. See `auto-claude.ts` for example.
