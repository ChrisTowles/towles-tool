import { Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { x } from 'tinyexec'
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
    content?: unknown
  }
  uuid?: string
}

interface SpeedscopeFrame {
  name: string
  file?: string
}

interface SpeedscopeProfile {
  type: 'sampled'
  name: string
  unit: string
  startValue: number
  endValue: number
  samples: number[][]
  weights: number[]
}

interface SpeedscopeFile {
  $schema: string
  profiles: SpeedscopeProfile[]
  shared: {
    frames: SpeedscopeFrame[]
  }
  name: string
}

/**
 * Generate Speedscope flamegraph from session data
 */
export default class ObserveFlamegraph extends BaseCommand {
  static override description = 'Generate Speedscope flamegraph from session token data'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --session abc123',
    '<%= config.bin %> <%= command.id %> --open',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    session: Flags.string({
      char: 's',
      description: 'Session ID to analyze (uses fzf for interactive selection if not provided)',
    }),
    open: Flags.boolean({
      char: 'o',
      description: 'Open Speedscope in browser after generating',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ObserveFlamegraph)

    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    if (!fs.existsSync(projectsDir)) {
      this.error('No Claude projects directory found at ~/.claude/projects/')
    }

    let sessionId = flags.session
    let sessionPath: string | undefined

    if (!sessionId) {
      // Interactive selection with fzf
      const sessions = this.findRecentSessions(projectsDir, 50)
      if (sessions.length === 0) {
        this.error('No sessions found')
      }

      // Format for fzf: sessionId | date | tokens | project
      const fzfInput = sessions
        .map((s) => `${s.sessionId}\t${s.date}\t${this.formatTokens(s.tokens)}t\t${s.project}`)
        .join('\n')

      try {
        // Use bash to pipe input to fzf
        const result = await x('bash', [
          '-c',
          `echo "${fzfInput.replace(/"/g, '\\"')}" | fzf --header="Select session (ID | Date | Tokens | Project)"`,
        ])

        if (result.exitCode !== 0 || !result.stdout.trim()) {
          this.error('No session selected')
        }

        const selected = result.stdout.trim().split('\t')[0]
        sessionId = selected
        sessionPath = sessions.find((s) => s.sessionId === selected)?.path
      } catch {
        // fzf not available, show list and ask for input
        this.log('Recent sessions:')
        for (const s of sessions.slice(0, 10)) {
          this.log(`  ${s.sessionId}  ${s.date}  ${this.formatTokens(s.tokens)}t  ${s.project}`)
        }
        this.error('Use --session <id> to select a session (fzf not available)')
      }
    }

    if (!sessionPath) {
      sessionPath = this.findSessionPath(projectsDir, sessionId!)
    }

    if (!sessionPath) {
      this.error(`Session ${sessionId} not found`)
    }

    this.log(`📊 Generating flamegraph for session ${sessionId}...`)

    // Parse JSONL and build Speedscope format
    const entries = this.parseJsonl(sessionPath)
    const speedscope = this.buildSpeedscope(sessionId!, entries)

    // Write output file
    const reportsDir = path.join(os.homedir(), '.claude', 'reports')
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true })
    }

    const timestamp = new Date().toISOString().split('T')[0]
    const filename = `flamegraph-${sessionId!.slice(0, 8)}-${timestamp}.json`
    const outputPath = path.join(reportsDir, filename)

    fs.writeFileSync(outputPath, JSON.stringify(speedscope, null, 2))
    this.log(`✓ Saved to ${outputPath}`)

    if (flags.open) {
      this.log('\n📈 Opening Speedscope...')
      this.log('   Drag and drop the JSON file into https://speedscope.app')
      // Open browser
      const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
      await x(openCmd, ['https://speedscope.app'])
    }
  }

  private findRecentSessions(
    projectsDir: string,
    limit: number
  ): Array<{ sessionId: string; path: string; date: string; tokens: number; project: string }> {
    const sessions: Array<{
      sessionId: string
      path: string
      date: string
      tokens: number
      project: string
      mtime: number
    }> = []

    const projectDirs = fs.readdirSync(projectsDir)
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = path.join(projectPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = file.replace('.jsonl', '')

        // Quick token count from file
        const tokens = this.quickTokenCount(filePath)

        sessions.push({
          sessionId,
          path: filePath,
          date: stat.mtime.toISOString().split('T')[0],
          tokens,
          project: project.replace(/-/g, '/').slice(0, 30),
          mtime: stat.mtimeMs,
        })
      }
    }

    // Sort by modification time, most recent first
    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions.slice(0, limit)
  }

  private quickTokenCount(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      let total = 0
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (entry.message?.usage) {
            total +=
              (entry.message.usage.input_tokens || 0) + (entry.message.usage.output_tokens || 0)
          }
        } catch {
          // Skip invalid lines
        }
      }
      return total
    } catch {
      return 0
    }
  }

  private findSessionPath(projectsDir: string, sessionId: string): string | undefined {
    const projectDirs = fs.readdirSync(projectsDir)
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      const jsonlPath = path.join(projectPath, `${sessionId}.jsonl`)
      if (fs.existsSync(jsonlPath)) {
        return jsonlPath
      }
    }
    return undefined
  }

  private parseJsonl(filePath: string): JournalEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8')
    const entries: JournalEntry[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch {
        // Skip invalid lines
      }
    }

    return entries
  }

  private buildSpeedscope(sessionId: string, entries: JournalEntry[]): SpeedscopeFile {
    const frames: SpeedscopeFrame[] = []
    const samples: number[][] = []
    const weights: number[] = []

    // Frame 0: Session root
    frames.push({ name: `Session: ${sessionId.slice(0, 8)}` })

    let turnNumber = 0
    let turnFrameIndex = -1

    for (const entry of entries) {
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (!entry.message) continue

      const role = entry.message.role
      const usage = entry.message.usage
      const model = entry.message.model

      // Start new turn on user message
      if (role === 'user') {
        turnNumber++
        turnFrameIndex = frames.length
        frames.push({ name: `Turn ${turnNumber}` })
      }

      if (!usage) continue

      // Calculate total tokens for this message
      const inputTokens = usage.input_tokens || 0
      const outputTokens = usage.output_tokens || 0
      const totalTokens = inputTokens + outputTokens

      if (totalTokens === 0) continue

      // Get model color prefix for frame name
      const modelPrefix = this.getModelPrefix(model)
      const frameName = `${modelPrefix}${role === 'user' ? 'User' : 'Claude'} (${this.formatTokens(totalTokens)}t)`

      const messageFrameIndex = frames.length
      frames.push({ name: frameName })

      // Build sample stack: session -> turn -> message
      const sample = [0]
      if (turnFrameIndex >= 0) sample.push(turnFrameIndex)
      sample.push(messageFrameIndex)

      samples.push(sample)
      weights.push(totalTokens)
    }

    // Calculate total weight for endValue
    const totalWeight = weights.reduce((a, b) => a + b, 0)

    return {
      $schema: 'https://www.speedscope.app/file-format-schema.json',
      name: `Claude Session ${sessionId.slice(0, 8)}`,
      profiles: [
        {
          type: 'sampled',
          name: 'Token Usage',
          unit: 'tokens',
          startValue: 0,
          endValue: totalWeight,
          samples,
          weights,
        },
      ],
      shared: {
        frames,
      },
    }
  }

  private getModelPrefix(model?: string): string {
    if (!model) return ''
    // Color coding: Opus=🔴, Sonnet=🔵, Haiku=🟢
    if (model.includes('opus')) return '🔴 '
    if (model.includes('sonnet')) return '🔵 '
    if (model.includes('haiku')) return '🟢 '
    return ''
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toString()
  }
}
