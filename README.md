# Towles Tool

CLI tool with autonomous task runner and quality-of-life commands for daily development.

## Features

- **Ralph** - Autonomous task runner with session forking and context reuse
- **Observability** - Token usage visualization with interactive treemaps
- **Git workflows** - Branch creation, PR generation, and cleanup
- **Journaling** - Daily notes, meeting notes, and general notes
- **Claude Code plugins** - Personal plugin marketplace for Claude Code integration

## Installation

### Claude Code Plugin

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
```

### From Source

```bash
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
pnpm install
pnpm start  # Run directly with tsx
```

## CLI Commands

### Ralph (autonomous runner)

| Command                     | Description                                   |
| --------------------------- | --------------------------------------------- |
| `tt ralph plan add <desc>`  | Add task to plan                              |
| `tt ralph plan list`        | View tasks                                    |
| `tt ralph plan done <id>`   | Mark task complete                            |
| `tt ralph plan remove <id>` | Remove task                                   |
| `tt ralph run`              | Run autonomous loop (auto-commits by default) |
| `tt ralph show`             | Show plan with mermaid graph                  |

### Observability

| Command                   | Description                           |
| ------------------------- | ------------------------------------- |
| `tt graph`                | Generate HTML treemap of all sessions |
| `tt graph --session <id>` | Single session treemap                |
| `tt graph --open`         | Auto-open in browser                  |

Treemap colors indicate input/output token ratio: green <2:1, yellow 2-5:1, red >5:1.

### Git

| Command              | Alias   | Description                     |
| -------------------- | ------- | ------------------------------- |
| `tt gh branch`       |         | Create branch from GitHub issue |
| `tt gh pr`           | `tt pr` | Create pull request             |
| `tt gh branch-clean` |         | Delete merged branches          |

### Journaling

| Command                  | Alias      | Description                      |
| ------------------------ | ---------- | -------------------------------- |
| `tt journal daily-notes` | `tt today` | Weekly files with daily sections |
| `tt journal meeting`     | `tt m`     | Meeting notes                    |
| `tt journal note`        | `tt n`     | General notes                    |

### Utilities

| Command      | Alias    | Description                    |
| ------------ | -------- | ------------------------------ |
| `tt config`  | `tt cfg` | Show configuration             |
| `tt doctor`  |          | Check dependencies             |
| `tt install` |          | Configure Claude Code settings |

## Claude Code Plugin Skills

Available via `/tt:<command>`:

| Command       | Description                                   |
| ------------- | --------------------------------------------- |
| `/tt:commit`  | AI-powered conventional commit messages       |
| `/tt:plan`    | Interview user and create implementation plan |
| `/tt:improve` | Explore codebase and suggest improvements     |
| `/tt:refine`  | Fix grammar/spelling in files                 |

## Development

```bash
pnpm start              # Run CLI with tsx
pnpm test               # Run tests
pnpm lint               # Run oxlint
pnpm format             # Format with oxfmt
pnpm typecheck          # Type check
```

### Releasing

```bash
gh workflow run release.yml -f bump_type=patch  # or minor/major
gh run watch
```

## Resources

### Claude Code Plugin Development

- [Claude Code Plugins Announcement](https://www.anthropic.com/news/claude-code-plugins)
- [Official Claude Code Plugins](https://github.com/anthropics/claude-code/tree/main/plugins)
- [Skills Guide](https://docs.claude.com/en/api/skills-guide)
- [Best Practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)
