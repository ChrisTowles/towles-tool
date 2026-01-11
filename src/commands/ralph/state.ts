import * as fs from 'node:fs'
import chalk from 'chalk'
import { z } from 'zod'

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_ITERATIONS = 10
export const DEFAULT_STATE_FILE = 'ralph-state.json'
export const DEFAULT_LOG_FILE = 'ralph-log.md'
export const DEFAULT_PROGRESS_FILE = 'ralph-progress.md'
export const DEFAULT_HISTORY_FILE = 'ralph-history.log'
export const DEFAULT_COMPLETION_MARKER = 'RALPH_DONE'
export const CLAUDE_DEFAULT_ARGS = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']

// ============================================================================
// State Validation Schemas
// ============================================================================

const TaskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'hold'])

const RalphTaskSchema = z.object({
    id: z.number(),
    description: z.string(),
    status: TaskStatusSchema,
    addedAt: z.string(),
    completedAt: z.string().optional(),
})

const RalphStateSchema = z.object({
    version: z.number(),
    tasks: z.array(RalphTaskSchema),
    startedAt: z.string(),
    iteration: z.number(),
    maxIterations: z.number(),
    status: z.enum(['running', 'completed', 'max_iterations_reached', 'error']),
    sessionId: z.string().optional(),
})

// ============================================================================
// Types (derived from Zod schemas)
// ============================================================================

export interface IterationHistory {
    iteration: number
    startedAt: string
    completedAt: string
    durationMs: number
    durationHuman: string
    outputSummary: string
    markerFound: boolean
    contextUsedPercent?: number
}

export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type RalphTask = z.infer<typeof RalphTaskSchema>
export type RalphState = z.infer<typeof RalphStateSchema>

// ============================================================================
// Arg Validation Schema
// ============================================================================

export const ArgsSchema = z.object({
    run: z.boolean().default(false),
    taskId: z.string().optional()
        .refine((val: string | undefined) => !val || /^\d+$/.test(val), 'taskId must be a positive integer'),
    addTask: z.string().optional()
        .refine((val: string | undefined) => !val || val.trim().length >= 3, 'Task description must be at least 3 characters'),
    markDone: z.string().optional()
        .refine((val: string | undefined) => !val || /^\d+$/.test(val), 'markDone must be a positive integer (task ID)'),
    removeTask: z.string().optional()
        .refine((val: string | undefined) => !val || /^\d+$/.test(val), 'removeTask must be a positive integer (task ID)'),
    listTasks: z.boolean().default(false),
    showPlan: z.boolean().default(false),
    format: z.enum(['default', 'markdown', 'json']).default('default'),
    copy: z.boolean().default(false),
    clear: z.boolean().default(false),
    autoCommit: z.boolean().default(true),
    resume: z.boolean().default(false),
    maxIterations: z.string().default(String(DEFAULT_MAX_ITERATIONS))
        .refine((val: string) => /^\d+$/.test(val) && Number.parseInt(val, 10) > 0, 'maxIterations must be a positive integer'),
    dryRun: z.boolean().default(false),
    claudeArgs: z.string().optional(),
    stateFile: z.string().default(DEFAULT_STATE_FILE)
        .refine((val: string) => val.endsWith('.json'), 'stateFile must be a .json file'),
    logFile: z.string().default(DEFAULT_LOG_FILE),
    completionMarker: z.string().default(DEFAULT_COMPLETION_MARKER)
        .refine((val: string) => val.length >= 3, 'completionMarker must be at least 3 characters'),
}).strict()

// citty internal keys to filter out before validation
const CITTY_INTERNAL_KEYS = ['_', 'r', 't', 'a', 'l', 'c', 'm', 'n', 'd', 'rm', 'f', 's', 'p']

export function validateArgs(args: unknown): RalphArgs {
    // Filter out citty internal keys (aliases and positionals)
    const filtered = Object.fromEntries(
        Object.entries(args as Record<string, unknown>)
            .filter(([k]) => !CITTY_INTERNAL_KEYS.includes(k))
    )
    const result = ArgsSchema.safeParse(filtered)
    if (!result.success) {
        const errors = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
        console.error(chalk.red('Invalid arguments:\n' + errors))
        process.exit(2)
    }
    return result.data
}

export type RalphArgs = z.infer<typeof ArgsSchema>

// ============================================================================
// State Management
// ============================================================================

export function createInitialState(maxIterations: number): RalphState {
    return {
        version: 1,
        tasks: [],
        startedAt: new Date().toISOString(),
        iteration: 0,
        maxIterations,
        status: 'running',
    }
}

/**
 * Append iteration history as a JSON line to the history log file.
 * Each line is a complete JSON object for easy parsing.
 */
export function appendHistory(history: IterationHistory, historyFile: string = DEFAULT_HISTORY_FILE): void {
    const line = JSON.stringify(history) + '\n'
    fs.appendFileSync(historyFile, line)
}

export function saveState(state: RalphState, stateFile: string): void {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

export function loadState(stateFile: string): RalphState | null {
    try {
        if (!fs.existsSync(stateFile)) {
            return null
        }
        const content = fs.readFileSync(stateFile, 'utf-8')
        const parsed = JSON.parse(content)

        // Ensure tasks array exists for backwards compatibility
        if (!parsed.tasks) {
            parsed.tasks = []
        }

        const result = RalphStateSchema.safeParse(parsed)
        if (!result.success) {
            const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
            console.warn(chalk.yellow(`Warning: Invalid state file ${stateFile}: ${errors}`))
            return null
        }
        return result.data
    }
    catch (err) {
        console.warn(chalk.yellow(`Warning: Failed to load state file ${stateFile}: ${err}`))
        return null
    }
}

export function addTaskToState(state: RalphState, description: string): RalphTask {
    const nextId = state.tasks.length > 0
        ? Math.max(...state.tasks.map(t => t.id)) + 1
        : 1

    const newTask: RalphTask = {
        id: nextId,
        description,
        status: 'pending',
        addedAt: new Date().toISOString(),
    }

    state.tasks.push(newTask)
    return newTask
}
