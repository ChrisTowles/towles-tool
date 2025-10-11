import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import * as commentJson from 'comment-json'

const USER_SETTINGS_DIR = path.join(homedir(), '.config', 'towles-tool')
const USER_SETTINGS_PATH = path.join(USER_SETTINGS_DIR, 'towles-tool.settings.json')

interface ConfigGetArgs {
  key?: string
}

interface ConfigSetArgs {
  key: string
  value: unknown
}

interface ConfigInitArgs {
  force?: boolean
}

/**
 * Register config-related tools with the MCP server
 */
export function registerConfigTools(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'config_get':
        return handleConfigGet(args as unknown as ConfigGetArgs)
      case 'config_set':
        return handleConfigSet(args as unknown as ConfigSetArgs)
      case 'config_init':
        return handleConfigInit(args as unknown as ConfigInitArgs)
      default:
        // Let other handlers deal with other tools
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
        }
    }
  })
}

/**
 * Get configuration value(s)
 */
async function handleConfigGet(args: ConfigGetArgs) {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) {
      throw new Error(`Configuration file not found at: ${USER_SETTINGS_PATH}. Use config_init to create it.`)
    }

    const content = readFileSync(USER_SETTINGS_PATH, 'utf-8')
    const config = commentJson.parse(content)

    if (args.key) {
      // Get specific key using dot notation
      const keys = args.key.split('.')
      let value: any = config

      for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
          value = value[k]
        }
        else {
          throw new Error(`Configuration key not found: ${args.key}`)
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              key: args.key,
              value,
            }, null, 2),
          },
        ],
      }
    }
    else {
      // Return entire config
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              path: USER_SETTINGS_PATH,
              config,
            }, null, 2),
          },
        ],
      }
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}

/**
 * Set configuration value
 */
async function handleConfigSet(args: ConfigSetArgs) {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) {
      throw new Error(`Configuration file not found at: ${USER_SETTINGS_PATH}. Use config_init to create it.`)
    }

    const content = readFileSync(USER_SETTINGS_PATH, 'utf-8')
    const config = commentJson.parse(content) as Record<string, any>

    // Set value using dot notation
    const keys = args.key.split('.')
    let target: any = config

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]
      if (!(k in target) || typeof target[k] !== 'object') {
        target[k] = {}
      }
      target = target[k]
    }

    const lastKey = keys[keys.length - 1]
    const oldValue = target[lastKey]
    target[lastKey] = args.value

    // Save updated config
    writeFileSync(USER_SETTINGS_PATH, commentJson.stringify(config, null, 2), 'utf-8')

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            key: args.key,
            oldValue,
            newValue: args.value,
            path: USER_SETTINGS_PATH,
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}

/**
 * Initialize configuration file with defaults
 */
async function handleConfigInit(args: ConfigInitArgs) {
  try {
    if (existsSync(USER_SETTINGS_PATH) && !args.force) {
      throw new Error(`Configuration file already exists at: ${USER_SETTINGS_PATH}. Use force: true to overwrite.`)
    }

    const defaultConfig = {
      preferredEditor: 'code',
      journalSettings: {
        baseFolder: homedir(),
        dailyPathTemplate: 'journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md',
        meetingPathTemplate: 'journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md',
        notePathTemplate: 'journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md',
      },
    }

    // Ensure directory exists
    if (!existsSync(USER_SETTINGS_DIR)) {
      mkdirSync(USER_SETTINGS_DIR, { recursive: true })
    }

    // Write config file
    writeFileSync(USER_SETTINGS_PATH, commentJson.stringify(defaultConfig, null, 2), 'utf-8')

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: args.force ? 'overwritten' : 'created',
            path: USER_SETTINGS_PATH,
            config: defaultConfig,
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}
