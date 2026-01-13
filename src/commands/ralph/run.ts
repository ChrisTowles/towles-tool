import * as fs from 'node:fs'
import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { consola } from 'consola'
import { BaseCommand } from '../base.js'
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
} from './lib/state.js'
import {
  buildIterationPrompt,
  formatDuration,
  extractOutputSummary,
  detectCompletionMarker,
  formatTasksForPrompt,
} from './lib/formatter.js'
import { checkClaudeCli, runIteration } from './lib/execution.js'

/**
 * Read last N iterations from progress file. Only returns iteration entries,
 * excluding headers/status sections that could confuse the model.
 */
function readLastIterations(filePath: string, count: number): string {
  if (!fs.existsSync(filePath)) return ''
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    // Split by iteration headers, keeping the delimiter
    const parts = content.split(/(?=### Iteration)/g)
    // Skip first part (header/status content) - only want iteration entries
    const iterations = parts.filter(p => p.startsWith('### Iteration'))
    if (iterations.length === 0) return ''
    return iterations.slice(-count).join('\n').trim()
  } catch {
    return ''
  }
}

/**
 * Run the autonomous ralph loop
 */
export default class Run extends BaseCommand {
  static override description = 'Start the autonomous ralph loop'

  static override examples = [
    '<%= config.bin %> ralph run',
    '<%= config.bin %> ralph run --maxIterations 20',
    '<%= config.bin %> ralph run --taskId 5',
    '<%= config.bin %> ralph run --no-autoCommit',
    '<%= config.bin %> ralph run --noFork',
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
    noFork: Flags.boolean({
      description: 'Disable session forking (start fresh session)',
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
    let remainingTasks = state.tasks.filter(t => t.status !== 'done')
    if (labelFilter) {
      remainingTasks = remainingTasks.filter(t => t.label === labelFilter)
    }
    if (remainingTasks.length === 0) {
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
      console.log(`  Fork session: ${!flags.noFork}`)
      console.log(`  Session ID: ${state.sessionId || '(none)'}`)
      console.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(' ')}`)
      console.log(`  Remaining tasks: ${remainingTasks.length}`)

      console.log(pc.cyan('\nTasks:'))
      for (const t of state.tasks) {
        const icon = t.status === 'done' ? '✓' : '○'
        const focus = focusedTaskId === t.id ? pc.cyan(' ← FOCUS') : ''
        console.log(`  ${icon} ${t.id}. ${t.description} (${t.status})${focus}`)
      }

      // Show prompt preview
      const progressContent = readLastIterations(DEFAULT_PROGRESS_FILE, 3)
      const taskList = formatTasksForPrompt(remainingTasks)
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        progressFile: DEFAULT_PROGRESS_FILE,
        focusedTaskId,
        skipCommit: !flags.autoCommit,
        progressContent: progressContent || undefined,
        taskList,
      })
      consola.box({
        title: 'Prompt Preview',
        message: prompt,
      })

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

    const ready = state.tasks.filter(t => t.status === 'ready').length
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
    console.log(pc.dim(`Fork session: ${!flags.noFork}${state.sessionId ? ` (session: ${state.sessionId.slice(0, 8)}...)` : ''}`))
    console.log(pc.dim(`Tasks: ${state.tasks.length} (${done} done, ${ready} ready)`))
    console.log()

    logStream.write(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}\n`)
    logStream.write(`Max iterations: ${maxIterations}\n`)
    logStream.write(`Tasks: ${state.tasks.length} (${done} done, ${ready} ready)\n\n`)

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
    let completed = false

    while (state.iteration < maxIterations && !interrupted && !completed) {
      state.iteration++
      const currentIteration = state.iteration

      const iterHeader = `Iteration ${currentIteration}/${maxIterations}`
      logStream.write(`\n━━━ ${iterHeader} ━━━\n`)

      const iterationStart = new Date().toISOString()
      const progressContent = readLastIterations(DEFAULT_PROGRESS_FILE, 3)
      // Reload remaining tasks for current state
      const currentRemainingTasks = state.tasks.filter(t => t.status !== 'done')
      const taskList = formatTasksForPrompt(labelFilter ? currentRemainingTasks.filter(t => t.label === labelFilter) : currentRemainingTasks)
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        progressFile: DEFAULT_PROGRESS_FILE,
        focusedTaskId,
        skipCommit: !flags.autoCommit,
        progressContent: progressContent || undefined,
        taskList,
      })

      // Log the prompt
      logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`)

      // Build claude args
      const iterClaudeArgs = [...extraClaudeArgs]
      const currentTask = focusedTaskId
        ? state.tasks.find(t => t.id === focusedTaskId)
        : state.tasks.find(t => t.status === 'ready')

      // Fork from task's sessionId (or state-level fallback) unless disabled
      const taskSessionId = currentTask?.sessionId || state.sessionId
      if (!flags.noFork && taskSessionId) {
        iterClaudeArgs.push('--fork-session', taskSessionId)
      }

      // Print iteration header
      const sessionInfo = taskSessionId ? pc.dim(` (fork: ${taskSessionId.slice(0, 8)}...)`) : ''
      console.log()
      console.log(pc.bold(pc.blue(`━━━ ${iterHeader}${sessionInfo} ━━━`)))
      consola.box({ title: 'Prompt', message: prompt })

      // Run iteration - output goes directly to stdout
      const iterResult = await runIteration(prompt, iterClaudeArgs, logStream)

      // Reload state from disk to pick up changes made by child claude process
      const freshState = loadState(flags.stateFile)
      if (freshState) {
        const currentIter = state.iteration
        Object.assign(state, freshState, { iteration: currentIter })
      }

      // Store session ID on the current task for future resumption
      const taskToUpdate = currentTask ? state.tasks.find(t => t.id === currentTask.id) : undefined
      if (iterResult.sessionId && taskToUpdate && !taskToUpdate.sessionId) {
        taskToUpdate.sessionId = iterResult.sessionId
        state.sessionId = iterResult.sessionId
      }

      const iterationEnd = new Date().toISOString()
      const markerFound = detectCompletionMarker(iterResult.output, flags.completionMarker)

      // Calculate duration
      const startTime = new Date(iterationStart).getTime()
      const endTime = new Date(iterationEnd).getTime()
      const durationMs = endTime - startTime
      const durationHuman = formatDuration(durationMs)

      // Record history
      appendHistory({
        iteration: state.iteration,
        startedAt: iterationStart,
        completedAt: iterationEnd,
        durationMs,
        durationHuman,
        outputSummary: extractOutputSummary(iterResult.output),
        markerFound,
        contextUsedPercent: iterResult.contextUsedPercent,
      })

      // Save state
      saveState(state, flags.stateFile)

      // Log summary
      const contextInfo = iterResult.contextUsedPercent !== undefined ? ` | Context: ${iterResult.contextUsedPercent}%` : ''
      logStream.write(`\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? 'yes' : 'no'}\n`)
      console.log(pc.dim(`Duration: ${durationHuman}${contextInfo} | Marker: ${markerFound ? pc.green('yes') : pc.yellow('no')}`))

      // Check completion
      if (markerFound) {
        completed = true
        state.status = 'completed'
        saveState(state, flags.stateFile)
        console.log(pc.bold(pc.green(`\n✅ Task completed after ${state.iteration} iteration(s)`)))
        logStream.write(`\n✅ Task completed after ${state.iteration} iteration(s)\n`)
      }
    }

    logStream.end()

    // Final status
    if (completed) {
      return
    }

    if (!interrupted && state.iteration >= maxIterations) {
      state.status = 'max_iterations_reached'
      saveState(state, flags.stateFile)
      console.log(pc.bold(pc.yellow(`\n⚠️  Max iterations (${maxIterations}) reached without completion`)))
      console.log(pc.dim(`State saved to: ${flags.stateFile}`))
      logStream.write(`\n⚠️  Max iterations (${maxIterations}) reached without completion\n`)
      this.exit(1)
    }
  }
}
