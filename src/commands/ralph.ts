#!/usr/bin/env -S pnpx tsx

/**
 * Ralph Loop - Iterative Claude Code execution for autonomous task completion
 *
 * Runs claude CLI in a loop, with each iteration working on one task from
 * ralph-state.json until all tasks are complete or max iterations reached.
 *
 * Usage:
 *   ./scripts/ralph-loop.ts --addTask "implement feature X"
 *   ./scripts/ralph-loop.ts --addTask "write tests for feature X"
 *   ./scripts/ralph-loop.ts                    # run loop (ralph picks tasks)
 *   ./scripts/ralph-loop.ts --taskId 3         # focus on specific task
 *
 * See also: /tt:ralph-plan command for interactive task planning
 *
 * FUTURE IMPROVEMENTS:
 * - Investigate all tasks upfront in a "planning" iteration, save that
 *   conversation/session ID, then use --resume with that session ID for
 *   all subsequent task iterations. This would give ralph persistent context
 *   about the full task list and codebase understanding across iterations.
 * - Add --resume flag to continue from a previous session
 * - Parse claude output to auto-detect which task was completed
 */

import 'zx/globals'
import { defineCommand, runMain } from 'citty'

// Import types
import type {
    IterationHistory,
    TaskStatus,
    RalphTask,
    RalphState,
    RalphArgs,
    BuildPromptOptions,
    IterationResult,
} from './ralph/index'

// Import from modular structure
import {
    // Constants
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_STATE_FILE,
    DEFAULT_LOG_FILE,
    DEFAULT_PROGRESS_FILE,
    DEFAULT_HISTORY_FILE,
    DEFAULT_COMPLETION_MARKER,
    CLAUDE_DEFAULT_ARGS,

    // State functions
    ArgsSchema,
    validateArgs,
    createInitialState,
    appendHistory,
    saveState,
    loadState,
    addTaskToState,

    // Formatter functions
    copyToClipboard,
    formatTasksForPrompt,
    formatTasksAsMarkdown,
    formatPlanAsMarkdown,
    formatPlanAsJson,
    formatDuration,
    extractOutputSummary,
    buildIterationPrompt,
    detectCompletionMarker,

    // Execution functions
    checkClaudeCli,
    runIteration,

    // Commands
    taskCommand,
    runCommand,
    planCommand,
} from './ralph/index'

// Re-export types for backwards compatibility
export type {
    IterationHistory,
    TaskStatus,
    RalphTask,
    RalphState,
    RalphArgs,
    BuildPromptOptions,
    IterationResult,
}

// Re-export values for backwards compatibility
export {
    // Constants
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_STATE_FILE,
    DEFAULT_LOG_FILE,
    DEFAULT_PROGRESS_FILE,
    DEFAULT_HISTORY_FILE,
    DEFAULT_COMPLETION_MARKER,
    CLAUDE_DEFAULT_ARGS,

    // State functions
    ArgsSchema,
    validateArgs,
    createInitialState,
    appendHistory,
    saveState,
    loadState,
    addTaskToState,

    // Formatter functions
    copyToClipboard,
    formatTasksForPrompt,
    formatTasksAsMarkdown,
    formatPlanAsMarkdown,
    formatPlanAsJson,
    formatDuration,
    extractOutputSummary,
    buildIterationPrompt,
    detectCompletionMarker,

    // Execution functions
    checkClaudeCli,
    runIteration,
}

// ============================================================================
// Main Command (with subcommands and legacy flag support)
// ============================================================================

const main = defineCommand({
    meta: {
        name: 'ralph',
        version: '2.0.0',
        description: 'Autonomous Claude Code runner for task execution',
    },
    args: {
        // Legacy flags for backwards compatibility
        run: {
            type: 'boolean' as const,
            alias: 'r',
            default: false,
            description: '[Legacy] Use "tt ralph run" instead',
        },
        addTask: {
            type: 'string' as const,
            alias: 'a',
            description: '[Legacy] Use "tt ralph task add" instead',
        },
        markDone: {
            type: 'string' as const,
            alias: 'd',
            description: '[Legacy] Use "tt ralph task done" instead',
        },
        removeTask: {
            type: 'string' as const,
            alias: 'rm',
            description: '[Legacy] Use "tt ralph task remove" instead',
        },
        listTasks: {
            type: 'boolean' as const,
            alias: 'l',
            default: false,
            description: '[Legacy] Use "tt ralph task list" instead',
        },
        showPlan: {
            type: 'boolean' as const,
            alias: 'p',
            default: false,
            description: '[Legacy] Use "tt ralph plan" instead',
        },
        // Legacy run options
        taskId: {
            type: 'string' as const,
            alias: 't',
            description: '[Legacy] Use "tt ralph run --taskId" instead',
        },
        maxIterations: {
            type: 'string' as const,
            alias: 'm',
            default: String(DEFAULT_MAX_ITERATIONS),
            description: '[Legacy] Use "tt ralph run --maxIterations" instead',
        },
        autoCommit: {
            type: 'boolean' as const,
            default: true,
            description: '[Legacy] Use "tt ralph run --autoCommit" instead',
        },
        resume: {
            type: 'boolean' as const,
            default: false,
            description: '[Legacy] Use "tt ralph run --resume" instead',
        },
        dryRun: {
            type: 'boolean' as const,
            alias: 'n',
            default: false,
            description: '[Legacy] Use "tt ralph run --dryRun" instead',
        },
        claudeArgs: {
            type: 'string' as const,
            description: '[Legacy] Use "tt ralph run --claudeArgs" instead',
        },
        format: {
            type: 'string' as const,
            alias: 'f',
            default: 'default',
            description: '[Legacy] Use "tt ralph plan --format" instead',
        },
        copy: {
            type: 'boolean' as const,
            default: false,
            description: '[Legacy] Use "tt ralph plan --copy" instead',
        },
        stateFile: {
            type: 'string' as const,
            default: DEFAULT_STATE_FILE,
            description: `State file path (default: ${DEFAULT_STATE_FILE})`,
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
    subCommands: {
        task: taskCommand,
        run: runCommand,
        plan: planCommand,
    },
    async run({ args }) {
        const validatedArgs = validateArgs(args)
        const maxIterations = Number.parseInt(validatedArgs.maxIterations, 10)
        const extraClaudeArgs = validatedArgs.claudeArgs?.split(' ').filter(Boolean) || []

        // Handle legacy --addTask flag
        if (validatedArgs.addTask !== undefined) {
            const description = String(validatedArgs.addTask).trim()

            if (!description || description.length < 3) {
                console.error(chalk.red('Error: Task description too short (min 3 chars)'))
                process.exit(2)
            }

            let state = loadState(validatedArgs.stateFile)

            if (!state) {
                state = createInitialState(maxIterations)
            }

            const newTask = addTaskToState(state, description)
            saveState(state, validatedArgs.stateFile)

            console.log(chalk.green(`✓ Added task #${newTask.id}: ${newTask.description}`))
            console.log(chalk.dim(`State saved to: ${validatedArgs.stateFile}`))
            console.log(chalk.dim(`Total tasks: ${state.tasks.length}`))
            console.log(chalk.yellow('\nNote: Use "tt ralph task add" instead of --addTask'))
            process.exit(0)
        }

        // Handle legacy --markDone flag
        if (validatedArgs.markDone !== undefined) {
            const taskId = Number.parseInt(String(validatedArgs.markDone), 10)

            if (Number.isNaN(taskId) || taskId < 1) {
                console.error(chalk.red('Error: Invalid task ID'))
                process.exit(2)
            }

            const state = loadState(validatedArgs.stateFile)

            if (!state) {
                console.error(chalk.red(`Error: No state file found at: ${validatedArgs.stateFile}`))
                process.exit(2)
            }

            const task = state.tasks.find(t => t.id === taskId)

            if (!task) {
                console.error(chalk.red(`Error: Task #${taskId} not found`))
                process.exit(2)
            }

            if (task.status === 'done') {
                console.log(chalk.yellow(`Task #${taskId} is already done.`))
                process.exit(0)
            }

            task.status = 'done'
            task.completedAt = new Date().toISOString()
            saveState(state, validatedArgs.stateFile)

            console.log(chalk.green(`✓ Marked task #${taskId} as done: ${task.description}`))

            const remaining = state.tasks.filter(t => t.status !== 'done').length
            if (remaining === 0) {
                console.log(chalk.bold.green('🎉 All tasks complete!'))
            } else {
                console.log(chalk.dim(`Remaining tasks: ${remaining}`))
            }
            console.log(chalk.yellow('\nNote: Use "tt ralph task done" instead of --markDone'))
            process.exit(0)
        }

        // Handle legacy --removeTask flag
        if (validatedArgs.removeTask !== undefined) {
            const taskId = Number.parseInt(String(validatedArgs.removeTask), 10)

            if (Number.isNaN(taskId) || taskId < 1) {
                console.error(chalk.red('Error: Invalid task ID'))
                process.exit(2)
            }

            const state = loadState(validatedArgs.stateFile)

            if (!state) {
                console.error(chalk.red(`Error: No state file found at: ${validatedArgs.stateFile}`))
                process.exit(2)
            }

            const taskIndex = state.tasks.findIndex(t => t.id === taskId)

            if (taskIndex === -1) {
                console.error(chalk.red(`Error: Task #${taskId} not found`))
                process.exit(2)
            }

            const removedTask = state.tasks[taskIndex]
            state.tasks.splice(taskIndex, 1)
            saveState(state, validatedArgs.stateFile)

            console.log(chalk.green(`✓ Removed task #${taskId}: ${removedTask.description}`))
            console.log(chalk.dim(`Remaining tasks: ${state.tasks.length}`))
            console.log(chalk.yellow('\nNote: Use "tt ralph task remove" instead of --removeTask'))
            process.exit(0)
        }

        // Handle legacy --listTasks flag
        if (validatedArgs.listTasks) {
            const state = loadState(validatedArgs.stateFile)

            if (!state) {
                console.log(chalk.yellow(`No state file found at: ${validatedArgs.stateFile}`))
                process.exit(0)
            }

            if (state.tasks.length === 0) {
                console.log(chalk.yellow('No tasks in state file.'))
                process.exit(0)
            }

            if (validatedArgs.format === 'markdown') {
                console.log(formatTasksAsMarkdown(state.tasks))
            } else {
                console.log(chalk.bold('\nTasks:\n'))
                for (const task of state.tasks) {
                    const statusColor = task.status === 'done' ? chalk.green
                        : task.status === 'in_progress' ? chalk.yellow
                        : chalk.dim
                    const icon = task.status === 'done' ? '✓'
                        : task.status === 'in_progress' ? '→'
                        : '○'
                    console.log(statusColor(`  ${icon} ${task.id}. ${task.description} (${task.status})`))
                }
                console.log()
            }
            console.log(chalk.yellow('Note: Use "tt ralph task list" instead of --listTasks'))
            process.exit(0)
        }

        // Handle legacy --showPlan flag
        if (validatedArgs.showPlan) {
            const state = loadState(validatedArgs.stateFile)

            if (!state) {
                console.log(chalk.yellow(`No state file found at: ${validatedArgs.stateFile}`))
                process.exit(0)
            }

            if (state.tasks.length === 0) {
                console.log(chalk.yellow('No tasks in state file.'))
                process.exit(0)
            }

            let output: string

            if (validatedArgs.format === 'json') {
                output = formatPlanAsJson(state.tasks, state)
            } else {
                output = formatPlanAsMarkdown(state.tasks, state)
            }

            console.log(output)

            if (validatedArgs.copy) {
                if (copyToClipboard(output)) {
                    console.log(chalk.green('✓ Copied to clipboard'))
                } else {
                    console.log(chalk.yellow('⚠ Could not copy to clipboard'))
                }
            }
            console.log(chalk.yellow('\nNote: Use "tt ralph plan" instead of --showPlan'))
            process.exit(0)
        }

        // Handle legacy --run flag
        if (validatedArgs.run || validatedArgs.dryRun) {
            const focusedTaskId = validatedArgs.taskId ? Number.parseInt(validatedArgs.taskId, 10) : null

            let state = loadState(validatedArgs.stateFile)

            if (!state) {
                console.error(chalk.red(`Error: No state file found at: ${validatedArgs.stateFile}`))
                process.exit(2)
            }

            const pendingTasks = state.tasks.filter(t => t.status !== 'done')
            if (pendingTasks.length === 0) {
                console.log(chalk.green('✅ All tasks are done!'))
                process.exit(0)
            }

            if (focusedTaskId !== null) {
                const focusedTask = state.tasks.find(t => t.id === focusedTaskId)
                if (!focusedTask) {
                    console.error(chalk.red(`Error: Task #${focusedTaskId} not found`))
                    process.exit(2)
                }
                if (focusedTask.status === 'done') {
                    console.log(chalk.yellow(`Task #${focusedTaskId} is already done.`))
                    process.exit(0)
                }
            }

            if (validatedArgs.dryRun) {
                console.log(chalk.bold('\n=== DRY RUN ===\n'))
                console.log(chalk.cyan('Config:'))
                console.log(`  Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`)
                console.log(`  Max iterations: ${maxIterations}`)
                console.log(`  State file: ${validatedArgs.stateFile}`)
                console.log(`  Log file: ${validatedArgs.logFile}`)
                console.log(`  Completion marker: ${validatedArgs.completionMarker}`)
                console.log(`  Auto-commit: ${validatedArgs.autoCommit}`)
                console.log(`  Resume mode: ${validatedArgs.resume}`)
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
                console.log(chalk.yellow('Note: Use "tt ralph run --dryRun" instead of --dryRun'))
                process.exit(0)
            }

            if (!await checkClaudeCli()) {
                console.error(chalk.red('Error: claude CLI not found in PATH'))
                console.error(chalk.yellow('Install Claude Code: https://docs.anthropic.com/en/docs/claude-code'))
                process.exit(2)
            }

            state.maxIterations = maxIterations
            state.status = 'running'

            const logStream = fs.createWriteStream(validatedArgs.logFile, { flags: 'a' })

            const pending = state.tasks.filter(t => t.status === 'pending').length
            const done = state.tasks.filter(t => t.status === 'done').length

            logStream.write(`\n${'='.repeat(60)}\n`)
            logStream.write(`Ralph Loop Started: ${new Date().toISOString()}\n`)
            logStream.write(`${'='.repeat(60)}\n\n`)

            console.log(chalk.bold.blue('\n🔄 Ralph Loop Starting\n'))
            console.log(chalk.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}`))
            console.log(chalk.dim(`Max iterations: ${maxIterations}`))
            console.log(chalk.dim(`Log file: ${validatedArgs.logFile}`))
            console.log(chalk.dim(`Auto-commit: ${validatedArgs.autoCommit}`))
            console.log(chalk.dim(`Resume mode: ${validatedArgs.resume}${state.sessionId ? ` (session: ${state.sessionId.slice(0, 8)}...)` : ''}`))
            console.log(chalk.dim(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)`))
            console.log(chalk.yellow('Note: Use "tt ralph run" instead of --run'))
            console.log()

            logStream.write(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : 'Ralph picks'}\n`)
            logStream.write(`Max iterations: ${maxIterations}\n`)
            logStream.write(`Tasks: ${state.tasks.length} (${done} done, ${pending} pending)\n\n`)

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
                saveState(state, validatedArgs.stateFile)
            })

            while (state.iteration < maxIterations && !interrupted) {
                state.iteration++

                const iterHeader = `\n━━━ Iteration ${state.iteration}/${maxIterations} ━━━\n`
                console.log(chalk.bold.cyan(iterHeader))
                logStream.write(iterHeader)

                const iterationStart = new Date().toISOString()
                const prompt = buildIterationPrompt({
                    completionMarker: validatedArgs.completionMarker,
                    stateFile: validatedArgs.stateFile,
                    progressFile: DEFAULT_PROGRESS_FILE,
                    focusedTaskId,
                    skipCommit: !validatedArgs.autoCommit,
                })

                logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`)

                const iterClaudeArgs = [...extraClaudeArgs]
                if (validatedArgs.resume && state.sessionId) {
                    iterClaudeArgs.push('--resume', state.sessionId)
                }

                const { output, contextUsedPercent, sessionId } = await runIteration(prompt, iterClaudeArgs, logStream)

                // Reload state from disk to pick up changes made by child claude process
                // (e.g., `tt ralph task done <id>` marks tasks complete)
                const freshState = loadState(validatedArgs.stateFile)
                if (freshState) {
                    // Adopt child's task changes, keep parent-managed fields
                    state.tasks = freshState.tasks
                    // Keep session ID from child if it set one
                    if (freshState.sessionId) {
                        state.sessionId = freshState.sessionId
                    }
                }

                // Store session ID for future iterations (only if resume mode enabled)
                if (validatedArgs.resume && sessionId && !state.sessionId) {
                    state.sessionId = sessionId
                    console.log(chalk.dim(`Session ID stored: ${sessionId.slice(0, 8)}...`))
                }

                const iterationEnd = new Date().toISOString()
                const markerFound = detectCompletionMarker(output, validatedArgs.completionMarker)

                const startTime = new Date(iterationStart).getTime()
                const endTime = new Date(iterationEnd).getTime()
                const durationMs = endTime - startTime
                const durationHuman = formatDuration(durationMs)

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

                saveState(state, validatedArgs.stateFile)

                const contextInfo = contextUsedPercent !== undefined ? ` | Context: ${contextUsedPercent}%` : ''
                const summaryMsg = `\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? 'yes' : 'no'}\n`
                console.log(chalk.dim(`\n━━━ Iteration ${state.iteration} Summary ━━━`))
                console.log(chalk.dim(`Duration: ${durationHuman}${contextInfo}`))
                console.log(chalk.dim(`Marker found: ${markerFound ? chalk.green('yes') : chalk.yellow('no')}`))
                logStream.write(summaryMsg)

                if (markerFound) {
                    state.status = 'completed'
                    saveState(state, validatedArgs.stateFile)
                    const doneMsg = `\n✅ Task completed after ${state.iteration} iteration(s)\n`
                    console.log(chalk.bold.green(doneMsg))
                    logStream.write(doneMsg)
                    logStream.end()
                    process.exit(0)
                }
            }

            if (!interrupted) {
                state.status = 'max_iterations_reached'
                saveState(state, validatedArgs.stateFile)
                const maxMsg = `\n⚠️  Max iterations (${maxIterations}) reached without completion\n`
                console.log(chalk.bold.yellow(maxMsg))
                console.log(chalk.dim(`State saved to: ${validatedArgs.stateFile}`))
                logStream.write(maxMsg)
                logStream.end()
                process.exit(1)
            }
            return
        }

        // No subcommand or legacy flag - show help
        console.log(chalk.bold('Ralph - Autonomous Claude Code Runner\n'))
        console.log('Commands:')
        console.log('  tt ralph task add "..."     Add a task')
        console.log('  tt ralph task list          List all tasks')
        console.log('  tt ralph task done <id>     Mark a task as done')
        console.log('  tt ralph task remove <id>   Remove a task')
        console.log('  tt ralph run                Start the autonomous loop')
        console.log('  tt ralph run --resume       Start with session continuity')
        console.log('  tt ralph plan               Show plan summary with graph')
        console.log()
        console.log(chalk.dim('Use "tt ralph <command> --help" for command options.'))
    },
})

// Only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    runMain(main)
}

/**
 * Entry point for calling ralph from the CLI
 */
export async function ralphCommand(rawArgs: string[]): Promise<void> {
    // Construct argv for citty: [node, script, ...args]
    const argv = ['node', 'ralph', ...rawArgs]
    const originalArgv = process.argv
    process.argv = argv
    try {
        await runMain(main)
    } finally {
        process.argv = originalArgv
    }
}

export { main }
