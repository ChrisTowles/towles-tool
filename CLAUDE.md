# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication Style

All input and output is read by a Chris Towles who is also a full stack developer and software architect, so be clear and concise but also as an expert to an expert in your responses.

## Repository Structure

This CLI tool follows a standard TypeScript project structure with clear separation of concerns:

```
towles-tool/
├── src/                           # All source code
│   ├── commands/                  # Individual CLI command implementations
│   │   ├── {command-name}.ts      # Command logic (e.g., git-commit.ts, config.ts)
│   │   └── {command-name}.test.ts # Unit tests for each command
│   ├── utils/                     # Reusable utility functions
│   │   ├── {feature}/            # Feature-specific utilities (e.g., anthropic/)
│   │   ├── {name}-utils.ts       # Utility modules (e.g., date-utils.ts, print-utils.ts)
│   │   └── {name}.ts             # Core utilities (e.g., exec.ts, interactive-input.ts)
│   ├── lib/                       # Core library code
│   │   ├── error.ts              # Custom error classes and error handling
│   │   ├── json.ts               # JSON processing utilities
│   │   └── validation.ts         # Input validation logic
│   ├── config.ts                  # Application configuration management
│   ├── constants.ts               # Global constants and configuration values
│   └── index.ts                   # Main entry point - CLI setup and command registration
├── docs/                          # Project documentation
│   ├── requirements/              # Detailed command specifications
│   │   └── command_{name}.md     # Individual command requirements
│   └── Implementation_patterns/   # Development guides and patterns
├── package.json                   # NPM dependencies, scripts, and project metadata
├── tsconfig.json                  # TypeScript compiler configuration
├── vitest.config.ts              # Test framework configuration
└── build.config.ts               # Build system configuration (unbuild)
```



## Documents

These `docs/requirements/*` files provide detailed requirements but purposely exclude implementation details

- `docs/requirements/command_journal.md`: Journal command requirements and specifications with its alias `j` and `journal today`, `journal meeting`, `journal note` and `journal daily`
- `docs/requirements/command_git-commit.md`: Git commit command requirements and specifications for `git-commit`
with its alias `gc`
- `docs/requirements/command_config.md`: Configuration command requirements and specifications with its alias `config` and `cfg`
- `docs/requirements/settings_management.md`: Settings management system requirements including user confirmation, file creation, and schema validation


### Key Architectural Principles

- **Commands**: Each CLI command is a separate module in `src/commands/` with its own test file
- **Utilities**: Shared functionality lives in `src/utils/` organized by domain or feature
- **Libraries**: Core reusable components in `src/lib/` that could be extracted to separate packages
- **Configuration**: Centralized `src/config/` used for settings and configuration management
- **Entry Point**: Single entry point at `src/index.ts` that registers all commands using yargs
- **Documentation**: Requirements and implementation guides in `docs/` to guide development
- **Testing**: Co-located test files using `.test.ts` suffix for easy discovery and maintenance

## Development Commands

- `pnpm lint` - Lint code with oxlint
- `pnpm typecheck` - Type check code with tsc
- `pnpm test` - Run tests with Vitest

## Code Quality

Run `pnpm typecheck` and `pnpm lint:fix` after making changes to ensure code quality and consistency.

## Key Architecture Notes

Towles-tool follows a modular CLI architecture with clear separation of concerns:

- **Commands Layer** (`src/commands/`): Individual command implementations (git-commit.ts, journal.ts, config.ts)
- **CLI Entry Point** (`src/index.ts`): yargs setup and command registration
- **Utils Layer** (`src/utils/`): Shared utilities for execution, formatting, and interactive input
- **Config Management** (`src/config.ts`): Configuration loading with c12 library
- **Destructured parameters**: Used consistently for better readability and maintainability
- **Async/await**: Used throughout for asynchronous operations
- **execCommand utility**: Centralized command execution for git and system commands (uses execSync)




## Tech Stack

- **Package Manager**: pnpm
- **Runtime**: Node.js 22.x
- **Build System**: unbuild for TypeScript compilation
- **Testing**: Vitest for unit tests
- **CLI Framework**: yargs for command parsing
- **Interactive UI**: prompts for user input and consola for formatted output
- **Logging**: consola for user-friendly output
- **Config Management**: c12 for configuration loading
- **Validation**: Zod 4 schemas with branded types
- **Error Handling**: neverthrow for Result types (utilities only)
- **Git Hooks**: simple-git-hooks with lint-staged for pre-commit linting

## Error Handling

- handle errors by having functions return return `Result<T, E>` or or `Promise<Result<T, E>>` types using `neverthrow` for complex error scenarios.
- Simple utilities like `execCommand` throw errors that commands should catch
- Error types extend base `AnyError` class (`src/lib/error.ts`): `RepositoryError`, `ApplicationError`, `ClaudeError`

## Testing Patterns

- Use `pnpm test` for running tests
- Mock external dependencies (`execCommand`)
- Test both success and error cases
- Use `vi.mocked()` for typed mocks

## MCP Servers

- Make sure to use Context7 to search about frameworks, libraries, and tools before WebSearch.
- 