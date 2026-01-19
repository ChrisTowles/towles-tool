# Towles Tool

Personal CLI toolkit with autonomous task runner and developer utilities.

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
pnpm install
pnpm start
```

## CLI Commands

### Ralph (autonomous runner)

| Command                       | Description            |
| ----------------------------- | ---------------------- |
| `tt ralph plan add "path.md"` | Add plan from file     |
| `tt ralph plan list`          | View plans             |
| `tt ralph plan done <id>`     | Mark complete          |
| `tt ralph plan remove <id>`   | Remove plan            |
| `tt ralph show`               | Show plan with mermaid |
| `tt ralph run`                | Run (auto-commits)     |
| `tt ralph run --planId 5`     | Run specific plan      |

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
- [Claude Code Planning and Running Usage](docs/ralph-tools-for-claude-code.md) - "Claude Code" autonomous runner
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testings.md) - Info about Tests

## License

[MIT](./LICENSE) © [Chris Towles](https://github.com/ChrisTowles)
