# Towles Tool

Collection of quality-of-life tools and Claude Code plugins for daily development workflows.

## Overview

**CLI tool** (`tt`) - Distributed as a compiled Bun executable for daily development tasks.

**Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use.

The project evolved from a private toolbox of personal scripts to a compiled Bun executable and Claude Code plugin marketplace.

## Installation

### CLI Tool

Download the pre-built executable for your platform from [Releases](https://github.com/ChrisTowles/towles-tool/releases), or build from source:

```bash
# Clone and build
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
bun install
bun run build

# The executable is at dist/tt
# Move it somewhere in your PATH
mv dist/tt ~/.local/bin/tt
```

### Claude Code Plugins

Install plugins from this marketplace:

```bash
/plugins marketplace add ChrisTowles/towles-tool
/plugin install tt@ChrisTowles/towles-tool
```

I do find myself editing `~/.claude/settings.json` a lot to directly modify settings around plugins.

### Shell Completions

Generate shell completions for tab completion support:

```bash
# Bash - add to ~/.bashrc
tt completion >> ~/.bashrc

# Zsh - add to ~/.zshrc
tt completion >> ~/.zshrc

# Fish
tt completion > ~/.config/fish/completions/tt.fish
```

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
bun install
```

### Commands

```bash
bun run start           # Run the CLI directly
bun run build           # Build executable for current platform
bun run build:all       # Build for all platforms (Linux, macOS, Windows)
bun run test            # Run tests
bun run lint            # Run linter
bun run typecheck       # Type check
```

### Plugin Validation

```bash
claude plugin validate .  # Validate Claude Code plugins before publishing
```

**Plugin Marketplace**: `.claude-plugin/marketplace.json`

- Defines available plugins for installation

### Releasing

See [docs/releasing.md](./docs/releasing.md) for full details.

```bash
gh workflow run release.yml -f bump_type=patch  # or minor/major
gh run watch  # monitor progress
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

- [ ] commit-message-generator
- [ ] pull-request-generator
- [ ] issue-generator
- [ ] pull-request-reviewer
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

This project started as a collection of personal scripts and utilities built up over time in a private toolbox. It was initially published as an npm package, but has since evolved to be distributed as a compiled Bun executable. With the release of Claude Code Skills and plugins, the project also serves as a Claude Code plugin marketplace.

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)
