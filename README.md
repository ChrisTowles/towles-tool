# Towles Tool

CLI tool with autonomous task runner and quality-of-life commands for daily development.

## Features

**Ralph** - Autonomous task runner with session forking and context reuse

**Git workflows** - Branch creation, PR generation, and cleanup

**Journaling** - Daily notes, meeting notes, and general notes

**Claude Code plugins** - Personal plugin marketplace for Claude Code integration

## Installation

### Claude Code Plugins

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin enable tt@towles-tool
```

## Commands

**Ralph (autonomous runner)**

- `tt ralph plan add` - Add task to plan
- `tt ralph run` - Run autonomous loop
- `tt ralph show` - Show plan with graph
- `tt ralph progress` - Append progress (write-only)

**Git**

- `tt gh branch` - Create branch from issue
- `tt gh pr` (alias: `tt pr`) - Create pull request
- `tt gh branch-clean` - Delete merged branches

**Journaling**

- `tt journal daily-notes` (alias: `tt today`) - Weekly files with daily sections
- `tt journal meeting` - Meeting notes
- `tt journal note` - General notes

**Utilities**

- `tt config` - Show config
- `tt doctor` - Check dependencies
- `tt install` - Configure Claude Code settings

### From Source

```bash
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
pnpm install
pnpm start  # Run directly with tsx
```

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

## Reminders for me

- Use plan mode!
  - in plan mode tell claude your problems.
  - in edit mode tell claude its problems.
- use `/context` to see what is using context and if you need to trim anything down.
  - Only add context Claude doesn't already have but needs
- Always write in third person for prompts
- use a tool to write your prompts and evaluate them.
  - These models are smart. Less is more. don't be too verbose
  - https://console.anthropic.com/workbench/
- read source code from primary sources like:
  - [anthropic repos](https://github.com/anthropics)
- [Skills best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices#core-principles)
  - gerund form (verb + -ing) for skill names
- [claude cookbook skills section](https://github.com/anthropics/claude-cookbooks/tree/main/skills)
- https://github.com/anthropics/skills
  - installed as a plugin, has examples and skill-creator

```bash
/plugin marketplace add anthropics/skills
```

## Roadmap

### Planned Features

**Journal Type System**:

- [ ] daily-notes
- [ ] meeting
- [ ] note
- [ ] task (todo)

**Git Tools**:

- [ ] Clean merged branches
- [ ] pull-request-generator
- [ ] branch-from-issue

## Resources

### Claude Code Plugin Development

- [Claude Code Plugins Announcement](https://www.anthropic.com/news/claude-code-plugins)
- [Official Claude Code Plugins](https://github.com/anthropics/claude-code/tree/main/plugins)
- [Skills Guide](https://docs.claude.com/en/api/skills-guide)
- [Best Practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)

### Project Documentation

- [Node Package](./docs/node-package.md) - How the repo worked when it was a node package

## History

This project started as a collection of personal scripts and utilities built up over time in a private toolbox. It was then initially privite bash scripts, then published as an npm package. With the release of Claude Code Skills and plugins, the project also serves as a Claude Code plugin marketplace.

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)
