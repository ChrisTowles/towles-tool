import { Args, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import pc from 'picocolors'
import { BaseCommand } from '../../commands/base.js'

interface JournalEntry {
  type: string
  sessionId: string
  timestamp: string
  message?: {
    role: 'user' | 'assistant'
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

interface SessionInfo {
  sessionId: string
  path: string
  date: string
  mtime: number
  project: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turnCount: number
  modelBreakdown: Map<string, { input: number; output: number }>
}

// Approximate costs per 1M tokens (USD)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  default: { input: 3, output: 15 }, // Assume sonnet
}

/**
 * List and analyze Claude Code sessions
 */
export default class ObserveSession extends BaseCommand {
  static override description = 'List and analyze Claude Code sessions'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> --limit 20',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({
      char: 'n',
      description: 'Number of sessions to list',
      default: 15,
    }),
  }

  static override args = {
    sessionId: Args.string({
      description: 'Session ID to show detailed turn-by-turn breakdown',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveSession)

    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    if (!fs.existsSync(projectsDir)) {
      this.error('No Claude projects directory found at ~/.claude/projects/')
    }

    if (args.sessionId) {
      await this.showSessionDetail(projectsDir, args.sessionId)
    } else {
      await this.listSessions(projectsDir, flags.limit)
    }
  }

  private async listSessions(projectsDir: string, limit: number): Promise<void> {
    this.log(pc.cyan('\n📋 Recent Sessions\n'))

    const sessions = this.findSessions(projectsDir, limit)
    if (sessions.length === 0) {
      this.log('No sessions found.')
      return
    }

    // Table header
    this.log(
      pc.dim(
        `${'Session ID'.padEnd(12)} ${'Date'.padEnd(12)} ${'Tokens'.padEnd(10)} ${'Est. Cost'.padEnd(10)} Project`
      )
    )
    this.log(pc.dim('─'.repeat(80)))

    for (const s of sessions) {
      const cost = this.estimateCost(s)
      const costStr = cost > 0 ? `$${cost.toFixed(2)}` : '-'

      this.log(
        `${pc.bold(s.sessionId.slice(0, 10))}  ${s.date.padEnd(12)} ${this.formatTokens(s.totalTokens).padEnd(10)} ${costStr.padEnd(10)} ${pc.dim(s.project)}`
      )
    }

    this.log(pc.dim('─'.repeat(80)))
    this.log(pc.dim(`\nShowing ${sessions.length} sessions. Use --limit to show more.`))
    this.log(pc.dim('Run with session ID for detailed breakdown: tt observe session <id>'))
  }

  private async showSessionDetail(projectsDir: string, sessionId: string): Promise<void> {
    const sessionPath = this.findSessionPath(projectsDir, sessionId)
    if (!sessionPath) {
      this.error(`Session ${sessionId} not found`)
    }

    const session = this.analyzeSession(sessionPath, sessionId)
    const turns = this.parseTurns(sessionPath)

    this.log(pc.cyan(`\n📊 Session: ${sessionId}\n`))
    this.log(`Project: ${pc.dim(session.project)}`)
    this.log(`Date: ${session.date}`)
    this.log(`Turns: ${session.turnCount}`)
    this.log('')

    // Token summary
    this.log(pc.bold('Token Summary'))
    this.log(`  Total:        ${this.formatTokens(session.totalTokens)}`)
    this.log(`  Input:        ${this.formatTokens(session.inputTokens)}`)
    this.log(`  Output:       ${this.formatTokens(session.outputTokens)}`)
    if (session.cacheReadTokens > 0) {
      this.log(`  Cache Read:   ${this.formatTokens(session.cacheReadTokens)}`)
    }
    this.log('')

    // Cost estimate
    const cost = this.estimateCost(session)
    this.log(pc.bold('Estimated Cost'))
    this.log(`  Total: ${pc.yellow(`$${cost.toFixed(2)}`)}`)
    this.log('')

    // Model breakdown
    if (session.modelBreakdown.size > 0) {
      this.log(pc.bold('By Model'))
      for (const [model, usage] of session.modelBreakdown) {
        const total = usage.input + usage.output
        const pct = ((total / session.totalTokens) * 100).toFixed(0)
        const icon = this.getModelIcon(model)
        this.log(
          `  ${icon} ${model.padEnd(25)} ${this.formatTokens(total).padEnd(10)} (${pct}%)`
        )
      }
      this.log('')
    }

    // Turn-by-turn breakdown
    if (turns.length > 0) {
      this.log(pc.bold('Turn-by-Turn'))
      this.log(
        pc.dim(
          `${'#'.padStart(4)} ${'Role'.padEnd(10)} ${'Model'.padEnd(28)} ${'Input'.padEnd(8)} ${'Output'.padEnd(8)}`
        )
      )
      this.log(pc.dim('─'.repeat(68)))

      for (const turn of turns) {
        const icon = this.getModelIcon(turn.model)
        const roleColor = turn.role === 'user' ? pc.green : pc.blue
        const modelName = turn.model.length > 26 ? turn.model.slice(0, 26) + '..' : turn.model
        this.log(
          `${turn.num.toString().padStart(4)} ${roleColor(turn.role.padEnd(10))} ${icon} ${modelName.padEnd(26)} ${this.formatTokens(turn.input).padEnd(8)} ${this.formatTokens(turn.output).padEnd(8)}`
        )
      }
    }
  }

  private parseTurns(filePath: string): Array<{
    num: number
    role: 'user' | 'assistant'
    model: string
    input: number
    output: number
  }> {
    const turns: Array<{
      num: number
      role: 'user' | 'assistant'
      model: string
      input: number
      output: number
    }> = []

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      let turnNum = 0

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (entry.type === 'user') {
            turnNum++
          }

          if (entry.message?.role) {
            const usage = entry.message.usage || {}
            turns.push({
              num: turnNum,
              role: entry.message.role,
              model: entry.message.model || 'unknown',
              input: usage.input_tokens || 0,
              output: usage.output_tokens || 0,
            })
          }
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // Return empty on error
    }

    return turns
  }

  private findSessions(projectsDir: string, limit: number): SessionInfo[] {
    const sessions: SessionInfo[] = []

    const projectDirs = fs.readdirSync(projectsDir)
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = path.join(projectPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = file.replace('.jsonl', '')

        const info = this.analyzeSession(filePath, sessionId)
        info.project = this.decodeProjectPath(project)
        info.mtime = stat.mtimeMs

        sessions.push(info)
      }
    }

    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions.slice(0, limit)
  }

  private findSessionPath(projectsDir: string, sessionId: string): string | undefined {
    const projectDirs = fs.readdirSync(projectsDir)
    const matches: string[] = []

    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      // Exact match
      const jsonlPath = path.join(projectPath, `${sessionId}.jsonl`)
      if (fs.existsSync(jsonlPath)) {
        return jsonlPath
      }

      // Partial match (session ID contains the query)
      const files = fs
        .readdirSync(projectPath)
        .filter((f) => f.endsWith('.jsonl') && f.includes(sessionId))
      for (const f of files) {
        matches.push(path.join(projectPath, f))
      }
    }

    // Return if exactly one match
    if (matches.length === 1) {
      return matches[0]
    }
    return undefined
  }

  private analyzeSession(filePath: string, sessionId: string): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      path: filePath,
      date: '',
      mtime: 0,
      project: '',
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      turnCount: 0,
      modelBreakdown: new Map(),
    }

    try {
      const stat = fs.statSync(filePath)
      info.date = stat.mtime.toISOString().split('T')[0]
      info.mtime = stat.mtimeMs

      // Parse parent dir for project
      const parentDir = path.basename(path.dirname(filePath))
      info.project = this.decodeProjectPath(parentDir)

      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (entry.type === 'user') {
            info.turnCount++
          }

          if (entry.message?.usage) {
            const u = entry.message.usage
            const input = u.input_tokens || 0
            const output = u.output_tokens || 0
            const cacheRead = u.cache_read_input_tokens || 0

            info.inputTokens += input
            info.outputTokens += output
            info.cacheReadTokens += cacheRead
            info.totalTokens += input + output

            // Track by model
            const model = entry.message.model || 'unknown'
            const existing = info.modelBreakdown.get(model) || { input: 0, output: 0 }
            existing.input += input
            existing.output += output
            info.modelBreakdown.set(model, existing)
          }
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // Return partial info
    }

    return info
  }

  private decodeProjectPath(encoded: string): string {
    // Project dirs are encoded with - for / and other chars
    return encoded.replace(/-/g, '/').slice(0, 35)
  }

  private estimateCost(session: SessionInfo): number {
    let total = 0
    for (const [model, usage] of session.modelBreakdown) {
      const rates = this.getModelRates(model)
      total += (usage.input / 1_000_000) * rates.input
      total += (usage.output / 1_000_000) * rates.output
    }
    return total
  }

  private getModelRates(model: string): { input: number; output: number } {
    if (model.includes('opus')) return MODEL_COSTS['claude-opus-4']
    if (model.includes('haiku')) return MODEL_COSTS['claude-3-haiku']
    if (model.includes('sonnet')) return MODEL_COSTS['claude-sonnet-4']
    return MODEL_COSTS['default']
  }

  private getModelIcon(model: string): string {
    if (model.includes('opus')) return '🔴'
    if (model.includes('sonnet')) return '🔵'
    if (model.includes('haiku')) return '🟢'
    return '⚪'
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toString()
  }
}
