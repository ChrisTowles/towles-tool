import * as fs from 'node:fs'
import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../commands/base.js'
import {
  DEFAULT_STATE_FILE,
  DEFAULT_LOG_FILE,
  DEFAULT_PROGRESS_FILE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_COMPLETION_MARKER,
  CLAUDE_DEFAULT_ARGS,
  loadState,
  saveState,
  appendHistory,
} from '../../commands/ralph/state.js'
import {
  buildIterationPrompt,
  formatDuration,
  extractOutputSummary,
  detectCompletionMarker,
} from '../../commands/ralph/formatter.js'
import { checkClaudeCli, runIteration } from '../../commands/ralph/execution.js'

/**
 * Read last N lines from a file. Returns empty string if file doesn't exist.
 */
function readLastLines(filePath: string, lineCount: number): string {
  if (!fs.existsSync(filePath)) return ''
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    return lines.slice(-lineCount).join('\n').trim()
  } catch {
    return ''
  }
}

/**
 * Run the autonomous ralph loop
 */
export default class Run extends BaseCommand {
  static override description = 'Start the autonomous ralph loop'

  static override aliases = ['ralph:run']

  static override examples = [
    '<%= config.bin %> ralph run',
    '<%= config.bin %> ralph run --maxIterations 20',
    '<%= config.bin %> ralph run --taskId 5',
    '<%= config.bin %> ralph run --no-autoCommit',
    '<%= config.bin %> ralph run --noResume',
    '<%= config.bin %> ralph run --dryRun',
    '<%= config.bin %> ralph run --addIterations 5',
    '<%= config.bin %> ralph run --label backend',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: 's',
      description: 'State file path',
      default: DEFAULT_STATE_FILE,
    }),
    taskId: Flags.integer({
      char: 't',
      description: 'Focus on specific task ID',
    }),
    maxIterations: Flags.integer({
      char: 'm',
      description: 'Max iterations',
      default: DEFAULT_MAX_ITERATIONS,
    }),
    addIterations: Flags.integer({
      char: 'a',
      description: 'Add iterations to current count (e.g., at 5/10, --addIterations 10 makes it 5/20)',
    }),
    autoCommit: Flags.boolean({
      description: 'Auto-commit after each completed task',
      default: true,
      allowNo: true,
    }),
    noResume: Flags.boolean({
      description: 'Disable auto-resume (start fresh session)',
      default: false,
    }),
    dryRun: Flags.boolean({
      char: 'n',
      description: 'Show config without executing',
      default: false,
    }),
    claudeArgs: Flags.string({
      description: 'Extra args to pass to claude CLI (space-separated)',
    }),
    logFile: Flags.string({
      description: 'Log file path',
      default: DEFAULT_LOG_FILE,
    }),
    completionMarker: Flags.string({
      description: 'Completion marker',
      default: DEFAULT_COMPLETION_MARKER,
    }),
    label: Flags.string({
      char: 'l',
      description: 'Only run tasks with this label',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Run)

    let maxIterations = flags.maxIterations
    const addIterations = flags.addIterations
    const extraClaudeArgs = flags.claudeArgs?.split(' ').filter(Boolean) || []
    const focusedTaskId = flags.taskId ?? null

    // Load existing state
    let state = loadState(flags.stateFile)

    if (!state) {
      this.error(`No state file found at: ${flags.stateFile}\nUse: tt ralph task add "description"`)
    }

    // Handle --addIterations: extend max from current iteration
    if (addIterations !== undefined) {
      maxIterations = state.iteration + addIterations
      console.log(pc.cyan(`Adding ${addIterations} iterations: ${state.iteration}/${state.maxIterations} → ${state.iteration}/${maxIterations}`))
    }

    // Filter by label if specified
    const labelFilter = flags.label
    let pendingTasks = state.tasks.filter(t => t.status !== 'done')
    if (labelFilter) {
      pendingTasks = pendingTasks.filter(t => t.label === labelFilter)
    }
    if (pendingTasks.length === 0) {
      const msg = labelFilter ? `All tasks with label '${labelFilter}' are done!` : 'All tasks are done!'
      console.log(pc.green(`✅ ${msg}`))
      return
    }

    // Validate focused task if specified
    if (focusedTaskId !== null) {
      const focusedTask = state.tasks.find(t => t.id === focusedTaskId)
      if (!focusedTask) {
        this.error(`Task #${focusedTaskId} not found. Use: tt ralph task list`)
      }
      if (focusedTask.status === 'done') {
        console.log(pc.yellow(`Task #${focusedTaskId} is already done.`))
        return
      }
    }

    // Dry run mode
    if (flags.dryRun) {
      console.log(pc.bold('\n=== DRY RUN ===\n'))
      console.log(pc.cyan('Config:'))
      console.log(`  Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`)
      console.log(`  Label filter: ${labelFilter || '(none)'}`)
      console.log(`  Max iterations: ${maxIterations}`)
      console.log(`  State file: ${flags.stateFile}`)
      console.log(`  Log file: ${flags.logFile}`)
      console.log(`  Completion marker: ${flags.completionMarker}`)
      console.log(`  Auto-commit: ${flags.autoCommit}`)
      console.log(`  Auto-resume: ${!flags.noResume}`)
      console.log(`  Session ID: ${state.sessionId || '(none)'}`)
      console.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(' ')}`)
      console.log(`  Pending tasks: ${pendingTasks.length}`)

      console.log(pc.cyan('\nTasks:'))
      for (const t of state.tasks) {
        const icon = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '→' : '○'
        const focus = focusedTaskId === t.id ? pc.cyan(' ← FOCUS') : ''
        console.log(`  ${icon} ${t.id}. ${t.description} (${t.status})${focus}`)
      }

      console.log(pc.bold('\n=== END DRY RUN ===\n'))
      return
    }

    // Check claude CLI is available
    if (!await checkClaudeCli()) {
      this.error('claude CLI not found in PATH\nInstall Claude Code: https://docs.anthropic.com/en/docs/claude-code')
    }

    // Update state for this run
    state.maxIterations = maxIterations
    state.status = 'running'

    // Create log stream (append mode)
    const logStream = fs.createWriteStream(flags.logFile, { flags: 'a' })

    const pending = state.tasks.filter(t => t.status === 'pending').length
    const done = state.tasks.filter(t => t.status === 'done').length

    logStream.write(`\n${'='.repeat(60)}\n`)
    logStream.write(`Ralph Loop Started: ${new Date().toISOString()}\n`)
    logStream.write(`${'='.repeat(60)}\n\n`)

    console.log(pc.bold(pc.blue('\nRalph Loop Starting\n')))
    console.log(pc.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`))
    if (labelFilter) {
      console.log(pc.dim(`Label filter: ${labelFilter}`))
    }
    console.log(pc.dim(`Max iterations: ${maxIterations}`))
    console.log(pc.dim(`Log file: ${flags.logFile}`))
    console.log(pc.dim(`Auto-commit: ${flags.autoCommit}`))
    console.log(pc.dim(`Auto-resume: ${!flags.noResume}${state.sessionId ? ` (session: ${state.sessionId.slice(0, 8)}...)` : ''}`))
    console.log(pc.dim(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)`))
    console.log()

    logStream.write(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}\n`)
    logStream.write(`Max iterations: ${maxIterations}\n`)
    logStream.write(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)\n\n`)

    // Handle SIGINT gracefully
    let interrupted = false
    process.on('SIGINT', () => {
      if (interrupted) {
        logStream.end()
        process.exit(130)
      }
      interrupted = true
      const msg = '\n\nInterrupted. Press Ctrl+C again to force exit.\n'
      console.log(pc.yellow(msg))
      logStream.write(msg)
      state.status = 'error'
      saveState(state, flags.stateFile)
    })

    // Main loop
    while (state.iteration < maxIterations && !interrupted) {
      state.iteration++

      const iterHeader = `\n━━━ Iteration ${state.iteration}/${maxIterations} ━━━\n`
      console.log(pc.bold(pc.cyan(iterHeader)))
      logStream.write(iterHeader)

      const iterationStart = new Date().toISOString()
      const progressContent = readLastLines(DEFAULT_PROGRESS_FILE, 100)
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        stateFile: flags.stateFile,
        progressFile: DEFAULT_PROGRESS_FILE,
        focusedTaskId,
        skipCommit: !flags.autoCommit,
        progressContent: progressContent || undefined,
      })

      // Log the prompt
      logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`)

      // Build claude args, adding --resume if task has a session ID
      const iterClaudeArgs = [...extraClaudeArgs]
      const currentTask = focusedTaskId
        ? state.tasks.find(t => t.id === focusedTaskId)
        : state.tasks.find(t => t.status === 'in_progress' || t.status === 'pending')

      // Auto-resume from task's sessionId (or state-level fallback) unless disabled
      const taskSessionId = currentTask?.sessionId || state.sessionId
      if (!flags.noResume && taskSessionId) {
        iterClaudeArgs.push('--resume', taskSessionId)
        console.log(pc.dim(`Resuming session: ${taskSessionId.slice(0, 8)}...`))
      }

      const { output, contextUsedPercent, sessionId } = await runIteration(prompt, iterClaudeArgs, logStream)

      // Reload state from disk to pick up changes made by child claude process
      // (e.g., `tt ralph task done <id>` marks tasks complete)
      const freshState = loadState(flags.stateFile)
      if (freshState) {
        // Adopt child's task changes, keep parent-managed fields
        state.tasks = freshState.tasks
        // Keep session ID from child if it set one
        if (freshState.sessionId) {
          state.sessionId = freshState.sessionId
        }
      }

      // Store session ID on the current task for future resumption
      if (sessionId && currentTask && !currentTask.sessionId) {
        currentTask.sessionId = sessionId
        state.sessionId = sessionId  // Also store at state level as fallback
        console.log(pc.dim(`Session ID stored on task #${currentTask.id}: ${sessionId.slice(0, 8)}...`))
      }

      const iterationEnd = new Date().toISOString()
      const markerFound = detectCompletionMarker(output, flags.completionMarker)

      // Calculate duration
      const startTime = new Date(iterationStart).getTime()
      const endTime = new Date(iterationEnd).getTime()
      const durationMs = endTime - startTime
      const durationHuman = formatDuration(durationMs)

      // Record history to JSON lines file
      appendHistory({
        iteration: state.iteration,
        startedAt: iterationStart,
        completedAt: iterationEnd,
        durationMs,
        durationHuman,
        outputSummary: extractOutputSummary(output),
        markerFound,
        contextUsedPercent,
      })

      // Save state after each iteration
      saveState(state, flags.stateFile)

      // Log iteration summary
      const contextInfo = contextUsedPercent !== undefined ? ` | Context: ${contextUsedPercent}%` : ''
      const summaryMsg = `\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? 'yes' : 'no'}\n`
      console.log(pc.dim(`\n━━━ Iteration ${state.iteration} Summary ━━━`))
      console.log(pc.dim(`Duration: ${durationHuman}${contextInfo}`))
      console.log(pc.dim(`Marker found: ${markerFound ? pc.green('yes') : pc.yellow('no')}`))
      logStream.write(summaryMsg)

      // Check completion
      if (markerFound) {
        state.status = 'completed'
        saveState(state, flags.stateFile)
        const doneMsg = `\n✅ Task completed after ${state.iteration} iteration(s)\n`
        console.log(pc.bold(pc.green(doneMsg)))
        logStream.write(doneMsg)
        logStream.end()
        return
      }
    }

    // Max iterations reached
    if (!interrupted) {
      state.status = 'max_iterations_reached'
      saveState(state, flags.stateFile)
      const maxMsg = `\n⚠️  Max iterations (${maxIterations}) reached without completion\n`
      console.log(pc.bold(pc.yellow(maxMsg)))
      console.log(pc.dim(`State saved to: ${flags.stateFile}`))
      logStream.write(maxMsg)
      logStream.end()
      this.exit(1)
    }
  }
}
