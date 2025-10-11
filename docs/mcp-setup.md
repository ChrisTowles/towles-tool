# MCP Server Setup Guide

This guide explains how to set up and use the towles-tool MCP (Model Context Protocol) server with Claude Code.

## Overview

The towles-tool MCP server exposes journal functionality as tools that Claude Code can use. This allows you to create and manage journal entries through natural conversation with Claude.

## Installation

### Prerequisites

- Node.js 22.x or higher
- towles-tool installed (`npm install -g @towles/tool` or `pnpm add -g @towles/tool`)

### Configuration

#### For Claude Code CLI

Add the MCP server to your Claude Code configuration file at `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "towles-tool": {
      "command": "towles-tool-mcp"
    }
  }
}
```

If you're using a local development version, use the full path:

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

#### For Claude Code VS Code Extension

Add to your workspace settings (`.vscode/settings.json`) or user settings:

```json
{
  "claude.mcpServers": {
    "towles-tool": {
      "command": "towles-tool-mcp"
    }
  }
}
```

## Available Tools

### `journal_create`

Create a new journal entry (daily, meeting, or note).

**Parameters:**
- `type` (required): Type of journal entry - `"daily"`, `"meeting"`, or `"note"`
- `title` (optional): Title for the entry (required for meeting and note types)

**Examples:**

```
Claude, create a daily journal entry
Claude, create a meeting journal for "Sprint Planning"
Claude, create a note titled "Ideas for Q4"
```

**Response Format:**

```json
{
  "success": true,
  "action": "created",
  "type": "meeting",
  "title": "Sprint Planning",
  "path": "/home/user/Documents/journals/meetings/2025/2025-10-10-sprint-planning.md",
  "message": "Created new meeting journal entry at: /home/user/Documents/journals/meetings/2025/2025-10-10-sprint-planning.md"
}
```

## Configuration

The MCP server uses default journal settings:

- **Base folder**: `~/Documents/journals`
- **Daily notes**: `{yyyy}/{monday:yyyy-MM-dd}.md`
- **Meetings**: `meetings/{yyyy}/{yyyy-MM-dd}-{title}.md`
- **Notes**: `notes/{yyyy}/{yyyy-MM-dd}-{title}.md`

> **Note**: Future versions will support loading configuration from towles-tool settings file.

## Usage Examples

### Create a Daily Journal

```
You: Claude, create today's journal entry
Claude: I'll create a daily journal entry for you.
[Uses journal_create tool with type: "daily"]
Claude: Created your daily journal at ~/Documents/journals/2025/2025-10-05.md
```

### Create a Meeting Note

```
You: Create a meeting journal for "Architecture Review"
Claude: I'll create a meeting journal entry.
[Uses journal_create tool with type: "meeting", title: "Architecture Review"]
Claude: Created meeting journal at ~/Documents/journals/meetings/2025/2025-10-10-architecture-review.md
```

### Create a Quick Note

```
You: Take a note titled "API Design Ideas"
Claude: I'll create a note for you.
[Uses journal_create tool with type: "note", title: "API Design Ideas"]
Claude: Created note at ~/Documents/journals/notes/2025/2025-10-10-api-design-ideas.md
```

## Slash Commands (Optional)

You can create slash commands to make journal creation even easier. Add these to `.claude/commands/`:

### `.claude/commands/journal-daily.md`

```markdown
---
description: Create a daily journal entry
---

Create a daily journal entry using the journal_create tool
```

### `.claude/commands/journal-meeting.md`

```markdown
---
description: Create a meeting journal entry
argument-hint: <title>
---

Create a meeting journal entry titled "$ARGUMENTS" using the journal_create tool
```

### `.claude/commands/journal-note.md`

```markdown
---
description: Create a note journal entry
argument-hint: <title>
---

Create a note journal entry titled "$ARGUMENTS" using the journal_create tool
```

Then use them like:
```
/journal-daily
/journal-meeting Sprint Planning
/journal-note Ideas for Q4
```

## Troubleshooting

### MCP Server Not Found

If Claude Code can't find the MCP server:

1. Verify towles-tool is installed: `towles-tool-mcp --version`
2. Check the command path in your settings
3. For local development, use absolute path to the built file
4. Restart Claude Code after configuration changes

### Tool Not Available

If the `journal_create` tool isn't available:

1. Check MCP server is configured in settings
2. Verify the server is running: Check Claude Code logs
3. Ensure you're using Claude Code CLI or VS Code extension (not web interface)

### Permission Errors

If you get permission errors when creating journals:

1. Check the base folder exists: `~/Documents/journals`
2. Verify write permissions: `ls -la ~/Documents/journals`
3. Create the directory manually: `mkdir -p ~/Documents/journals`

### Build Issues

If the MCP server fails to build:

```bash
# Clean and rebuild
pnpm clean
pnpm build

# Verify output
ls -la dist/mcp/index.mjs
```

## Development

### Testing the MCP Server

You can test the MCP server directly:

```bash
# Build the project
pnpm build

# Test with stdio (server will wait for JSON-RPC input)
node dist/mcp/index.mjs
```

Send a test request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

### Debugging

Enable debug logging by setting environment variable:

```bash
DEBUG=towles-tool:* towles-tool-mcp
```

## Future Enhancements

Planned improvements for the MCP server:

- [ ] Load configuration from towles-tool settings file
- [ ] Add `journal_list` tool to list recent entries
- [ ] Add `journal_search` tool to find entries
- [ ] Add MCP resources for reading journal files
- [ ] Support for custom templates
- [ ] Git commit message generation tools
- [ ] Configuration management tools

## Related Documentation

- [Claude Code MCP Documentation](https://docs.claude.com/en/docs/claude-code/third-party-integrations)
- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [Slash Commands Guide](./requirements/command_journal.md)
- [Journal Command Requirements](./requirements/command_journal.md)

## Support

For issues and questions:

- GitHub Issues: https://github.com/ChrisTowles/towles-tool/issues
- Discussions: https://github.com/ChrisTowles/towles-tool/discussions
