# Towles Tool

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

One off quality of life scripts that I use on a daily basis.

## Tools to add
- [ ] Today - creates and opens a markdown file, named the current week of the year, for you to keep your daily notes and use a scratch pad for notes.
- [ ] git commit with message prompt

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

- [Consola](https://github.com/unjs/consola) console wrapper and colors
- [c12](https://github.com/unjs/c12) configuration loader and utilities
- [zx](https://github.com/google/zx) google created library to write shell scripts in a more powerful and expressive way
- [@anthropic-ai/claude-code](https://github.com/anthropic-ai/claude-code) - A library for interacting with the Claude code via the Anthropic API.

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

[npm-version-src]: https://img.shields.io/npm/v/pkg-placeholder?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/pkg-placeholder
[npm-downloads-src]: https://img.shields.io/npm/dm/pkg-placeholder?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/pkg-placeholder
[bundle-src]: https://img.shields.io/bundlephobia/minzip/pkg-placeholder?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=pkg-placeholder
[license-src]: https://img.shields.io/github/license/antfu/pkg-placeholder.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/ChrisTowles/towles-tool/blob/main/LICENSE.md
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/pkg-placeholder
