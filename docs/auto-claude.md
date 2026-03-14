# Auto-Claude Pipeline

Automated issue-to-PR pipeline (`tt auto-claude` / `tt ac`). Runs Claude Code CLI locally per issue through a 4-step flow: **plan → implement → simplify → review**.

## Pipeline Steps

1. **Plan** — Consolidates research, planning, annotations, and implementation planning into a single step. Produces `plan.md`.
2. **Implement** — Executes the plan: writes code, tests, and commits. Produces `completed-summary.md`.
3. **Simplify** — Code-simplify pass: removes dead code, simplifies logic, ensures conventions. Produces `simplify-summary.md`.
4. **Review** — Automated review outputs `PASS` or `FAIL` on the first line of `review.md`.

## Label Flow

1. Issue labelled `auto-claude` triggers the pipeline.
2. Pipeline removes `auto-claude`, adds `auto-claude-in-progress`.
3. On success: removes `auto-claude-in-progress`, adds `auto-claude-review`, creates PR.
4. On failure: removes `auto-claude-in-progress`, adds `auto-claude-failed`.

## Retry Behavior

If review outputs FAIL, the pipeline loops back to **implement → simplify → review** (clearing previous artifacts). Configurable via `maxReviewRetries` (default 2), so up to 3 total attempts.

## Config Fields

Defined in `src/lib/auto-claude/config.ts` via Zod schema:

| Field                    | Default         | Description                                      |
| ------------------------ | --------------- | ------------------------------------------------ |
| `triggerLabel`           | `"auto-claude"` | Label that triggers the pipeline                 |
| `repo`                   | auto-detected   | `owner/repo` from `gh repo view`                 |
| `scopePath`              | `"."`           | Working directory scope                          |
| `mainBranch`             | auto-detected   | Default branch                                   |
| `remote`                 | `"origin"`      | Git remote                                       |
| `maxImplementIterations` | `5`             | Max Claude turns per implement step              |
| `maxTurns`               | —               | Optional max turns override                      |
| `model`                  | `"opus"`        | Claude model to use                              |
| `maxReviewRetries`       | `2`             | Review failure retries (loops back to implement) |
| `loopIntervalMinutes`    | `30`            | Polling interval for loop mode                   |

## Prompt Templates

4 files in `src/lib/auto-claude/prompt-templates/` with `{{TOKEN}}` placeholders:

- `01_plan.prompt.md`
- `02_implement.prompt.md`
- `03_simplify.prompt.md`
- `04_review.prompt.md`

Templates are language/toolchain agnostic — project-specific details come from the target repo's CLAUDE.md.

## Key Files

- `src/commands/auto-claude/index.ts` — oclif command entry point (alias: `ac`)
- `src/lib/auto-claude/config.ts` — Zod config schema, auto-detects repo and main branch
- `src/lib/auto-claude/utils.ts` — shared helpers: `runClaude()`, `resolveTemplate()`, `IssueContext`, `ensureBranch()`
- `src/lib/auto-claude/pipeline.ts` — step orchestration with `--until` support and retry loop
- `src/lib/auto-claude/steps/` — one file per step (plan, implement, simplify, review, create-pr, fetch-issues)
- `src/lib/auto-claude/prompt-templates/` — 4 `.prompt.md` template files + `index.ts` constants

## Conventions

- Artifacts go in `.auto-claude/issue-{N}/` (gitignored)
- Branch naming: `auto-claude/issue-{N}`
- Steps are idempotent — check for output artifact before running
- `--until <step>` pauses the pipeline after the named step completes
