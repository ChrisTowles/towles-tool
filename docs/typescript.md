# TypeScript Configuration

## Overview

This project uses TypeScript with the following configuration:

- **Target**: ESNext
- **Mode**: Strict mode enabled
- **Module Resolution**: Bundler

## Type Checking

Run type checking without emitting files:

```bash
pnpm typecheck
```

This command runs TypeScript's compiler in check-only mode to validate types across the codebase.

## Build Process

TypeScript compilation is handled by `unbuild`, which provides:
- Fast compilation
- Stub mode for development (`pnpm dev`)
- Production builds (`pnpm build`)
