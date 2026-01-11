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
import type { WriteStream } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { defineCommand, runMain } from 'citty'
import { z } from 'zod'

// ============================================================================
// Clipboard Utility
// ============================================================================

function copyToClipboard(text: string): boolean {
    try {
        const platform = process.platform
        if (platform === 'darwin') {
            execFileSync('pbcopy', [], { input: text })
        } else if (platform === 'linux') {
            // Try xclip first, then xsel
            try {
                execFileSync('xclip', ['-selection', 'clipboard'], { input: text })
            } catch {
                execFileSync('xsel', ['--clipboard', '--input'], { input: text })
            }
        } else if (platform === 'win32') {
            execFileSync('clip', [], { input: text })
        } else {
            return false
        }
        return true
    } catch {
        return false
    }
}

// ============================================================================
// Types
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

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface RalphTask {
    id: number
    description: string
    status: TaskStatus
    addedAt: string
    completedAt?: string
}

export interface RalphState {
    version: number
    tasks: RalphTask[]
    startedAt: string
    iteration: number
    maxIterations: number
    status: 'running' | 'completed' | 'max_iterations_reached' | 'error'
    sessionId?: string // Claude session ID for --resume continuity
    // history removed in v2 - now stored as JSON lines in ralph-history.log
}

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
    autoCommit: z.boolean().default(false),
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
        if (fs.existsSync(stateFile)) {
            const content = fs.readFileSync(stateFile, 'utf-8')
            const state = JSON.parse(content) as RalphState
            // Ensure tasks array exists for backwards compatibility
            if (!state.tasks) {
                state.tasks = []
            }
            return state
        }
    }
    catch {
        return null
    }
    return null
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

export function formatTasksForPrompt(tasks: RalphTask[]): string {
    if (tasks.length === 0) {
        return ''
    }

    const statusIcon = (status: TaskStatus): string => {
        switch (status) {
            case 'done': return '✓'
            case 'in_progress': return '→'
            case 'pending': return '○'
        }
    }

    const lines = tasks.map(t =>
        `[${statusIcon(t.status)}] ${t.id}. ${t.description} (${t.status})`
    )

    return `## Sub-Tasks
Track progress on these sub-tasks. Mark them as done when completed.

${lines.join('\n')}`
}

/**
 * Format tasks as markdown with checkboxes and status badges.
 */
export function formatTasksAsMarkdown(tasks: RalphTask[]): string {
    if (tasks.length === 0) {
        return '# Tasks\n\nNo tasks.\n'
    }

    const statusBadge = (status: TaskStatus): string => {
        switch (status) {
            case 'done': return '`✓ done`'
            case 'in_progress': return '`→ in_progress`'
            case 'pending': return '`○ pending`'
        }
    }

    const pending = tasks.filter(t => t.status === 'pending')
    const inProgress = tasks.filter(t => t.status === 'in_progress')
    const done = tasks.filter(t => t.status === 'done')

    const lines: string[] = ['# Tasks', '']
    lines.push(`**Total:** ${tasks.length} | **Done:** ${done.length} | **Pending:** ${pending.length + inProgress.length}`, '')

    if (inProgress.length > 0) {
        lines.push('## In Progress', '')
        for (const t of inProgress) {
            lines.push(`- [ ] **#${t.id}** ${t.description} ${statusBadge(t.status)}`)
        }
        lines.push('')
    }

    if (pending.length > 0) {
        lines.push('## Pending', '')
        for (const t of pending) {
            lines.push(`- [ ] **#${t.id}** ${t.description} ${statusBadge(t.status)}`)
        }
        lines.push('')
    }

    if (done.length > 0) {
        lines.push('## Done', '')
        for (const t of done) {
            lines.push(`- [x] **#${t.id}** ${t.description} ${statusBadge(t.status)}`)
        }
        lines.push('')
    }

    return lines.join('\n')
}

/**
 * Format tasks as a plan with markdown and optional mermaid graph.
 */
export function formatPlanAsMarkdown(tasks: RalphTask[], state: RalphState): string {
    const lines: string[] = ['# Ralph Plan', '']

    // Summary section
    const pending = tasks.filter(t => t.status === 'pending').length
    const inProgress = tasks.filter(t => t.status === 'in_progress').length
    const done = tasks.filter(t => t.status === 'done').length

    lines.push('## Summary', '')
    lines.push(`- **Status:** ${state.status}`)
    lines.push(`- **Iteration:** ${state.iteration}/${state.maxIterations}`)
    lines.push(`- **Total Tasks:** ${tasks.length}`)
    lines.push(`- **Done:** ${done} | **In Progress:** ${inProgress} | **Pending:** ${pending}`)
    if (state.sessionId) {
        lines.push(`- **Session ID:** ${state.sessionId.slice(0, 8)}...`)
    }
    lines.push('')

    // Tasks section with checkboxes
    lines.push('## Tasks', '')
    for (const t of tasks) {
        const checkbox = t.status === 'done' ? '[x]' : '[ ]'
        const status = t.status === 'done' ? '`done`' : t.status === 'in_progress' ? '`in_progress`' : '`pending`'
        lines.push(`- ${checkbox} **#${t.id}** ${t.description} ${status}`)
    }
    lines.push('')

    // Mermaid graph section
    lines.push('## Progress Graph', '')
    lines.push('```mermaid')
    lines.push('graph LR')
    lines.push(`    subgraph Progress["Tasks: ${done}/${tasks.length} done"]`)

    for (const t of tasks) {
        const shortDesc = t.description.length > 30 ? t.description.slice(0, 27) + '...' : t.description
        // Escape quotes in descriptions
        const safeDesc = shortDesc.replace(/"/g, "'")
        const nodeId = `T${t.id}`

        if (t.status === 'done') {
            lines.push(`        ${nodeId}["#${t.id}: ${safeDesc}"]:::done`)
        } else if (t.status === 'in_progress') {
            lines.push(`        ${nodeId}["#${t.id}: ${safeDesc}"]:::inProgress`)
        } else {
            lines.push(`        ${nodeId}["#${t.id}: ${safeDesc}"]:::pending`)
        }
    }

    lines.push('    end')
    lines.push('    classDef done fill:#22c55e,color:#fff')
    lines.push('    classDef inProgress fill:#eab308,color:#000')
    lines.push('    classDef pending fill:#94a3b8,color:#000')
    lines.push('```')
    lines.push('')

    return lines.join('\n')
}

/**
 * Format tasks as JSON for programmatic consumption.
 */
export function formatPlanAsJson(tasks: RalphTask[], state: RalphState): string {
    return JSON.stringify({
        status: state.status,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        sessionId: state.sessionId,
        summary: {
            total: tasks.length,
            done: tasks.filter(t => t.status === 'done').length,
            inProgress: tasks.filter(t => t.status === 'in_progress').length,
            pending: tasks.filter(t => t.status === 'pending').length,
        },
        tasks: tasks.map(t => ({
            id: t.id,
            description: t.description,
            status: t.status,
            addedAt: t.addedAt,
            completedAt: t.completedAt,
        })),
    }, null, 2)
}

// ============================================================================
// Prompt Building
// ============================================================================

export interface BuildPromptOptions {
    completionMarker: string
    stateFile: string
    progressFile: string
    focusedTaskId: number | null
    skipCommit?: boolean
}

export function buildIterationPrompt({ completionMarker, stateFile, progressFile, focusedTaskId, skipCommit = false }: BuildPromptOptions): string {
    // prompt inspired by https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum#2-start-with-hitl-then-go-afk

    let step = 1

    return `
Review the state and progress files. 

state_file: @${stateFile}
progress_file: @${progressFile}

Then:



${step++}. ${focusedTaskId
        ? `**Work on Task #${focusedTaskId}** (you've been asked to focus on this one).`
        : `**Choose** which pending task to work on next based on YOUR judgment of priority/dependencies.`}
${step++}. Work on that single task.
${step++}. Run type checks and tests.
${step++}. Mark the task done using CLI: \`tt ralph task done <id>\`
${step++}. Update @${progressFile} with what you did.
${skipCommit ? '' : `${step++}. Make a git commit.`}

**ONE TASK PER ITERATION**

When ALL tasks are done, Output: <promise>${completionMarker}</promise>
`
}



// ============================================================================
// Duration Formatting
// ============================================================================

export function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (hours > 0) {
        const remainingMins = minutes % 60
        return `${hours}h ${remainingMins}m`
    }
    if (minutes > 0) {
        const remainingSecs = seconds % 60
        return `${minutes}m ${remainingSecs}s`
    }
    return `${seconds}s`
}

// ============================================================================
// Output Summary
// ============================================================================

export function extractOutputSummary(output: string, maxLength: number = 2000): string {
    const lines = output.split('\n').filter(l => l.trim()).slice(-5)
    let summary = lines.join(' ').trim()

    if (summary.length > maxLength) {
        summary = summary.substring(0, maxLength) + '...'
    }

    return summary || '(no output)'
}

// ============================================================================
// Marker Detection
// ============================================================================

export function detectCompletionMarker(output: string, marker: string): boolean {
    return output.includes(marker)
}

// ============================================================================
// Execution
// ============================================================================

export async function checkClaudeCli(): Promise<boolean> {
    try {
        await $`which claude`.quiet()
        return true
    }
    catch {
        return false
    }
}

interface StreamEvent {
    type: string
    event?: {
        type: string
        delta?: { text?: string }
    }
    // New format: assistant message
    message?: {
        content?: Array<{ type: string; text?: string }>
        usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
        }
    }
    result?: string
    total_cost_usd?: number
    num_turns?: number
    session_id?: string
    usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
}

// Claude model context windows (tokens)
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    'claude-sonnet-4-20250514': 200000,
    'claude-opus-4-20250514': 200000,
    'claude-3-5-sonnet-20241022': 200000,
    'claude-3-opus-20240229': 200000,
    'default': 200000,
}

export interface IterationResult {
    output: string
    exitCode: number
    contextUsedPercent?: number
    sessionId?: string
}

interface ParsedLine {
    text: string | null
    usage?: StreamEvent['usage']
    sessionId?: string
}

function parseStreamLine(line: string): ParsedLine {
    if (!line.trim()) return { text: null }
    try {
        const data = JSON.parse(line) as StreamEvent
        // Extract text from streaming deltas (legacy format)
        if (data.type === 'stream_event' && data.event?.type === 'content_block_delta') {
            return { text: data.event.delta?.text || null }
        }
        // Add newline after content block ends (legacy format)
        if (data.type === 'stream_event' && data.event?.type === 'content_block_stop') {
            return { text: '\n' }
        }
        // NEW FORMAT: Handle assistant messages with content array
        if (data.type === 'assistant' && data.message) {
            // Extract text from content blocks
            const texts = data.message.content
                ?.filter(c => c.type === 'text' && c.text)
                .map(c => c.text)
                .join('') || null
            return { text: texts, usage: data.message.usage || data.usage, sessionId: data.session_id }
        }
        // Capture final result with usage and session_id
        if (data.type === 'result') {
            const resultText = data.result
                ? `\n[Result: ${data.result.substring(0, 100)}${data.result.length > 100 ? '...' : ''}]\n`
                : null
            return { text: resultText, usage: data.usage, sessionId: data.session_id }
        }
    } catch {
        // Not JSON, return raw
        return { text: line }
    }
    return { text: null }
}

export async function runIteration(
    prompt: string,
    claudeArgs: string[],
    logStream?: WriteStream,
): Promise<IterationResult> {
    const allArgs = [...CLAUDE_DEFAULT_ARGS, ...claudeArgs, prompt]

    let output = ''
    let lineBuffer = ''
    let finalUsage: StreamEvent['usage'] | undefined
    let sessionId: string | undefined

    return new Promise((resolve) => {
        const proc = spawn('claude', allArgs, {
            stdio: ['inherit', 'pipe', 'pipe'],
        })

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            lineBuffer += text

            // Process complete lines
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() || '' // Keep incomplete line in buffer

            for (const line of lines) {
                const { text: parsed, usage, sessionId: sid } = parseStreamLine(line)
                if (usage) finalUsage = usage
                if (sid) sessionId = sid
                if (parsed) {
                    process.stdout.write(parsed)
                    logStream?.write(parsed)
                    output += parsed
                }
            }
        })

        proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            process.stderr.write(text)
            logStream?.write(text)
            output += text
        })

        proc.on('close', (code: number | null) => {
            // Process any remaining buffer
            if (lineBuffer) {
                const { text: parsed, usage, sessionId: sid } = parseStreamLine(lineBuffer)
                if (usage) finalUsage = usage
                if (sid) sessionId = sid
                if (parsed) {
                    process.stdout.write(parsed)
                    logStream?.write(parsed)
                    output += parsed
                }
            }

            // Calculate context usage percent
            let contextUsedPercent: number | undefined
            if (finalUsage) {
                const totalTokens = (finalUsage.input_tokens || 0)
                    + (finalUsage.output_tokens || 0)
                    + (finalUsage.cache_read_input_tokens || 0)
                    + (finalUsage.cache_creation_input_tokens || 0)
                const maxContext = MODEL_CONTEXT_WINDOWS.default
                contextUsedPercent = Math.round((totalTokens / maxContext) * 100)
            }

            resolve({ output, exitCode: code ?? 0, contextUsedPercent, sessionId })
        })

        proc.on('error', (err: Error) => {
            console.error(chalk.red(`Error running claude: ${err}`))
            logStream?.write(`Error running claude: ${err}\n`)
            resolve({ output, exitCode: 1 })
        })
    })
}

// ============================================================================
// Shared Args (used by multiple subcommands)
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
// Task Subcommand
// ============================================================================

const taskAddCommand = defineCommand({
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

const taskListCommand = defineCommand({
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

const taskRemoveCommand = defineCommand({
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

const taskDoneCommand = defineCommand({
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

const taskCommand = defineCommand({
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

// ============================================================================
// Run Subcommand
// ============================================================================

const runCommand = defineCommand({
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
            default: false,
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

// ============================================================================
// Plan Subcommand
// ============================================================================

const planCommand = defineCommand({
    meta: {
        name: 'plan',
        description: 'Show plan summary with status, tasks, and mermaid graph',
    },
    args: {
        ...sharedArgs,
        format: {
            type: 'string' as const,
            alias: 'f',
            default: 'default',
            description: 'Output format: default, markdown, json',
        },
        copy: {
            type: 'boolean' as const,
            default: false,
            description: 'Copy output to clipboard',
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

        let output: string

        if (args.format === 'json') {
            output = formatPlanAsJson(state.tasks, state)
        } else {
            output = formatPlanAsMarkdown(state.tasks, state)
        }

        console.log(output)

        if (args.copy) {
            if (copyToClipboard(output)) {
                console.log(chalk.green('✓ Copied to clipboard'))
            } else {
                console.log(chalk.yellow('⚠ Could not copy to clipboard (xclip/xsel not installed?)'))
            }
        }
    },
})

// ============================================================================
// Clear Subcommand
// ============================================================================

const clearCommand = defineCommand({
    meta: {
        name: 'clear',
        description: 'Clear all ralph files (state, log, progress, history)',
    },
    args: {
        ...sharedArgs,
        logFile: {
            type: 'string' as const,
            default: DEFAULT_LOG_FILE,
            description: `Log file path (default: ${DEFAULT_LOG_FILE})`,
        },
    },
    run({ args }) {
        const files = [args.stateFile, args.logFile, DEFAULT_PROGRESS_FILE, DEFAULT_HISTORY_FILE]
        let deleted = 0

        for (const file of files) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
                console.log(chalk.green(`✓ Deleted ${file}`))
                deleted++
            } else {
                console.log(chalk.dim(`  Skipped ${file} (not found)`))
            }
        }

        console.log(chalk.dim(`\nCleared ${deleted} file(s)`))
    },
})

// ============================================================================
// Main Command (with subcommands)
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
        clear: {
            type: 'boolean' as const,
            alias: 'c',
            default: false,
            description: '[Legacy] Use "tt ralph clear" instead',
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
            default: false,
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
        clear: clearCommand,
    },
    async run({ args }) {
        const validatedArgs = validateArgs(args)
        const maxIterations = Number.parseInt(validatedArgs.maxIterations, 10)
        const extraClaudeArgs = validatedArgs.claudeArgs?.split(' ').filter(Boolean) || []

        // Handle legacy --clear flag
        if (validatedArgs.clear) {
            const files = [validatedArgs.stateFile, validatedArgs.logFile, DEFAULT_PROGRESS_FILE, DEFAULT_HISTORY_FILE]
            let deleted = 0

            for (const file of files) {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file)
                    console.log(chalk.green(`✓ Deleted ${file}`))
                    deleted++
                } else {
                    console.log(chalk.dim(`  Skipped ${file} (not found)`))
                }
            }

            console.log(chalk.dim(`\nCleared ${deleted} file(s)`))
            console.log(chalk.yellow('\nNote: Use "tt ralph clear" instead of --clear'))
            process.exit(0)
        }

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
        console.log('  tt ralph clear              Clear all ralph files')
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
