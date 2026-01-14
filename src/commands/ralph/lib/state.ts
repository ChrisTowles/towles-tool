import * as fs from 'node:fs'
import * as path from 'node:path'
import pc from 'picocolors'
import { z } from 'zod'

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_ITERATIONS = 10
export const DEFAULT_STATE_FILE = './.claude/.ralph/ralph-state.local.json'
export const DEFAULT_LOG_FILE = './.claude/.ralph/ralph-log.local.md'
export const DEFAULT_PROGRESS_FILE = './.claude/.ralph/ralph-progress.local.md'
export const DEFAULT_HISTORY_FILE = './.claude/.ralph/ralph-history.local.log'
export const DEFAULT_COMPLETION_MARKER = 'RALPH_DONE'
export const CLAUDE_DEFAULT_ARGS = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']

// ============================================================================
// State Validation Schemas
// ============================================================================

const TaskStatusSchema = z.enum(['ready', 'done', 'blocked', 'cancelled'])

const RalphTaskSchema = z.object({
    id: z.number(),
    description: z.string(),
    status: TaskStatusSchema,
    addedAt: z.string(),
    completedAt: z.string().optional(),
    sessionId: z.string().optional(),
    marker: z.string().optional(),
    label: z.string().optional(),
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
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    const line = JSON.stringify(history) + '\n'
    fs.appendFileSync(historyFile, line)
}

export function saveState(state: RalphState, stateFile: string): void {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
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
            console.warn(pc.yellow(`Warning: Invalid state file ${stateFile}: ${errors}`))
            return null
        }
        return result.data
    }
    catch (err) {
        console.warn(pc.yellow(`Warning: Failed to load state file ${stateFile}: ${err}`))
        return null
    }
}

export function addTaskToState(state: RalphState, description: string, sessionId?: string, marker?: string, label?: string): RalphTask {
    const nextId = state.tasks.length > 0
        ? Math.max(...state.tasks.map(t => t.id)) + 1
        : 1

    const newTask: RalphTask = {
        id: nextId,
        description,
        status: 'ready',
        addedAt: new Date().toISOString(),
        ...(sessionId && { sessionId }),
        ...(marker && { marker }),
        ...(label && { label }),
    }

    state.tasks.push(newTask)
    return newTask
}
