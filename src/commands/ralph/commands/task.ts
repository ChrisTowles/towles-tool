import 'zx/globals'
import { defineCommand } from 'citty'
import {
    DEFAULT_STATE_FILE,
    DEFAULT_MAX_ITERATIONS,
    loadState,
    saveState,
    createInitialState,
    addTaskToState,
} from '../state'
import { formatTasksAsMarkdown } from '../formatter'

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
// Task Add Command
// ============================================================================

export const taskAddCommand = defineCommand({
    meta: {
        name: 'add',
        description: 'Add a new task',
    },
    args: {
        ...sharedArgs,
        description: {
            type: 'positional' as const,
            description: 'Task description',
            required: true,
        },
        maxIterations: {
            type: 'string' as const,
            alias: 'm',
            default: String(DEFAULT_MAX_ITERATIONS),
            description: `Max iterations for new state (default: ${DEFAULT_MAX_ITERATIONS})`,
        },
    },
    run({ args }) {
        const description = String(args.description).trim()

        if (!description || description.length < 3) {
            console.error(chalk.red('Error: Task description too short (min 3 chars)'))
            process.exit(2)
        }

        let state = loadState(args.stateFile)

        if (!state) {
            const maxIterations = Number.parseInt(args.maxIterations, 10)
            state = createInitialState(maxIterations)
        }

        const newTask = addTaskToState(state, description)
        saveState(state, args.stateFile)

        console.log(chalk.green(`✓ Added task #${newTask.id}: ${newTask.description}`))
        console.log(chalk.dim(`State saved to: ${args.stateFile}`))
        console.log(chalk.dim(`Total tasks: ${state.tasks.length}`))
    },
})

// ============================================================================
// Task List Command
// ============================================================================

export const taskListCommand = defineCommand({
    meta: {
        name: 'list',
        description: 'List all tasks',
    },
    args: {
        ...sharedArgs,
        format: {
            type: 'string' as const,
            alias: 'f',
            default: 'default',
            description: 'Output format: default, markdown',
        },
    },
    run({ args }) {
        const state = loadState(args.stateFile)

        if (!state) {
            console.log(chalk.yellow(`No state file found at: ${args.stateFile}`))
            process.exit(0)
        }

        if (state.tasks.length === 0) {
            console.log(chalk.yellow('No tasks in state file.'))
            console.log(chalk.dim(`Use: tt ralph task add "description"`))
            process.exit(0)
        }

        if (args.format === 'markdown') {
            console.log(formatTasksAsMarkdown(state.tasks))
            return
        }

        // Default format output
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
    },
})

// ============================================================================
// Task Remove Command
// ============================================================================

export const taskRemoveCommand = defineCommand({
    meta: {
        name: 'remove',
        description: 'Remove a task by ID',
    },
    args: {
        ...sharedArgs,
        id: {
            type: 'positional' as const,
            description: 'Task ID to remove',
            required: true,
        },
    },
    run({ args }) {
        const taskId = Number.parseInt(String(args.id), 10)

        if (Number.isNaN(taskId) || taskId < 1) {
            console.error(chalk.red('Error: Invalid task ID'))
            process.exit(2)
        }

        const state = loadState(args.stateFile)

        if (!state) {
            console.error(chalk.red(`Error: No state file found at: ${args.stateFile}`))
            process.exit(2)
        }

        const taskIndex = state.tasks.findIndex(t => t.id === taskId)

        if (taskIndex === -1) {
            console.error(chalk.red(`Error: Task #${taskId} not found`))
            console.error(chalk.dim('Use: tt ralph task list'))
            process.exit(2)
        }

        const removedTask = state.tasks[taskIndex]
        state.tasks.splice(taskIndex, 1)
        saveState(state, args.stateFile)

        console.log(chalk.green(`✓ Removed task #${taskId}: ${removedTask.description}`))
        console.log(chalk.dim(`Remaining tasks: ${state.tasks.length}`))
    },
})

// ============================================================================
// Task Done Command
// ============================================================================

export const taskDoneCommand = defineCommand({
    meta: {
        name: 'done',
        description: 'Mark a task as done by ID',
    },
    args: {
        ...sharedArgs,
        id: {
            type: 'positional' as const,
            description: 'Task ID to mark done',
            required: true,
        },
    },
    run({ args }) {
        const taskId = Number.parseInt(String(args.id), 10)

        if (Number.isNaN(taskId) || taskId < 1) {
            console.error(chalk.red('Error: Invalid task ID'))
            process.exit(2)
        }

        const state = loadState(args.stateFile)

        if (!state) {
            console.error(chalk.red(`Error: No state file found at: ${args.stateFile}`))
            process.exit(2)
        }

        const task = state.tasks.find(t => t.id === taskId)

        if (!task) {
            console.error(chalk.red(`Error: Task #${taskId} not found`))
            console.error(chalk.dim('Use: tt ralph task list'))
            process.exit(2)
        }

        if (task.status === 'done') {
            console.log(chalk.yellow(`Task #${taskId} is already done.`))
            process.exit(0)
        }

        task.status = 'done'
        task.completedAt = new Date().toISOString()
        saveState(state, args.stateFile)

        console.log(chalk.green(`✓ Marked task #${taskId} as done: ${task.description}`))

        const remaining = state.tasks.filter(t => t.status !== 'done').length
        if (remaining === 0) {
            console.log(chalk.bold.green('🎉 All tasks complete!'))
        } else {
            console.log(chalk.dim(`Remaining tasks: ${remaining}`))
        }
    },
})

// ============================================================================
// Task Parent Command
// ============================================================================

export const taskCommand = defineCommand({
    meta: {
        name: 'task',
        description: 'Task management commands',
    },
    subCommands: {
        add: taskAddCommand,
        list: taskListCommand,
        remove: taskRemoveCommand,
        done: taskDoneCommand,
        ls: taskListCommand, // alias
        rm: taskRemoveCommand, // alias
    },
})
