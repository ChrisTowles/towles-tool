import * as fs from 'node:fs'
import chalk from 'chalk'
import { defineCommand } from 'citty'
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
} from '../state'
import {
    buildIterationPrompt,
    formatDuration,
    extractOutputSummary,
    detectCompletionMarker,
} from '../formatter'
import { checkClaudeCli, runIteration } from '../execution'

// ============================================================================
// Shared Args
// ============================================================================

const sharedArgs = {
    stateFile: {
        type: 'string' as const,
        alias: 's',
        default: DEFAULT_STATE_FILE,
        description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    },
}

// ============================================================================
// Run Command
// ============================================================================

export const runCommand = defineCommand({
    meta: {
        name: 'run',
        description: 'Start the autonomous ralph loop',
    },
    args: {
        ...sharedArgs,
        taskId: {
            type: 'string' as const,
            alias: 't',
            description: 'Focus on specific task ID (optional)',
        },
        maxIterations: {
            type: 'string' as const,
            alias: 'm',
            default: String(DEFAULT_MAX_ITERATIONS),
            description: `Max iterations (default: ${DEFAULT_MAX_ITERATIONS})`,
        },
        autoCommit: {
            type: 'boolean' as const,
            default: true,
            description: 'Auto-commit after each completed task',
        },
        resume: {
            type: 'boolean' as const,
            default: false,
            description: 'Resume from previous session (uses stored session_id)',
        },
        dryRun: {
            type: 'boolean' as const,
            alias: 'n',
            default: false,
            description: 'Show config without executing',
        },
        claudeArgs: {
            type: 'string' as const,
            description: 'Extra args to pass to claude CLI (space-separated)',
        },
        logFile: {
            type: 'string' as const,
            default: DEFAULT_LOG_FILE,
            description: `Log file path (default: ${DEFAULT_LOG_FILE})`,
        },
        completionMarker: {
            type: 'string' as const,
            default: DEFAULT_COMPLETION_MARKER,
            description: `Completion marker (default: ${DEFAULT_COMPLETION_MARKER})`,
        },
    },
    async run({ args }) {
        const maxIterations = Number.parseInt(args.maxIterations, 10)
        const extraClaudeArgs = args.claudeArgs?.split(' ').filter(Boolean) || []
        const focusedTaskId = args.taskId ? Number.parseInt(args.taskId, 10) : null

        // Load existing state
        let state = loadState(args.stateFile)

        if (!state) {
            console.error(chalk.red(`Error: No state file found at: ${args.stateFile}`))
            console.error(chalk.dim('Use: tt ralph task add "description"'))
            process.exit(2)
        }

        const pendingTasks = state.tasks.filter(t => t.status !== 'done')
        if (pendingTasks.length === 0) {
            console.log(chalk.green('✅ All tasks are done!'))
            process.exit(0)
        }

        // Validate focused task if specified
        if (focusedTaskId !== null) {
            const focusedTask = state.tasks.find(t => t.id === focusedTaskId)
            if (!focusedTask) {
                console.error(chalk.red(`Error: Task #${focusedTaskId} not found`))
                console.error(chalk.dim('Use: tt ralph task list'))
                process.exit(2)
            }
            if (focusedTask.status === 'done') {
                console.log(chalk.yellow(`Task #${focusedTaskId} is already done.`))
                process.exit(0)
            }
        }

        // Dry run mode
        if (args.dryRun) {
            console.log(chalk.bold('\n=== DRY RUN ===\n'))
            console.log(chalk.cyan('Config:'))
            console.log(`  Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`)
            console.log(`  Max iterations: ${maxIterations}`)
            console.log(`  State file: ${args.stateFile}`)
            console.log(`  Log file: ${args.logFile}`)
            console.log(`  Completion marker: ${args.completionMarker}`)
            console.log(`  Auto-commit: ${args.autoCommit}`)
            console.log(`  Resume mode: ${args.resume}`)
            console.log(`  Session ID: ${state.sessionId || '(none)'}`)
            console.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(' ')}`)
            console.log(`  Pending tasks: ${pendingTasks.length}`)

            console.log(chalk.cyan('\nTasks:'))
            for (const t of state.tasks) {
                const icon = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '→' : '○'
                const focus = focusedTaskId === t.id ? chalk.cyan(' ← FOCUS') : ''
                console.log(`  ${icon} ${t.id}. ${t.description} (${t.status})${focus}`)
            }

            console.log(chalk.bold('\n=== END DRY RUN ===\n'))
            process.exit(0)
        }

        // Check claude CLI is available
        if (!await checkClaudeCli()) {
            console.error(chalk.red('Error: claude CLI not found in PATH'))
            console.error(chalk.yellow('Install Claude Code: https://docs.anthropic.com/en/docs/claude-code'))
            process.exit(2)
        }

        // Update state for this run
        state.maxIterations = maxIterations
        state.status = 'running'

        // Create log stream (append mode)
        const logStream = fs.createWriteStream(args.logFile, { flags: 'a' })

        const pending = state.tasks.filter(t => t.status === 'pending').length
        const done = state.tasks.filter(t => t.status === 'done').length

        logStream.write(`\n${'='.repeat(60)}\n`)
        logStream.write(`Ralph Loop Started: ${new Date().toISOString()}\n`)
        logStream.write(`${'='.repeat(60)}\n\n`)

        console.log(chalk.bold.blue('\n🔄 Ralph Loop Starting\n'))
        console.log(chalk.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`))
        console.log(chalk.dim(`Max iterations: ${maxIterations}`))
        console.log(chalk.dim(`Log file: ${args.logFile}`))
        console.log(chalk.dim(`Auto-commit: ${args.autoCommit}`))
        console.log(chalk.dim(`Resume mode: ${args.resume}${state.sessionId ? ` (session: ${state.sessionId.slice(0, 8)}...)` : ''}`))
        console.log(chalk.dim(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)`))
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
            console.log(chalk.yellow(msg))
            logStream.write(msg)
            state.status = 'error'
            saveState(state, args.stateFile)
        })

        // Main loop
        while (state.iteration < maxIterations && !interrupted) {
            state.iteration++

            const iterHeader = `\n━━━ Iteration ${state.iteration}/${maxIterations} ━━━\n`
            console.log(chalk.bold.cyan(iterHeader))
            logStream.write(iterHeader)

            const iterationStart = new Date().toISOString()
            const prompt = buildIterationPrompt({
                completionMarker: args.completionMarker,
                stateFile: args.stateFile,
                progressFile: DEFAULT_PROGRESS_FILE,
                focusedTaskId,
                skipCommit: !args.autoCommit,
            })

            // Log the prompt
            logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`)

            // Build claude args, adding --resume if we have a session ID
            const iterClaudeArgs = [...extraClaudeArgs]
            if (args.resume && state.sessionId) {
                iterClaudeArgs.push('--resume', state.sessionId)
            }

            const { output, contextUsedPercent, sessionId } = await runIteration(prompt, iterClaudeArgs, logStream)

            // Reload state from disk to pick up changes made by child claude process
            // (e.g., `tt ralph task done <id>` marks tasks complete)
            const freshState = loadState(args.stateFile)
            if (freshState) {
                // Adopt child's task changes, keep parent-managed fields
                state.tasks = freshState.tasks
                // Keep session ID from child if it set one
                if (freshState.sessionId) {
                    state.sessionId = freshState.sessionId
                }
            }

            // Store session ID for future iterations (only if resume mode enabled)
            if (args.resume && sessionId && !state.sessionId) {
                state.sessionId = sessionId
                console.log(chalk.dim(`Session ID stored: ${sessionId.slice(0, 8)}...`))
            }

            const iterationEnd = new Date().toISOString()
            const markerFound = detectCompletionMarker(output, args.completionMarker)

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
            saveState(state, args.stateFile)

            // Log iteration summary
            const contextInfo = contextUsedPercent !== undefined ? ` | Context: ${contextUsedPercent}%` : ''
            const summaryMsg = `\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? 'yes' : 'no'}\n`
            console.log(chalk.dim(`\n━━━ Iteration ${state.iteration} Summary ━━━`))
            console.log(chalk.dim(`Duration: ${durationHuman}${contextInfo}`))
            console.log(chalk.dim(`Marker found: ${markerFound ? chalk.green('yes') : chalk.yellow('no')}`))
            logStream.write(summaryMsg)

            // Check completion
            if (markerFound) {
                state.status = 'completed'
                saveState(state, args.stateFile)
                const doneMsg = `\n✅ Task completed after ${state.iteration} iteration(s)\n`
                console.log(chalk.bold.green(doneMsg))
                logStream.write(doneMsg)
                logStream.end()
                process.exit(0)
            }
        }

        // Max iterations reached
        if (!interrupted) {
            state.status = 'max_iterations_reached'
            saveState(state, args.stateFile)
            const maxMsg = `\n⚠️  Max iterations (${maxIterations}) reached without completion\n`
            console.log(chalk.bold.yellow(maxMsg))
            console.log(chalk.dim(`State saved to: ${args.stateFile}`))
            logStream.write(maxMsg)
            logStream.end()
            process.exit(1)
        }
    },
})
