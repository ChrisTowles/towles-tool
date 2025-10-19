# Towles Tool

Collection of quality-of-life tools and Claude Code plugins for daily development workflows.

## Overview

**Claude Code Plugin Marketplace** - Hosts Claude Code plugins for personal use.

The project evolved from a private toolbox of personal scripts to a public Node.js package and now also serves as a Claude Code plugin marketplace.

## Reminders for me

- 
- Use plan mode!
  - in plan mode tell claude your problems.
  - in edit mode tell claude its problems.
- use `/context` to see what is using context and if you need to trim anything down.
  - Only add context Claude doesn’t already have but needs
- Always write in third person for prompts
- 
- use a tool to write your prompts and evaluate them.
  - These models are smart. Less is more. don't be too verbose
  - https://console.anthropic.com/workbench/
  - 
- read source code from primary sources like:
  - [anthropic repos](https://github.com/anthropics)
- [Skills best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices#core-principles)
  - gerund form (verb + -ing) for skill names
- [claude cookbook skills section](https://github.com/anthropics/claude-cookbooks/tree/main/skills)

- https://github.com/anthropics/skills
  - installed as a plugin, has examples and skill-crea

```bash
/plugin marketplace add anthropics/skills
```

## Installation

### Claude Code Plugins

Install plugins from this marketplace:

```bash
/plugins marketplace add ChrisTowles/towles-tool
/plugin install tt@ChrisTowles/towles-tool
```

I do find myself editing `~/.claude/settings.json` a lot to directly modify settings around plugins.


## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool

```

### Plugin Validation

```bash
claude plugin validate .  # Validate Claude Code plugins before publishing
```

**Plugin Marketplace**: `.claude-plugin/marketplace.json`
- Defines available plugins for installation


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

- [Release Process](docs/release-process.md) - How releases are managed
- [Node Package](./docs/node-package.md) - How the repo worked when it was a node package
- 
## History

This project started as a collection of personal scripts and utilities built up over time in a private toolbox. The original goal was to consolidate these into a public Node.js package. With the release of Claude Code Skills and plugins, the project evolved to package these command-line tools as Claude Code plugins, making them more accessible and reusable within the Claude Code ecosystem.

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)
