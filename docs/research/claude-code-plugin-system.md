# Claude Code Plugin System Research

Research findings for migrating towles-tool to Claude Code plugin/extension system.

**Related Issue:** [#56](https://github.com/ChrisTowles/towles-tool/issues/56)
**Date:** 2025-10-10
**Status:** In Progress

---

## Executive Summary

Claude Code provides multiple extension mechanisms for adding custom functionality. The primary extensibility points are:

1. **Slash Commands** - Custom prompts and workflows
2. **MCP Servers** - Tools and data sources via Model Context Protocol
3. **Hooks** - Event-driven shell command execution
4. **Subagents** - Specialized AI assistants with custom prompts

The most suitable approach for migrating towles-tool appears to be creating an **MCP Server** that exposes towles-tool functionality as tools to Claude Code.

---

## Extension Mechanisms

### 1. Slash Commands

**What they are:**
- Custom prompts stored as markdown files
- Expand to full prompts when executed
- Support argument placeholders (`$ARGUMENTS`, `$1`, `$2`, etc.)

**Location:**
- Project: `.claude/commands/`
- User: `~/.claude/commands/`

**File Structure:**
```markdown
---
allowed-tools: Bash(git add:*)
description: Create a git commit
argument-hint: [message]
---

Create a git commit with message: $ARGUMENTS
```

**Capabilities:**
- Execute bash commands with `!` prefix
- Reference files with `@` prefix
- Control tool permissions via frontmatter
- Support extended thinking mode

**Limitations:**
- Primarily prompt-based, not executable code
- Limited to expanding prompts and controlling Claude's behavior
- Not suitable for complex logic or custom tool implementations

**Use Cases for towles-tool:**
- Could create slash commands like `/journal-daily`, `/git-commit` that prompt Claude to use MCP tools
- Better as high-level wrappers over MCP server implementation

---

### 2. MCP Servers (Model Context Protocol)

**What they are:**
- Custom servers that expose tools, resources, and prompts to Claude Code
- Built with TypeScript/Node.js or Python
- Communicate via stdin/stdout using JSON-RPC

**Official SDK:**
- Package: `@modelcontextprotocol/sdk` (v1.20.0+)
- GitHub: https://github.com/modelcontextprotocol/typescript-sdk

**Architecture:**
```typescript
import { McpServer } from '@modelcontextprotocol/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
    name: "towles-tool",
    version: "0.0.20"
});

// Register tools
server.tool(
    "journal_create",
    {
        type: "daily" | "meeting" | "note",
        title: string
    },
    async ({ input }) => {
        // Tool implementation
        return {
            content: [{
                type: "text",
                text: "Journal entry created"
            }]
        };
    }
);

// Start server
await server.connect(new StdioServerTransport());
```

**Configuration:**
MCP servers are registered in Claude Code config:
```json
{
  "mcpServers": {
    "towles-tool": {
      "command": "node",
      "args": ["/path/to/towles-tool-mcp/dist/index.js"]
    }
  }
}
```

**Capabilities:**
- Expose custom tools that Claude can call
- Provide resources (data sources, file access)
- Define custom prompts
- Full TypeScript/Node.js environment
- Async operations, file I/O, API calls
- Access to npm ecosystem

**Limitations:**
- Runs in separate process from Claude Code
- Communication via stdin/stdout JSON-RPC only
- Cannot directly modify Claude Code UI
- No direct access to Claude Code internals

**Use Cases for towles-tool:**
✅ **Primary recommendation** - Create MCP server that exposes:
- `journal_create` tool
- `git_commit_generate` tool
- `config_get` / `config_set` tools
- Resources for reading journal files
- Prompts for common workflows

---

### 3. Hooks

**What they are:**
- Shell commands that execute at specific Claude Code events
- Configured via `/hooks` command or settings.json

**Available Events:**
- `PreToolUse` - Before tool calls (can block execution)
- `PostToolUse` - After tool calls complete
- `UserPromptSubmit`
- `Notification`
- `Stop`
- `SubagentStop`
- `PreCompact`
- `SessionStart`
- `SessionEnd`

**Configuration:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git commit:*)",
        "hooks": [
          {
            "type": "command",
            "command": "towles-tool gc --validate"
          }
        ]
      }
    ]
  }
}
```

**Capabilities:**
- Execute shell commands at specific lifecycle points
- Receive contextual data via JSON stdin
- Block or allow operations (PreToolUse)
- Logging, validation, side effects

**Limitations:**
- Limited to shell command execution
- No return values (except block/allow for PreToolUse)
- Runs with current user credentials (security concern)

**Use Cases for towles-tool:**
- Could wrap existing CLI commands in hooks
- Automatic journal entry creation on SessionStart
- Git commit validation on PreToolUse
- But better served by MCP server approach

---

### 4. Subagents

**What they are:**
- Specialized AI assistants with custom system prompts
- Separate context window from main conversation
- Configurable tool access and model selection

**Creation:**
```bash
/agents create
```

**Configuration:**
- Name and description
- Custom system prompt
- Tool permissions (granular)
- Model selection (Sonnet/Opus/Haiku)
- Project-level (`.claude/agents/`) or user-level

**Capabilities:**
- Focused expertise for specific tasks
- Preserved main conversation context
- Task-specific workflows
- Controlled tool access

**Limitations:**
- Still prompt-based, not executable code
- Cannot add new tools (only restrict existing ones)
- Relies on existing Claude Code tools

**Use Cases for towles-tool:**
- Could create "Journal Agent" with system prompt for best journal practices
- "Git Commit Agent" specialized in commit message generation
- But cannot expose custom functionality without MCP server

---

## Extension Point Comparison

| Feature | Slash Commands | MCP Servers | Hooks | Subagents |
|---------|---------------|-------------|-------|-----------|
| **Custom Tools** | ❌ No | ✅ Yes | ❌ No | ❌ No |
| **Custom Logic** | ❌ Prompts only | ✅ Full code | ⚠️ Shell only | ❌ Prompts only |
| **Data Access** | ⚠️ Via prompts | ✅ Full access | ⚠️ Via shell | ⚠️ Via prompts |
| **Async Operations** | ❌ No | ✅ Yes | ⚠️ Limited | ❌ No |
| **npm Ecosystem** | ❌ No | ✅ Yes | ❌ No | ❌ No |
| **TypeScript** | ❌ No | ✅ Yes | ❌ No | ❌ No |
| **Reuse Existing Code** | ❌ No | ✅ Yes | ⚠️ Via CLI | ❌ No |
| **Interactive Prompts** | ⚠️ Limited | ⚠️ No (Claude interaction) | ❌ No | ⚠️ Limited |
| **Distribution** | ✅ Simple files | ⚠️ npm package | ✅ Simple config | ✅ Simple files |

---

## Recommended Approach

### Primary: MCP Server

Create a standalone MCP server package that exposes towles-tool functionality as tools.

**Pros:**
- Full TypeScript/Node.js environment
- Reuse existing towles-tool codebase
- Expose rich tool interfaces to Claude
- Standard npm distribution
- Can still use existing CLI independently
- Future-proof as MCP is an open standard

**Cons:**
- Separate process (slight overhead)
- Cannot use interactive prompts directly (Claude must handle interaction)
- Additional packaging complexity

**Architecture:**
```
towles-tool/
├── src/                    # Existing CLI code
├── mcp/                    # New MCP server
│   ├── index.ts           # MCP server entry
│   ├── tools/             # Tool implementations
│   │   ├── journal.ts     # journal_* tools
│   │   ├── git.ts         # git_* tools
│   │   └── config.ts      # config_* tools
│   └── lib/               # Shared utilities
└── package.json           # Export both CLI and MCP
```

### Complementary: Slash Commands

Create slash commands that provide convenient wrappers for MCP tools.

**Examples:**
- `/journal-daily` → Uses `journal_create` MCP tool
- `/journal-meeting <title>` → Uses `journal_create` with meeting type
- `/git-commit` → Uses `git_commit_generate` MCP tool

**Pros:**
- User-friendly command interface
- Can be distributed with MCP server
- Easy to share across team

### Optional: Subagents

Create specialized subagents for enhanced workflows.

**Examples:**
- "Journal Expert" - Best practices for journaling, knows about folder structure
- "Git Commit Expert" - Specialized in conventional commits and best practices

---

## Migration Path

### Phase 1: MCP Server Foundation
1. ✅ Research Claude Code plugin system
2. ⬜ Create new `mcp/` directory structure
3. ⬜ Setup MCP server with `@modelcontextprotocol/sdk`
4. ⬜ Implement basic tool: `journal_create`
5. ⬜ Test MCP server with Claude Code
6. ⬜ Document MCP installation and configuration

### Phase 2: Tool Migration
1. ⬜ Migrate journal command to MCP tools:
   - `journal_create` (daily, meeting, note)
   - `journal_list` (recent entries)
   - `journal_search` (find entries)
2. ⬜ Migrate git-commit to MCP tools:
   - `git_commit_generate` (analyze diff, generate message)
   - `git_commit_validate` (check message format)
3. ⬜ Migrate config to MCP tools:
   - `config_get` (read settings)
   - `config_set` (update settings)
   - `config_init` (create config file)

### Phase 3: Enhanced Integration
1. ⬜ Create complementary slash commands
2. ⬜ Create specialized subagents
3. ⬜ Add MCP resources for journal files
4. ⬜ Add MCP prompts for common workflows

### Phase 4: Distribution
1. ⬜ Update package.json for dual CLI/MCP distribution
2. ⬜ Create installation documentation
3. ⬜ Publish to npm
4. ⬜ Update README with MCP usage examples

---

## Tool Interface Design

### Journal Tools

```typescript
// Create journal entry
server.tool(
    "journal_create",
    {
        type: z.enum(["daily", "meeting", "note"]),
        title: z.string().optional(),
        content: z.string().optional(),
        folderContext: z.string().optional()
    },
    async ({ input }) => {
        // Use existing journal.ts logic
        // Return file path and content
    }
);

// List recent entries
server.tool(
    "journal_list",
    {
        count: z.number().default(10),
        type: z.enum(["daily", "meeting", "note", "all"]).default("all")
    },
    async ({ input }) => {
        // Return list of journal entries with metadata
    }
);

// Search entries
server.tool(
    "journal_search",
    {
        query: z.string(),
        type: z.enum(["daily", "meeting", "note", "all"]).default("all")
    },
    async ({ input }) => {
        // Return matching entries
    }
);
```

### Git Commit Tools

```typescript
// Generate commit message
server.tool(
    "git_commit_generate",
    {
        staged: z.boolean().default(true),
        includeContext: z.boolean().default(true)
    },
    async ({ input }) => {
        // Use existing git-commit.ts logic
        // Return suggested commit message
    }
);

// Validate commit message
server.tool(
    "git_commit_validate",
    {
        message: z.string()
    },
    async ({ input }) => {
        // Check conventional commit format
        // Return validation result
    }
);
```

### Config Tools

```typescript
// Get config value
server.tool(
    "config_get",
    {
        key: z.string().optional()
    },
    async ({ input }) => {
        // Return config value or entire config
    }
);

// Set config value
server.tool(
    "config_set",
    {
        key: z.string(),
        value: z.any()
    },
    async ({ input }) => {
        // Update config value
        // Return updated config
    }
);
```

---

## Technical Considerations

### Reusing Existing Code

Most existing towles-tool code can be reused:
- Extract business logic from commands into shared utilities
- Keep CLI interface separate from core functionality
- Share validation logic (Zod schemas)
- Share configuration management
- Share template system

**Refactoring needed:**
```
Current:
src/commands/journal.ts → CLI handler + business logic

Proposed:
src/commands/journal.ts → CLI handler only
src/lib/journal.ts → Business logic
mcp/tools/journal.ts → MCP tool wrapper
```

### Interactive Prompts

Current towles-tool uses `prompts` for interactive input. MCP servers cannot prompt users directly.

**Solution:**
- Claude Code handles user interaction
- MCP tools receive all required parameters
- If parameters missing, return error with what's needed
- Claude can then prompt user and retry

**Example:**
```typescript
if (!input.title) {
    throw new Error("Title is required for meeting journal entries");
}
// Claude will see error and prompt user for title
```

### Configuration

Current towles-tool uses c12 for config loading. MCP server can:
- Use same config system (read from same location)
- Or expose config via tools for Claude to manage
- Or use Claude Code settings for MCP-specific config

**Recommended:**
- Keep existing config system for CLI
- Add MCP-specific config in Claude Code settings
- Expose config_get/set tools for runtime access

### Error Handling

MCP tools should return structured responses:
```typescript
// Success
return {
    content: [{
        type: "text",
        text: "Journal entry created at: ~/journals/2025/10/2025-10-10.md"
    }]
};

// Error
throw new Error("Failed to create journal entry: Permission denied");
```

Claude Code will display errors to user and can handle retry logic.

### Dependencies

MCP server can use existing dependencies:
- `yargs` ❌ Not needed (no CLI parsing)
- `prompts` ❌ Not needed (Claude handles interaction)
- `consola` ⚠️ Consider for logging (or use MCP logging)
- `c12` ✅ Keep for config
- `zod` ✅ Keep for validation
- `neverthrow` ✅ Keep for error handling
- Template dependencies ✅ Keep

**Additional:**
- `@modelcontextprotocol/sdk` ✅ Required

---

## Open Questions

1. **Distribution Strategy**
   - Single package with both CLI and MCP?
   - Separate packages?
   - Monorepo?

2. **Deprecation Plan**
   - Keep CLI indefinitely?
   - Gradually migrate users to MCP?
   - Support both long-term?

3. **Feature Parity**
   - Should MCP have all CLI features?
   - Are some features CLI-only?
   - Are some features MCP-only?

4. **Testing Strategy**
   - How to test MCP tools?
   - Integration tests with Claude Code?
   - Mock MCP client?

5. **Documentation**
   - Separate docs for CLI vs MCP?
   - Migration guide for existing users?
   - Installation complexity?

---

## Next Steps

1. ✅ Complete research documentation
2. ⬜ Create proof-of-concept MCP server with single tool
3. ⬜ Test POC with Claude Code
4. ⬜ Refactor existing code to separate business logic
5. ⬜ Implement full MCP tool suite
6. ⬜ Create complementary slash commands
7. ⬜ Update documentation
8. ⬜ Publish and announce

---

## References

- [Claude Code Documentation Map](https://docs.claude.com/en/docs/claude-code/claude_code_docs_map.md)
- [Slash Commands Guide](https://docs.claude.com/en/docs/claude-code/slash-commands)
- [Hooks Guide](https://docs.claude.com/en/docs/claude-code/hooks-guide)
- [Subagents Guide](https://docs.claude.com/en/docs/claude-code/sub-agents)
- [Settings Reference](https://docs.claude.com/en/docs/claude-code/settings)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [How to Build a Custom MCP Server (freeCodeCamp)](https://www.freecodecamp.org/news/how-to-build-a-custom-mcp-server-with-typescript-a-handbook-for-developers/)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
