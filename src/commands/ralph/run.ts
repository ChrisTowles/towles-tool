import * as fs from 'node:fs'
import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../base'
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
} from './state'
import {
    buildIterationPrompt,
    formatDuration,
    extractOutputSummary,
    detectCompletionMarker,
} from './formatter'
import { checkClaudeCli, runIteration } from './execution'

export default class Run extends BaseCommand {
    static override description = 'Start the autonomous ralph loop'

    static override flags = {
        ...BaseCommand.baseFlags,
        stateFile: Flags.string({
            char: 's',
            default: DEFAULT_STATE_FILE,
            description: `State file path (default: ${DEFAULT_STATE_FILE})`,
        }),
        taskId: Flags.integer({
            char: 't',
            description: 'Focus on specific task ID (optional)',
        }),
        maxIterations: Flags.integer({
            char: 'm',
            default: DEFAULT_MAX_ITERATIONS,
            description: `Max iterations (default: ${DEFAULT_MAX_ITERATIONS})`,
        }),
        addIterations: Flags.integer({
            char: 'a',
            description: 'Add iterations to current count (e.g., at 5/10, --addIterations 10 makes it 5/20)',
        }),
        autoCommit: Flags.boolean({
            default: true,
            description: 'Auto-commit after each completed task',
            allowNo: true,
        }),
        resume: Flags.boolean({
            default: false,
            description: 'Resume from previous session (uses stored session_id)',
        }),
        dryRun: Flags.boolean({
            char: 'n',
            default: false,
            description: 'Show config without executing',
        }),
        claudeArgs: Flags.string({
            description: 'Extra args to pass to claude CLI (space-separated)',
        }),
        logFile: Flags.string({
            default: DEFAULT_LOG_FILE,
            description: `Log file path (default: ${DEFAULT_LOG_FILE})`,
        }),
        completionMarker: Flags.string({
            default: DEFAULT_COMPLETION_MARKER,
            description: `Completion marker (default: ${DEFAULT_COMPLETION_MARKER})`,
        }),
    }

    async run(): Promise<void> {
        const { flags } = await this.parse(Run)

        let maxIterations = flags.maxIterations
        const addIterations = flags.addIterations ?? null
        const extraClaudeArgs = flags.claudeArgs?.split(' ').filter(Boolean) || []
        const focusedTaskId = flags.taskId ?? null

        // Load existing state
        let state = loadState(flags.stateFile)

        if (!state) {
            this.error(`No state file found at: ${flags.stateFile}\nUse: tt ralph task add "description"`)
        }

        // Handle --addIterations: extend max from current iteration
        if (addIterations !== null) {
            maxIterations = state.iteration + addIterations
            this.log(pc.cyan(`Adding ${addIterations} iterations: ${state.iteration}/${state.maxIterations} → ${state.iteration}/${maxIterations}`))
        }

        const pendingTasks = state.tasks.filter(t => t.status !== 'done')
        if (pendingTasks.length === 0) {
            this.log(pc.green('All tasks are done!'))
            return
        }

        // Validate focused task if specified
        let focusedTask = null
        if (focusedTaskId !== null) {
            focusedTask = state.tasks.find(t => t.id === focusedTaskId)
            if (!focusedTask) {
                this.error(`Task #${focusedTaskId} not found\nUse: tt ralph task list`)
            }
            if (focusedTask.status === 'done') {
                this.log(pc.yellow(`Task #${focusedTaskId} is already done.`))
                return
            }
        }

        // Determine session ID for resuming
        // Priority: 1) --resume with state.sessionId, 2) focused task's sessionId
        let sessionIdToResume: string | undefined
        if (flags.resume && state.sessionId) {
            sessionIdToResume = state.sessionId
        } else if (focusedTask?.sessionId) {
            sessionIdToResume = focusedTask.sessionId
        }

        // Dry run mode
        if (flags.dryRun) {
            this.log(pc.bold('\n=== DRY RUN ===\n'))
            this.log(pc.cyan('Config:'))
            this.log(`  Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`)
            this.log(`  Max iterations: ${maxIterations}`)
            this.log(`  State file: ${flags.stateFile}`)
            this.log(`  Log file: ${flags.logFile}`)
            this.log(`  Completion marker: ${flags.completionMarker}`)
            this.log(`  Auto-commit: ${flags.autoCommit}`)
            this.log(`  Resume mode: ${flags.resume}`)
            this.log(`  Session ID: ${sessionIdToResume || '(none)'}`)
            this.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(' ')}`)
            this.log(`  Pending tasks: ${pendingTasks.length}`)

            this.log(pc.cyan('\nTasks:'))
            for (const t of state.tasks) {
                const icon = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '→' : '○'
                const focus = focusedTaskId === t.id ? pc.cyan(' ← FOCUS') : ''
                const sessionInfo = t.sessionId ? pc.dim(` [session: ${t.sessionId.slice(0, 8)}...]`) : ''
                this.log(`  ${icon} ${t.id}. ${t.description} (${t.status})${sessionInfo}${focus}`)
            }

            this.log(pc.bold('\n=== END DRY RUN ===\n'))
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

        this.log(pc.bold(pc.blue('\nRalph Loop Starting\n')))
        this.log(pc.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`))
        this.log(pc.dim(`Max iterations: ${maxIterations}`))
        this.log(pc.dim(`Log file: ${flags.logFile}`))
        this.log(pc.dim(`Auto-commit: ${flags.autoCommit}`))
        this.log(pc.dim(`Resume mode: ${flags.resume}${sessionIdToResume ? ` (session: ${sessionIdToResume.slice(0, 8)}...)` : ''}`))
        this.log(pc.dim(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)`))
        this.log()

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
            this.log(pc.yellow(msg))
            logStream.write(msg)
            state.status = 'error'
            saveState(state, flags.stateFile)
        })

        // Main loop
        while (state.iteration < maxIterations && !interrupted) {
            state.iteration++

            const iterHeader = `\n━━━ Iteration ${state.iteration}/${maxIterations} ━━━\n`
            this.log(pc.bold(pc.cyan(iterHeader)))
            logStream.write(iterHeader)

            const iterationStart = new Date().toISOString()
            const prompt = buildIterationPrompt({
                completionMarker: flags.completionMarker,
                stateFile: flags.stateFile,
                progressFile: DEFAULT_PROGRESS_FILE,
                focusedTaskId,
                skipCommit: !flags.autoCommit,
            })

            // Log the prompt
            logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`)

            // Build claude args, adding --resume if we have a session ID
            const iterClaudeArgs = [...extraClaudeArgs]
            if (sessionIdToResume) {
                iterClaudeArgs.push('--resume', sessionIdToResume)
            }

            const { output, contextUsedPercent, sessionId } = await runIteration(prompt, iterClaudeArgs, logStream)

            // Reload state from disk to pick up changes made by child claude process
            const freshState = loadState(flags.stateFile)
            if (freshState) {
                state.tasks = freshState.tasks
                if (freshState.sessionId) {
                    state.sessionId = freshState.sessionId
                }
            }

            // Store session ID for future iterations
            if (sessionId && !state.sessionId) {
                state.sessionId = sessionId
                sessionIdToResume = sessionId
                this.log(pc.dim(`Session ID stored: ${sessionId.slice(0, 8)}...`))
            }

            const iterationEnd = new Date().toISOString()
            const markerFound = detectCompletionMarker(output, flags.completionMarker)

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
                outputSummary: extractOutputSummary(output),
                markerFound,
                contextUsedPercent,
            })

            // Save state after each iteration
            saveState(state, flags.stateFile)

            // Log iteration summary
            const contextInfo = contextUsedPercent !== undefined ? ` | Context: ${contextUsedPercent}%` : ''
            this.log(pc.dim(`\n━━━ Iteration ${state.iteration} Summary ━━━`))
            this.log(pc.dim(`Duration: ${durationHuman}${contextInfo}`))
            this.log(pc.dim(`Marker found: ${markerFound ? pc.green('yes') : pc.yellow('no')}`))
            logStream.write(`\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? 'yes' : 'no'}\n`)

            // Check completion
            if (markerFound) {
                state.status = 'completed'
                saveState(state, flags.stateFile)
                const doneMsg = `\nTask completed after ${state.iteration} iteration(s)\n`
                this.log(pc.bold(pc.green(doneMsg)))
                logStream.write(doneMsg)
                logStream.end()
                return
            }
        }

        // Max iterations reached
        if (!interrupted) {
            state.status = 'max_iterations_reached'
            saveState(state, flags.stateFile)
            const maxMsg = `\nMax iterations (${maxIterations}) reached without completion\n`
            this.log(pc.bold(pc.yellow(maxMsg)))
            this.log(pc.dim(`State saved to: ${flags.stateFile}`))
            logStream.write(maxMsg)
            logStream.end()
            this.exit(1)
        }
    }
}
