import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import { BaseCommand } from '../../commands/base.js'

const CLAUDE_DIR = path.join(homedir(), '.claude')
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')
const REPORTS_DIR = path.join(CLAUDE_DIR, 'reports')

interface ClaudeSettings {
  cleanupPeriodDays?: number
  alwaysThinkingEnabled?: boolean
  hooks?: {
    SubagentStop?: unknown[]
    PreToolUse?: unknown[]
    PostToolUse?: unknown[]
    Stop?: unknown[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Display current observability configuration status
 */
export default class ObserveStatus extends BaseCommand {
  static override description = 'Display current observability configuration status'

  static override examples = [
    '<%= config.bin %> observe status',
    '<%= config.bin %> observe status  # Check if observability is properly configured',
  ]

  async run(): Promise<void> {
    await this.parse(ObserveStatus)

    this.log(pc.bold('\n📊 Observability Status\n'))

    // Load Claude settings
    let settings: ClaudeSettings = {}
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      try {
        const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8')
        settings = JSON.parse(content)
      } catch {
        this.log(pc.red(`✗ Could not parse ${CLAUDE_SETTINGS_PATH}`))
      }
    } else {
      this.log(pc.yellow(`⚠ No settings file at ${CLAUDE_SETTINGS_PATH}`))
      this.log(pc.dim('  Run: tt observe setup'))
      this.log('')
    }

    // 1. Claude Settings
    this.log(pc.bold('Claude Settings'))
    this.log(pc.dim(`  Path: ${CLAUDE_SETTINGS_PATH}\n`))

    // cleanupPeriodDays
    const cleanup = settings.cleanupPeriodDays
    if (cleanup === 99999) {
      this.log(pc.green('  ✓ cleanupPeriodDays: 99999 (logs preserved)'))
    } else if (cleanup !== undefined) {
      this.log(pc.yellow(`  ⚠ cleanupPeriodDays: ${cleanup} (logs may be deleted)`))
    } else {
      this.log(pc.red('  ✗ cleanupPeriodDays: not set (default cleanup applies)'))
    }

    // alwaysThinkingEnabled
    if (settings.alwaysThinkingEnabled) {
      this.log(pc.green('  ✓ alwaysThinkingEnabled: true'))
    } else {
      this.log(pc.dim('  ○ alwaysThinkingEnabled: false'))
    }

    this.log('')

    // 2. Hooks
    this.log(pc.bold('Hooks Configured'))
    const hooks = settings.hooks || {}
    const hookNames = ['SubagentStop', 'PreToolUse', 'PostToolUse', 'Stop']
    let hasAnyHook = false

    for (const name of hookNames) {
      const hook = hooks[name]
      if (hook && Array.isArray(hook) && hook.length > 0) {
        this.log(pc.green(`  ✓ ${name}: ${hook.length} handler(s)`))
        hasAnyHook = true
      }
    }

    // Check for other hooks
    const otherHooks = Object.keys(hooks).filter((k) => !hookNames.includes(k))
    for (const name of otherHooks) {
      const hook = hooks[name]
      if (hook && Array.isArray(hook) && hook.length > 0) {
        this.log(pc.green(`  ✓ ${name}: ${(hook as unknown[]).length} handler(s)`))
        hasAnyHook = true
      }
    }

    if (!hasAnyHook) {
      this.log(pc.dim('  ○ No hooks configured'))
    }

    this.log('')

    // 3. Reports Directory
    this.log(pc.bold('Reports Directory'))
    if (fs.existsSync(REPORTS_DIR)) {
      const files = fs.readdirSync(REPORTS_DIR)
      this.log(pc.green(`  ✓ ${REPORTS_DIR}`))
      this.log(pc.dim(`    ${files.length} file(s)`))
    } else {
      this.log(pc.yellow(`  ⚠ ${REPORTS_DIR} does not exist`))
      this.log(pc.dim('    Run: tt observe setup'))
    }

    this.log('')

    // 4. OTEL Environment Variables
    this.log(pc.bold('OTEL Environment Variables'))

    const otelVars = [
      { name: 'CLAUDE_CODE_ENABLE_TELEMETRY', expected: '1' },
      { name: 'OTEL_METRICS_EXPORTER', expected: 'otlp' },
      { name: 'OTEL_LOGS_EXPORTER', expected: 'otlp' },
      { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', expected: undefined },
    ]

    for (const { name, expected } of otelVars) {
      const value = process.env[name]
      if (value) {
        if (expected && value !== expected) {
          this.log(pc.yellow(`  ⚠ ${name}=${value} (expected: ${expected})`))
        } else {
          this.log(pc.green(`  ✓ ${name}=${value}`))
        }
      } else {
        this.log(pc.dim(`  ○ ${name}: not set`))
      }
    }

    this.log('')
  }
}
