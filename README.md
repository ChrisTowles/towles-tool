# Towles Tool

Personal CLI toolkit with auto-claude pipeline and developer utilities.

## Installation

### Claude Code Plugin

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
claude plugin update tt@towles-tool
```

### From Source

```bash
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
bun install
bun start
```

## CLI Commands

### Auto-Claude (issue-to-PR pipeline)

A fully autonomous issue-to-PR pipeline — what a more productizable version of the ralph planning/execution loop looks like. Cloud-based agents (GitHub Copilot, Anthropic agents) can create PRs but can't run your full stack — Docker, Postgres, Playwright, Chrome DevTools MCP, etc. Running locally gives Claude access to the complete environment to run, test, and iterate.

Label issues with `auto-claude`, start the loop, and walk away. Queue up multiple issues during the day and let them run overnight, or tag an issue from your phone or the Claude mobile app and have it waiting as a PR by morning.

Inspired by [Boris Tane's workflow](https://boristane.com/blog/how-i-use-claude-code/) and [Francisco Hermida's auto-pr](https://github.com/franciscohermida/auto-pr).

```bash
tt auto-claude --issue 42                # Process specific issue
tt auto-claude --issue 42 --until plan   # Stop after planning step
tt auto-claude --refresh --issue 42      # Rebase stale PR branch
tt auto-claude --reset 42               # Reset state for an issue
tt auto-claude --loop                    # Start polling loop
```

**Slot-based workflow:** Run auto-claude in a dedicated clone of the repo — not the one you're actively editing. Keep 3-5 clones (e.g. `slot-1`, `slot-2`, `slot-primary`) so each issue gets its own isolated environment. `slot-primary` is typically the one open in VS Code for manual work; the numbered slots run auto-claude independently. Each slot has its own `.env` so services and ports don't collide between slots. Claude Code's worktree feature may replace this approach in the future, but full repo clones have been more reliable in practice.

#### Pipeline Steps

| Step                    | What it does                                                                                     | Artifact produced        |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| **research**            | Deep-reads the codebase for context relevant to the issue                                        | `research.md`            |
| **plan**                | High-level technical plan with architectural decisions and alternatives                          | `plan.md`                |
| **plan-annotations**    | _(optional)_ Addresses reviewer feedback if `plan-annotations.md` exists                         | updates `plan.md`        |
| **plan-implementation** | Breaks plan into an ordered checkbox task list                                                   | `plan-implementation.md` |
| **implement**           | Executes tasks one-by-one, checking boxes and committing as it goes (loops up to 100 iterations) | `completed-summary.md`   |
| **review**              | Self-reviews the diff, fixes issues, rates confidence                                            | `review.md`              |
| **create-pr**           | Pushes branch and opens a PR with artifact links and review summary                              | GitHub PR                |
| **remove-label**        | Removes the `auto-claude` label so the issue isn't picked up again                               | —                        |

All artifacts are written to `.auto-claude/issue-{N}/`. Use `--until <step>` to pause after any step (e.g. `--until plan` to review before implementation). The plan-annotations step lets you drop feedback into `plan-annotations.md` and re-run — the pipeline will revise the plan before continuing.

#### How it works under the hood

1. **Auto-detects** repo (`gh repo view`) and main branch (`git symbolic-ref`) from cwd — no config file needed
2. **Creates a branch** `auto-claude/issue-{N}` from main
3. **Runs Claude Code CLI** (`claude -p`) in print mode with JSON output for each step, using prompt templates with token replacement (`{{ISSUE_DIR}}`, `{{SCOPE_PATH}}`, `{{MAIN_BRANCH}}`)
4. **Artifacts drive state** — each step checks if its output file exists before running (idempotent). Resume after a crash by re-running the same command
5. **Returns to main** after each issue completes or fails

#### Code layout

```
src/commands/auto-claude.ts          # oclif command (alias: ac)
src/lib/auto-claude/
  config.ts                          # Zod schema, initConfig(), getConfig()
  utils.ts                           # exec helpers, runClaude, templates, IssueContext
  pipeline.ts                        # step orchestration
  steps/                             # one file per pipeline step
  prompt-templates/                  # 7 .md prompt files with {{TOKEN}} placeholders
```

### Observability

| Command                   | Description              |
| ------------------------- | ------------------------ |
| `tt graph`                | Token Usage (auto-opens) |
| `tt graph --session <id>` | Single session           |
| `tt graph --days 14`      | Filter to last N days    |

### Git

| Command              | Description                     |
| -------------------- | ------------------------------- |
| `tt gh branch`       | Create branch from GitHub issue |
| `tt gh pr`           | Create pull request             |
| `tt gh branch-clean` | Delete merged branches          |

### Journaling

| Command                  | Alias      | Description   |
| ------------------------ | ---------- | ------------- |
| `tt journal daily-notes` | `tt today` | Weekly/daily  |
| `tt journal meeting`     | `tt m`     | Meeting notes |
| `tt journal note`        | `tt n`     | General notes |

### Utilities

| Command      | Description                    |
| ------------ | ------------------------------ |
| `tt config`  | Show configuration             |
| `tt doctor`  | Check dependencies             |
| `tt install` | Configure Claude Code settings |

## Claude Code Skills

| Skill                    | Description                   |
| ------------------------ | ----------------------------- |
| `/tt:plan`               | Create implementation plan    |
| `/tt:improve`            | Suggest codebase improvements |
| `/tt:refactor-claude-md` | Fix grammar/spelling          |
| `/tt:refine`             | Fix grammar/spelling          |

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testings.md) - Info about Tests

## License

[MIT](./LICENSE) © [Chris Towles](https://github.com/ChrisTowles)
