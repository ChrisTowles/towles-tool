import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { Flags } from '@oclif/core'
import pc from 'picocolors'
import consola from 'consola'
import { BaseCommand } from '../commands/base.js'
import { getEmbeddedPluginsPath } from '../embedded-assets.js'
import { extractPlugin } from '../utils/plugin-extract.js'

const CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json')
const PLUGINS_DIR = path.join(homedir(), '.config', 'towles-tool', 'plugins')

interface ClaudeSettings {
  cleanupPeriodDays?: number
  alwaysThinkingEnabled?: boolean
  hooks?: Record<string, unknown[]>
  [key: string]: unknown
}

/**
 * Install and configure towles-tool with Claude Code
 */
export default class Install extends BaseCommand {
  static override description = 'Configure Claude Code settings and optionally enable observability'

  static override examples = [
    '<%= config.bin %> install',
    '<%= config.bin %> install --observability',
    '<%= config.bin %> install --no-plugins',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    observability: Flags.boolean({
      char: 'o',
      description: 'Show OTEL setup instructions and configure SubagentStop hook',
      default: false,
    }),
    plugins: Flags.boolean({
      description: 'Extract bundled plugins',
      default: true,
      allowNo: true,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Install)

    this.log(pc.bold('\n🔧 towles-tool install\n'))

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

    // Configure recommended settings
    let modified = false

    // Prevent log deletion (set to ~274 years)
    if (claudeSettings.cleanupPeriodDays !== 99999) {
      claudeSettings.cleanupPeriodDays = 99999
      modified = true
      this.log(pc.green('✓ Set cleanupPeriodDays: 99999 (prevent log deletion)'))
    } else {
      this.log(pc.dim('✓ cleanupPeriodDays already set to 99999'))
    }

    // Enable thinking by default
    if (claudeSettings.alwaysThinkingEnabled !== true) {
      claudeSettings.alwaysThinkingEnabled = true
      modified = true
      this.log(pc.green('✓ Set alwaysThinkingEnabled: true'))
    } else {
      this.log(pc.dim('✓ alwaysThinkingEnabled already set to true'))
    }

    // Save settings if modified
    if (modified) {
      this.saveClaudeSettings(claudeSettings)
      this.log(pc.green(`\n✓ Saved Claude settings to ${CLAUDE_SETTINGS_PATH}`))
    }

    // Show observability setup if requested
    if (flags.observability) {
      this.log(pc.bold('\n📊 Observability Setup\n'))
      this.showOtelInstructions()
    }

    // Extract bundled plugin if requested
    if (flags.plugins) {
      this.log(pc.bold('\n📦 Plugin Installation\n'))
      await this.extractBundledPlugin()
    }

    this.log(pc.bold(pc.green('\n✅ Installation complete!\n')))

    // Offer to run marketplace add
    const marketplaceCmd = `claude plugin marketplace add ${PLUGINS_DIR}`
    this.log(pc.cyan('To add plugins to Claude Code marketplace:'))
    this.log(pc.dim(`  ${marketplaceCmd}`))
    this.log('')

    const answer = await consola.prompt('Run this command now?', {
      type: 'confirm',
      initial: true,
    })

    if (answer) {
      const { x } = await import('tinyexec')
      this.log('')

      // Try to add; if already exists, remove first then re-add
      let result = await x('claude', ['plugin', 'marketplace', 'add', PLUGINS_DIR])
      const output = result.stdout + result.stderr
      if (result.exitCode !== 0 && output.includes('already installed')) {
        this.log(pc.dim('Marketplace already installed, updating...'))
        await x('claude', ['plugin', 'marketplace', 'remove', 'towles-tool'])
        result = await x('claude', ['plugin', 'marketplace', 'add', PLUGINS_DIR])
      }

      if (result.stdout) this.log(result.stdout)
      if (result.stderr) this.log(pc.dim(result.stderr))
      if (result.exitCode === 0) {
        this.log(pc.green('✓ Plugins added to marketplace'))

        // Install tt-core plugin from marketplace
        this.log('')
        const installResult = await x('claude', ['plugin', 'install', 'tt@towles-tool', '--scope', 'user'])
        if (installResult.stdout) this.log(installResult.stdout)
        if (installResult.stderr) this.log(pc.dim(installResult.stderr))
        if (installResult.exitCode === 0) {
          this.log(pc.green('✓ tt-core plugin installed'))
        }
      } else {
        this.log(pc.yellow(`Command exited with code ${result.exitCode}`))
      }
    }

    this.log('')
  }

  private saveClaudeSettings(settings: ClaudeSettings): void {
    const dir = path.dirname(CLAUDE_SETTINGS_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2))
  }

  private showOtelInstructions(): void {
    this.log(pc.cyan('Add these environment variables to your shell profile:\n'))

    consola.box(`export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`)

    this.log('')
    this.log(pc.dim('For more info, see: https://github.com/anthropics/claude-code-monitoring-guide'))
    this.log('')
    this.log(pc.cyan('Quick cost analysis (no setup required):'))
    this.log(pc.dim('  npx ccusage@latest --breakdown'))
  }

  private async extractBundledPlugin(): Promise<void> {
    const zipPath = getEmbeddedPluginsPath()

    if (!fs.existsSync(zipPath)) {
      this.log(pc.yellow(`Plugins zip not found at ${zipPath}`))
      this.log(pc.dim('Run "bun run scripts/zip-plugin.ts" to create it'))
      return
    }

    const extracted = await extractPlugin(zipPath, PLUGINS_DIR)
    if (extracted) {
      this.log(pc.green(`✓ Extracted plugins to ${PLUGINS_DIR}`))
    }
  }
}
