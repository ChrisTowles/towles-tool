#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { registerJournalTools } from './tools/journal.js'
import { registerGitTools } from './tools/git.js'
import { registerConfigTools } from './tools/config.js'

// Create MCP server instance
const server = new Server(
  {
    name: 'towles-tool',
    version: '0.0.20',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// Register all tools
registerJournalTools(server)
registerGitTools(server)
registerConfigTools(server)

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'journal_create',
        description: 'Create a new journal entry (daily, meeting, or note)',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['daily', 'meeting', 'note'],
              description: 'Type of journal entry to create',
            },
            title: {
              type: 'string',
              description: 'Title for the journal entry (required for meeting and note types)',
            },
          },
          required: ['type'],
        },
      },
      {
        name: 'journal_list',
        description: 'List recent journal entries',
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              description: 'Number of entries to return (default: 10)',
            },
            type: {
              type: 'string',
              enum: ['all', 'daily', 'meeting', 'note'],
              description: 'Filter by journal type (default: all)',
            },
          },
        },
      },
      {
        name: 'git_status',
        description: 'Get the current git repository status',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: {
              type: 'string',
              description: 'Working directory (defaults to current directory)',
            },
          },
        },
      },
      {
        name: 'git_diff',
        description: 'Get git diff output',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: {
              type: 'string',
              description: 'Working directory (defaults to current directory)',
            },
            staged: {
              type: 'boolean',
              description: 'Show staged changes (default: true) or unstaged changes (false)',
            },
          },
        },
      },
      {
        name: 'git_commit_generate',
        description: 'Generate commit message suggestions based on staged changes',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: {
              type: 'string',
              description: 'Working directory (defaults to current directory)',
            },
            includeContext: {
              type: 'boolean',
              description: 'Include recent commit history for context (default: true)',
            },
          },
        },
      },
      {
        name: 'config_get',
        description: 'Get configuration value(s) from towles-tool settings',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Configuration key in dot notation (e.g., "journalSettings.baseFolder"). Omit to get entire config.',
            },
          },
        },
      },
      {
        name: 'config_set',
        description: 'Set a configuration value in towles-tool settings',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Configuration key in dot notation (e.g., "journalSettings.baseFolder")',
            },
            value: {
              description: 'Value to set (string, number, boolean, object, or array)',
            },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'config_init',
        description: 'Initialize towles-tool configuration file with default values',
        inputSchema: {
          type: 'object',
          properties: {
            force: {
              type: 'boolean',
              description: 'Overwrite existing configuration file (default: false)',
            },
          },
        },
      },
    ],
  }
})

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'journal_create') {
    // Tool implementation is delegated to the registered handler
    // This will be caught by the journal tools handler
    return {
      content: [
        {
          type: 'text',
          text: `Journal tool called with: ${JSON.stringify(args)}`,
        },
      ],
    }
  }

  throw new Error(`Unknown tool: ${name}`)
})

// Start the server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // eslint-disable-next-line no-console
  console.error('Towles Tool MCP Server running on stdio')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', error)
  process.exit(1)
})
