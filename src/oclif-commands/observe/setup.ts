import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import consola from 'consola'
import { BaseCommand } from '../../commands/base.js'

const CLAUDE_DIR = path.join(homedir(), '.claude')
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')
const REPORTS_DIR = path.join(CLAUDE_DIR, 'reports')

interface ClaudeSettings {
  cleanupPeriodDays?: number
  alwaysThinkingEnabled?: boolean
  env?: Record<string, string>
  hooks?: {
    SubagentStop?: Array<{
      matcher?: Record<string, unknown>
      hooks?: Array<{
        type: string
        command: string
      }>
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

const OTEL_ENV_VARS: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
}

/**
 * Configure observability settings for Claude Code
 */
export default class ObserveSetup extends BaseCommand {
  static override description = 'Configure Claude Code observability settings'

  static override examples = [
    '<%= config.bin %> observe setup',
    '<%= config.bin %> observe setup  # Adds SubagentStop hook for lineage tracking',
  ]

  async run(): Promise<void> {
    await this.parse(ObserveSetup)

    this.log(pc.bold('\n📊 Claude Code Observability Setup\n'))

    // Load or create Claude settings
    let claudeSettings: ClaudeSettings = {}
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      try {
        const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8')
        claudeSettings = JSON.parse(content)
        this.log(pc.dim(`Found existing Claude settings at ${CLAUDE_SETTINGS_PATH}`))
      } catch {
        this.log(pc.yellow(`Warning: Could not parse ${CLAUDE_SETTINGS_PATH}, will create fresh settings`))
      }
    } else {
      this.log(pc.dim(`No Claude settings file found, will create one`))
    }

    let modified = false

    // 1. Ensure cleanupPeriodDays is set to prevent log deletion
    if (claudeSettings.cleanupPeriodDays !== 99999) {
      claudeSettings.cleanupPeriodDays = 99999
      modified = true
      this.log(pc.green('✓ Set cleanupPeriodDays: 99999 (prevent log deletion)'))
    } else {
      this.log(pc.dim('✓ cleanupPeriodDays already set to 99999'))
    }

    // 2. Configure SubagentStop hook for lineage tracking
    const subagentLogPath = path.join(REPORTS_DIR, 'subagent-log.jsonl')
    const subagentHookCommand = `jq -c '. + {parent: env.SESSION_ID, timestamp: now}' >> ${subagentLogPath}`

    if (!claudeSettings.hooks) {
      claudeSettings.hooks = {}
    }

    const existingSubagentHook = claudeSettings.hooks.SubagentStop
    const hasSubagentHook = existingSubagentHook &&
      Array.isArray(existingSubagentHook) &&
      existingSubagentHook.length > 0

    if (!hasSubagentHook) {
      claudeSettings.hooks.SubagentStop = [{
        hooks: [{
          type: 'command',
          command: subagentHookCommand
        }]
      }]
      modified = true
      this.log(pc.green('✓ Added SubagentStop hook for subagent lineage tracking'))
    } else {
      this.log(pc.dim('✓ SubagentStop hook already configured'))
    }

    // 3. Add OTEL environment variables to settings
    if (!claudeSettings.env) {
      claudeSettings.env = {}
    }

    const addedVars: string[] = []
    const skippedVars: string[] = []
    for (const [key, value] of Object.entries(OTEL_ENV_VARS)) {
      if (claudeSettings.env[key] === undefined) {
        claudeSettings.env[key] = value
        addedVars.push(key)
        modified = true
      } else {
        skippedVars.push(key)
      }
    }

    if (addedVars.length > 0) {
      this.log(pc.green(`✓ Added env vars: ${addedVars.join(', ')}`))
    }
    if (skippedVars.length > 0) {
      this.log(pc.dim(`✓ Env vars already set: ${skippedVars.join(', ')}`))
    }

    // Save settings if modified
    if (modified) {
      this.saveClaudeSettings(claudeSettings)
      this.log(pc.green(`\n✓ Saved settings to ${CLAUDE_SETTINGS_PATH}`))
    }

    // 4. Create reports directory
    if (!fs.existsSync(REPORTS_DIR)) {
      fs.mkdirSync(REPORTS_DIR, { recursive: true })
      this.log(pc.green(`✓ Created reports directory at ${REPORTS_DIR}`))
    } else {
      this.log(pc.dim(`✓ Reports directory exists at ${REPORTS_DIR}`))
    }

    // 5. Show OTEL environment variables setup
    this.log(pc.bold('\n🔧 OTEL Environment Variables\n'))
    this.log(pc.cyan('Add these to your shell profile (~/.bashrc, ~/.zshrc, etc.):\n'))

    consola.box(`export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`)

    this.log('')
    this.log(pc.dim('For a full monitoring stack, see:'))
    this.log(pc.dim('  https://github.com/anthropics/claude-code-monitoring-guide'))
    this.log('')

    // Quick usage tips
    this.log(pc.bold('📈 Quick Analysis Commands\n'))
    this.log(pc.dim('  tt observe status     # Check current config'))
    this.log(pc.dim('  tt observe report     # Token/cost breakdown'))
    this.log(pc.dim('  tt observe session    # List sessions'))
    this.log(pc.dim('  tt observe graph     # Visualize token usage'))
    this.log('')

    this.log(pc.bold(pc.green('✅ Observability setup complete!\n')))
  }

  private saveClaudeSettings(settings: ClaudeSettings): void {
    const dir = path.dirname(CLAUDE_SETTINGS_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2))
  }
}
