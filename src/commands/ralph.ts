#!/usr/bin/env -S pnpx tsx

/**
 * Ralph - Autonomous Claude Code runner for task execution
 *
 * Runs claude CLI in a loop, working on tasks from ralph-state.json
 * until all tasks are complete or max iterations reached.
 *
 * Usage:
 *   tt ralph task add "implement feature X"   # Add a task
 *   tt ralph task list                        # View tasks
 *   tt ralph run                              # Start autonomous loop
 *   tt ralph run --taskId 3                   # Focus on specific task
 *   tt ralph plan                             # Show plan with graph
 *
 * See also: /tt:plan command for interactive task planning
 */

import pc from 'picocolors'
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
// Main Command
// ============================================================================

const main = defineCommand({
    meta: {
        name: 'ralph',
        version: '2.0.0',
        description: 'Autonomous Claude Code runner for task execution',
    },
    subCommands: {
        task: taskCommand,
        run: runCommand,
        plan: planCommand,
    },
    run() {
        // No subcommand specified - show help
        console.log(pc.bold('Ralph - Autonomous Claude Code Runner\n'))
        console.log('Commands:')
        console.log('  tt ralph task add "..."     Add a task')
        console.log('  tt ralph task list          List all tasks')
        console.log('  tt ralph task done <id>     Mark a task as done')
        console.log('  tt ralph task remove <id>   Remove a task')
        console.log('  tt ralph run                Start the autonomous loop')
        console.log('  tt ralph run --resume       Start with session continuity')
        console.log('  tt ralph plan               Show plan summary with graph')
        console.log()
        console.log(pc.dim('Use "tt ralph <command> --help" for command options.'))
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
