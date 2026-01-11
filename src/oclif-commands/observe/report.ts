import { Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { x } from 'tinyexec'
import { BaseCommand } from '../../commands/base.js'

/**
 * Generate token/cost usage report via ccusage
 */
export default class ObserveReport extends BaseCommand {
  static override description = 'Generate token/cost usage report via ccusage'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --weekly',
    '<%= config.bin %> <%= command.id %> --monthly --output',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    daily: Flags.boolean({
      description: 'Show daily breakdown (default)',
      exclusive: ['weekly', 'monthly'],
    }),
    weekly: Flags.boolean({
      description: 'Show weekly breakdown',
      exclusive: ['daily', 'monthly'],
    }),
    monthly: Flags.boolean({
      description: 'Show monthly breakdown',
      exclusive: ['daily', 'weekly'],
    }),
    output: Flags.boolean({
      char: 'o',
      description: 'Save report to ~/.claude/reports/',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ObserveReport)

    // Determine timeframe
    let timeframe = 'daily'
    if (flags.weekly) timeframe = 'weekly'
    if (flags.monthly) timeframe = 'monthly'

    this.log(`📊 Running ccusage (${timeframe} breakdown)...\n`)

    try {
      // Run ccusage with breakdown and json flags using tinyexec
      const result = await x('npx', ['ccusage@latest', timeframe, '--breakdown', '--json'], {
        timeout: 60000,
      })

      if (result.exitCode !== 0) {
        this.error(`ccusage failed: ${result.stderr}`)
      }

      const jsonOutput = result.stdout.trim()

      // Save to file if --output flag
      if (flags.output) {
        const reportsDir = path.join(os.homedir(), '.claude', 'reports')
        if (!fs.existsSync(reportsDir)) {
          fs.mkdirSync(reportsDir, { recursive: true })
        }

        const timestamp = new Date().toISOString().split('T')[0]
        const filename = `report-${timeframe}-${timestamp}.json`
        const outputPath = path.join(reportsDir, filename)

        fs.writeFileSync(outputPath, jsonOutput)
        this.log(`✓ Saved to ${outputPath}\n`)
      }

      // Parse and display formatted output
      this.displayReport(jsonOutput, timeframe)
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        this.error('npx not found. Make sure Node.js is installed.')
      }
      throw error
    }
  }

  private displayReport(jsonOutput: string, _timeframe: string): void {
    try {
      const data = JSON.parse(jsonOutput)

      // Handle different ccusage output formats
      if (Array.isArray(data)) {
        this.displayArrayReport(data)
      } else if (data.breakdown) {
        this.displayBreakdownReport(data)
      } else {
        // Fallback: just show raw JSON formatted nicely
        this.log(JSON.stringify(data, null, 2))
      }
    } catch {
      // If JSON parsing fails, show raw output
      this.log(jsonOutput)
    }
  }

  private displayArrayReport(data: Array<Record<string, unknown>>): void {
    for (const entry of data) {
      const date = entry.date || entry.period || 'Unknown'
      const tokens = this.formatNumber(entry.total_tokens as number || entry.tokens as number || 0)
      const cost = this.formatCost(entry.cost_usd as number || entry.cost as number || 0)

      this.log(`${date}`)
      this.log(`  Tokens: ${tokens}`)
      this.log(`  Cost:   ${cost}`)

      // Show model breakdown if available
      if (entry.models && typeof entry.models === 'object') {
        this.log('  By model:')
        for (const [model, stats] of Object.entries(entry.models as Record<string, { tokens?: number; cost?: number }>)) {
          const modelTokens = this.formatNumber(stats.tokens || 0)
          const modelCost = this.formatCost(stats.cost || 0)
          this.log(`    ${model}: ${modelTokens} tokens, ${modelCost}`)
        }
      }
      this.log('')
    }
  }

  private displayBreakdownReport(data: { breakdown: Record<string, unknown>; total?: unknown }): void {
    if (data.total && typeof data.total === 'object') {
      const total = data.total as Record<string, number>
      this.log('Total')
      this.log(`  Tokens: ${this.formatNumber(total.tokens || 0)}`)
      this.log(`  Cost:   ${this.formatCost(total.cost_usd || total.cost || 0)}`)
      this.log('')
    }

    this.log('Breakdown by model:')
    for (const [model, stats] of Object.entries(data.breakdown)) {
      if (typeof stats === 'object' && stats !== null) {
        const s = stats as Record<string, number>
        this.log(`  ${model}`)
        this.log(`    Input:  ${this.formatNumber(s.input_tokens || 0)} tokens`)
        this.log(`    Output: ${this.formatNumber(s.output_tokens || 0)} tokens`)
        this.log(`    Cost:   ${this.formatCost(s.cost_usd || s.cost || 0)}`)
      }
    }
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toString()
  }

  private formatCost(cost: number): string {
    return `$${cost.toFixed(2)}`
  }
}
