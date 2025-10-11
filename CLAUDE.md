# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication Style

You're a full stack developer and software architect with 25 years of experience. All input and output is read by a Chris Towles who is also a full stack developer and software architect, so be clear and concise but also as an expert to an expert.

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
├── mcp/                           # MCP (Model Context Protocol) server
│   ├── index.ts                   # MCP server entry point
│   ├── tools/                     # MCP tool implementations
│   │   ├── journal.ts            # Journal management tools
│   │   ├── git.ts                # Git operations tools
│   │   └── config.ts             # Configuration tools
│   ├── lib/                       # MCP-specific utilities (future)
│   └── README.md                  # MCP server documentation
├── .claude/                       # Claude Code integration
│   └── commands/                  # Slash commands for Claude Code
│       ├── journal-daily.md      # Create daily journal entry
│       ├── journal-meeting.md    # Create meeting note
│       ├── journal-note.md       # Create quick note
│       └── git-commit.md         # Generate commit message
├── docs/                          # Project documentation
│   ├── requirements/              # Detailed command specifications
│   │   └── command_{name}.md     # Individual command requirements
│   ├── research/                  # Research and architecture docs
│   │   └── claude-code-plugin-system.md  # MCP integration research
│   ├── mcp-setup.md              # MCP server setup guide
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
- **MCP Server**: Separate MCP server in `mcp/` that exposes tools to Claude Code and other MCP clients
- **Dual Distribution**: Package exports both CLI (`towles-tool`) and MCP server (`towles-tool-mcp`)
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

## MCP Integration

This repository includes an MCP (Model Context Protocol) server that exposes towles-tool functionality to Claude Code.

### MCP Server Architecture

- **Location**: `mcp/` directory
- **Entry Point**: `mcp/index.ts` - Server initialization and tool registration
- **Tools**: Individual tool modules in `mcp/tools/` (journal.ts, git.ts, config.ts)
- **Binary**: `towles-tool-mcp` - MCP server executable
- **Documentation**: See `mcp/README.md` and `docs/mcp-setup.md`

### Available MCP Tools

1. **Journal Tools**: `journal_create` - Create daily notes, meeting notes, or quick notes
2. **Git Tools**: `git_status`, `git_diff`, `git_commit_generate` - Git operations and commit message generation
3. **Config Tools**: `config_get`, `config_set`, `config_init` - Configuration management

### Slash Commands

Example slash commands in `.claude/commands/`:
- `/journal-daily` - Create daily journal entry
- `/journal-meeting <title>` - Create meeting note
- `/journal-note <title>` - Create quick note
- `/git-commit` - Generate commit message

### MCP Development Guidelines

- Tool handlers return structured JSON responses with `success` field
- Use `as unknown as TypeName` for MCP SDK type conversions
- All tools should have proper error handling
- Console statements in MCP server require `eslint-disable-next-line no-console`
- Reuse existing business logic from CLI commands when possible

## Subagents

This repository includes specialized subagents for specific tasks:

### Code Reviewer Agent

- **Location**: `.claude/agents/code-reviewer.md`
- **Purpose**: Expert code review focused on towles-tool architecture and conventions
- **Tools**: Read, Grep, Glob
- **Documentation**: See `docs/agents/code-reviewer.md`

**Usage:**
```
Use the code-reviewer to review my changes
Review these changes before I commit
```

**Focus Areas:**
- Architecture & separation of concerns
- TypeScript quality and type safety
- Error handling patterns
- Testing coverage and quality
- MCP integration standards
- Project conventions adherence

## General Guidelines

- Make sure to use Context7 to search about frameworks, libraries, and tools before WebSearch.
- Use the code-reviewer agent for code quality checks before committing
