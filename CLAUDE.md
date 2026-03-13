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
pnpm dev                # Run CLI with tsx
pnpm typecheck          # TypeScript type checking
pnpm test               # Run vitest tests
pnpm lint               # Run oxlint
pnpm lint:fix            # Auto-fix lint issues
pnpm format             # Format with oxfmt
pnpm format:check        # Check formatting without writing
```

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- **Plugin dev reinstall**: `claude plugin uninstall tt@towles-tool && claude plugin marketplace remove towles-tool && claude plugin marketplace add /home/ctowles/code/p/towles-tool && claude plugin install tt@towles-tool`
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testing.md) - Info about Tests
- [Skill & Prompt Guide](docs/skill-and-prompt-guide.md) - Rules for writing skills, prompts, and CLAUDE.md

## Auto-Claude Pipeline

Automated issue-to-PR pipeline (`tt auto-claude` / `tt ac`). Runs Claude Code CLI locally per issue through: research → plan → plan-annotations → plan-implementation → implement → review → create-pr → remove-label.

**Key files:**

- `src/commands/auto-claude.ts` — oclif command entry point (alias: `ac`)
- `src/lib/auto-claude/config.ts` — Zod config schema, auto-detects repo and main branch from cwd
- `src/lib/auto-claude/utils.ts` — shared helpers: `runClaude()`, `resolveTemplate()`, `IssueContext`, `ensureBranch()`, `runStepWithArtifact()`
- `src/lib/auto-claude/pipeline.ts` — step orchestration with `--until` support
- `src/lib/auto-claude/steps/` — one file per step, most use `runStepWithArtifact()` helper
- `src/lib/auto-claude/prompt-templates/` — 7 `.md` files with `{{TOKEN}}` placeholders

**Conventions:**

- Artifacts go in `.auto-claude/issue-{N}/` (gitignored)
- Branch naming: `auto-claude/issue-{N}`
- Steps are idempotent — check for output artifact before running
- Trigger label: `auto-claude` (removed after PR creation)
- `runStepWithArtifact()` encapsulates the common pattern of check → run Claude → validate → commit

## Important Notes

- **Dates in local timezone**: Use `toLocaleDateString("en-CA")` for YYYY-MM-DD or Luxon with local zone. Never use `toISOString()` for date grouping/display (UTC shifts dates).
- **Zod types**: Always derive types from Zod schemas using `z.infer<typeof Schema>` - never define types manually alongside schemas.
- **Breaking changes are fine** - personal tool, no backwards compatibility concerns.
- When modifying CLI commands (`src/commands/`), also update corresponding skills in `plugins/tt-core/skills/` and `plugins/tt-core/commands/`.
- **oclif command aliases**: Use `static override aliases = ["ac"]` in command class. See `auto-claude.ts` for example.
