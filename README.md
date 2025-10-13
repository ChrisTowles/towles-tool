# Towles Tool

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

One off quality of life scripts that I use on a daily basis.

## Journal Type System

The journal system supports three types of files with different templates and organization:

### Daily Notes (`journal daily-notes`)
- **Purpose**: Weekly files with daily sections for ongoing work and notes
- **File structure**: `YYYY/daily-notes/YYYY-MM-DD-week-log.md` (Monday's date)
- **Template**: Includes sections for Monday through Friday with date headers
- **Use case**: Regular daily journaling, work logs, scratch pad for notes

### Meeting Files (`journal meeting [title]`)
- **Purpose**: Structured meeting notes with agenda and action items
- **File structure**: `YYYY/meetings/YYYY-MM-DD-HHMM-meeting-[title].md`
- **Template**: Includes Date, Time, Attendees, Agenda, Notes, Action Items, and Follow-up sections
- **Use case**: Meeting preparation, note-taking, and action item tracking

### Note Files (`journal note [title]`)
- **Purpose**: General-purpose notes with structured sections
- **File structure**: `YYYY/notes/YYYY-MM-DD-HHMM-note-[title].md`
- **Template**: Includes Summary, Details, and References sections
- **Use case**: Research notes, documentation, general information capture

### Commands
- `journal` or `journal daily-notes` - Create/open current week's daily notes
- `journal meeting [title]` - Create a new meeting file with optional title
- `journal note [title]` - Create a new note file with optional title

## Tools to add
- [x] Journal system - creates and opens markdown files with templates for daily-notes, meetings, and notes
- [ ] use claude code to generate git commits with multiple options for the commit message.


## Claude Code Plugins

- https://www.anthropic.com/news/claude-code-plugins
- `/plugins marketplace add anthropics/claude-code`
- you can get an idea
  - https://github.com/anthropics/claude-code/tree/main/plugins

```bash
/plugins marketplace add anthropics/claude-code
/plugin install commit-commands@anthropics/claude-code
/plugin install feature-dev@anthropics/claude-code
```
- engineer [Dan Ávila's plugin marketplace](https://www.aitmpl.com/plugins) 

```bash

# validate the plugin
claude plugin validate .
```

###  How to use this repo as a marketplace

```
/plugins marketplace add ChrisTowles/towles-tool
/plugin install notifications@ChrisTowles/towles-tool
```



## Install from repository

```bash
pnpm add --global @towles/tool

## followed by
tt

# or
towles-tool
```

## Unisntall

```bash
pnpm remove --global @towles/tool
```

## If command not found

try running with pnpm
```bash
pnpm tt
```

if that works, then you need to add the pnpm global bin directory to your PATH.

## packages to consider
- [@anthropic-ai/claude-code](https://github.com/anthropic-ai/claude-code) - A library for interacting with the Claude code
- [zod](https://github.com/colinhacks/zod) - TypeScript-first schema validation
- [Consola](https://github.com/unjs/consola) console wrapper and colors
- ~~[c12](https://github.com/unjs/c12) configuration loader and utilities~~
    - referted stayed to json config
- [rolldown-vite](https://voidzero.dev/posts/announcing-rolldown-vite) - A Vite plugin for rolling down your code
- ~~[zx](https://github.com/google/zx) google created library to write shell scripts in a more powerful and expressive way via the Anthropic API.~~
- [prompts](https://github.com/terkelg/prompts) - A library for creating beautiful command-line prompts, with fuzzy search and other features.
  - had to patch it so `esc` cancels the selection with [pnpm-patch-i](https://github.com/antfu/pnpm-patch-i)
- [yargs](https://github.com/yargs/yargs) - A modern, feature-rich command-line argument parser with enhanced error handling, TypeScript support, and flexible command configuration.
- ~~[ink](https://github.com/vadimdemedes/ink) - React for interactive command-line apps~~
    - wanted hotkey support and more complex UI but this was overkill for this project.
- [publint](https://publint.dev/)
- [e18e.dev](https://e18e.dev/guide/resources.html)

## Document verbose and debug options

```bash
export DEBUG=1
```

TODO add verbose option.

## Development

For information on how releases are managed, see the [Release Process](docs/release-process.md) documentation.

## History

I'm using a lot of inspiration from [Anthony Fu](https://github.com/antfu) for this projects codebase.

## License

[MIT](./LICENSE) License © [Chris Towles](https://github.com/ChrisTowles)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@towles/tool?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@towles/tool
[npm-downloads-src]: https://img.shields.io/npm/dm/@towles/tool?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@towles/tool
[bundle-src]: https://img.shields.io/bundlephobia/minzip/@towles/tool?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=@towles/tool
[license-src]: https://img.shields.io/github/license/ChrisTowles/towles-tool.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/ChrisTowles/towles-tool/blob/main/LICENSE.md
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/@towles/tool
