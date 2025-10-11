# Towles Tool MCP Server

Model Context Protocol server for towles-tool, exposing journal, git, and configuration management tools to Claude Code and other MCP clients.

## Overview

This MCP server allows Claude Code to:
- Create and manage journal entries (daily notes, meeting notes, quick notes)
- Analyze git repositories and generate commit messages
- Read and modify towles-tool configuration

## Installation

### Global Installation

```bash
npm install -g @towles/tool
# or
pnpm add -g @towles/tool
```

### Local Development

```bash
# Clone and build
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
pnpm install
pnpm build
```

## Configuration

### Claude Code CLI

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "towles-tool": {
      "command": "towles-tool-mcp"
    }
  }
}
```

### Claude Code VS Code Extension

Add to workspace or user settings:

```json
{
  "claude.mcpServers": {
    "towles-tool": {
      "command": "towles-tool-mcp"
    }
  }
}
```

### Local Development

For development, use absolute path:

```json
{
  "mcpServers": {
    "towles-tool": {
      "command": "node",
      "args": ["/absolute/path/to/towles-tool/dist/mcp/index.mjs"]
    }
  }
}
```

## Available Tools

### Journal Tools

#### `journal_create`

Create a new journal entry.

**Parameters:**
- `type` (required): `"daily"`, `"meeting"`, or `"note"`
- `title` (optional): Title for meeting or note entries (required for those types)

**Example:**
```
Claude, create a daily journal entry
Claude, create a meeting note for "Sprint Planning"
```

### Git Tools

#### `git_status`

Get current git repository status.

**Parameters:**
- `cwd` (optional): Working directory path

**Example:**
```
Claude, show me the git status
```

#### `git_diff`

Get git diff output.

**Parameters:**
- `cwd` (optional): Working directory path
- `staged` (optional): Show staged (true) or unstaged (false) changes. Default: true

**Example:**
```
Claude, show me the staged changes
Claude, what are the unstaged changes?
```

#### `git_commit_generate`

Generate commit message suggestions based on staged changes.

**Parameters:**
- `cwd` (optional): Working directory path
- `includeContext` (optional): Include recent commits for context. Default: true

**Example:**
```
Claude, generate a commit message for my staged changes
Claude, help me write a commit message
```

### Configuration Tools

#### `config_get`

Get configuration value(s).

**Parameters:**
- `key` (optional): Configuration key in dot notation (e.g., `"journalSettings.baseFolder"`). Omit to get entire config.

**Example:**
```
Claude, show me the towles-tool config
Claude, what's my journal base folder?
```

#### `config_set`

Set a configuration value.

**Parameters:**
- `key` (required): Configuration key in dot notation
- `value` (required): New value (string, number, boolean, object, or array)

**Example:**
```
Claude, set my preferred editor to "vim"
Claude, change the journal base folder to "/home/user/journals"
```

#### `config_init`

Initialize configuration file with default values.

**Parameters:**
- `force` (optional): Overwrite existing config. Default: false

**Example:**
```
Claude, initialize the towles-tool config
```

## Slash Commands

Example slash commands are provided in `.claude/commands/`:

- `/journal-daily` - Create daily journal entry
- `/journal-meeting <title>` - Create meeting note
- `/journal-note <title>` - Create quick note
- `/git-commit` - Generate commit message from staged changes

To use these in your project:

1. Copy `.claude/commands/` to your project root
2. Customize as needed
3. Use with `/journal-daily`, `/journal-meeting Sprint Planning`, etc.

## Architecture

```
mcp/
├── index.ts              # MCP server entry point
├── tools/
│   ├── journal.ts        # Journal management tools
│   ├── git.ts           # Git operations tools
│   └── config.ts        # Configuration tools
└── lib/                 # Shared utilities (future)
```

### Tool Registration

Each tool module registers its handlers with the MCP server:

```typescript
// mcp/tools/journal.ts
export function registerJournalTools(server: Server) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Handle journal_create tool
  })
}
```

### Tool Implementation Pattern

Tools follow a consistent pattern:

1. Validate inputs
2. Execute operation
3. Return structured JSON response
4. Handle errors gracefully

```typescript
async function handleToolName(args: ToolArgs) {
  try {
    // Validate
    if (!args.required) {
      throw new Error('Required parameter missing')
    }

    // Execute
    const result = doSomething(args)

    // Return success
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          data: result
        }, null, 2)
      }]
    }
  } catch (error) {
    // Return error
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message
        }, null, 2)
      }],
      isError: true
    }
  }
}
```

## Development

### Building

```bash
pnpm build
```

Builds both CLI (`dist/index.mjs`) and MCP server (`dist/mcp/index.mjs`).

### Testing

```bash
# Run MCP server directly
node dist/mcp/index.mjs

# Test with MCP inspector (if available)
mcp-inspector dist/mcp/index.mjs
```

### Adding New Tools

1. Create tool module in `mcp/tools/`
2. Implement `registerYourTools(server)` function
3. Import and register in `mcp/index.ts`
4. Add tool schema to `ListToolsRequestSchema` handler
5. Document in this README

## Debugging

Enable debug output:

```bash
DEBUG=towles-tool:* towles-tool-mcp
```

View logs from Claude Code:
- CLI: Check console output
- VS Code: View "Output" panel, select "Claude Code"

## Limitations

- MCP servers run in separate process (slight overhead)
- No interactive prompts (Claude handles all interaction)
- Configuration changes require MCP server restart

## Roadmap

- [ ] Add `journal_list` tool (list recent entries)
- [ ] Add `journal_search` tool (search entries)
- [ ] Add MCP resources for reading journal files
- [ ] Add MCP prompts for common workflows
- [ ] Load configuration from towles-tool settings
- [ ] Support custom templates
- [ ] Add tests for MCP tools

## Resources

- [MCP Documentation](https://modelcontextprotocol.io)
- [Claude Code MCP Guide](https://docs.claude.com/en/docs/claude-code/third-party-integrations)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Towles Tool Documentation](../README.md)

## License

MIT - See [LICENSE](../LICENSE) for details
