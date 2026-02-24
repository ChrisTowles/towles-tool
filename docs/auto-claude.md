# Auto-Claude Pipeline

Automated issue-to-PR pipeline (`tt auto-claude` / `tt ac`). Runs Claude Code CLI locally per issue through: research → plan → plan-annotations → plan-implementation → implement → review → create-pr → remove-label.

## Key Files

- `src/commands/auto-claude.ts` — oclif command entry point (alias: `ac`)
- `src/lib/auto-claude/config.ts` — Zod config schema, auto-detects repo and main branch from cwd
- `src/lib/auto-claude/utils.ts` — shared helpers: `runClaude()`, `resolveTemplate()`, `IssueContext`, `ensureBranch()`, `runStepWithArtifact()`
- `src/lib/auto-claude/pipeline.ts` — step orchestration with `--until` support
- `src/lib/auto-claude/steps/` — one file per step, most use `runStepWithArtifact()` helper
- `src/lib/auto-claude/prompt-templates/` — 7 `.md` files with `{{TOKEN}}` placeholders

## Conventions

- Artifacts go in `.auto-claude/issue-{N}/` (gitignored)
- Branch naming: `auto-claude/issue-{N}`
- Steps are idempotent — check for output artifact before running
- Trigger label: `auto-claude` (removed after PR creation)
- `runStepWithArtifact()` encapsulates the common pattern of check → run Claude → validate → commit
