# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Build**: `pnpm build` - Uses unbuild to compile TypeScript to dist/
- **Development**: `pnpm dev` - Run unbuild in stub mode for development
- **Start**: `pnpm start` - Run the TypeScript source directly with tsx
- **Test**: `pnpm test` - Run tests with Vitest
- **Lint**: `pnpm lint` - Run ESLint (with `--fix` for auto-fixes)
- **Type Check**: `pnpm typecheck` - Run TypeScript compiler without emitting files

## Project Structure

This is a TypeScript library/CLI tool template using:
- **Package Manager**: pnpm with workspace configuration
- **Build System**: unbuild for TypeScript compilation
- **Testing**: Vitest for unit tests
- **Linting**: ESLint with @antfu/eslint-config
- **Git Hooks**: simple-git-hooks with lint-staged for pre-commit linting

The project uses a catalog-based dependency management system via pnpm workspace, with shared dependency versions across packages.

## Key Architecture Notes

- Entry point is `src/index.ts` with basic exports
- Build outputs to `dist/` directory with ESM format
- Pre-commit hooks ensure code quality with lint-staged
- Uses TypeScript with Node16 declarations
- Inlines @antfu/utils dependency during build

## Purpose

This is a cli tool for managing and automating tasks in a development environment.
