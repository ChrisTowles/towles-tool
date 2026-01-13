import { execFileSync } from 'node:child_process'
import type { RalphTask, TaskStatus, RalphState } from './state.js'

// ============================================================================
// Clipboard Utility
// ============================================================================

export function copyToClipboard(text: string): boolean {
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
// Task Formatting
// ============================================================================

export function formatTasksForPrompt(tasks: RalphTask[]): string {
    if (tasks.length === 0) {
        return 'No tasks.'
    }

    const statusIcon = (status: TaskStatus): string => {
        switch (status) {
            case 'done': return '✓'
            case 'in_progress': return '→'
            case 'pending': return '○'
            case 'hold': return '⏸'
            case 'cancelled': return '✗'
        }
    }

    const lines: string[] = []
    for (const t of tasks) {
        const checkbox = t.status === 'done' ? '[x]' : '[ ]'
        lines.push(`- ${checkbox} #${t.id} ${t.description} \`${statusIcon(t.status)} ${t.status}\``)
    }

    return lines.join('\n')
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
            case 'hold': return '`⏸ hold`'
            case 'cancelled': return '`✗ cancelled`'
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
// Prompt Building
// ============================================================================

export interface BuildPromptOptions {
    completionMarker: string
    progressFile: string
    focusedTaskId: number | null
    skipCommit?: boolean
    progressContent?: string
    taskList: string
}

export function buildIterationPrompt({ completionMarker, progressFile, focusedTaskId, skipCommit = false, progressContent, taskList }: BuildPromptOptions): string {
    // prompt inspired by https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum#2-start-with-hitl-then-go-afk

    let step = 1

    //IMPORTANT Always tell it to APPEND to progress file, save a lot of tokens by not reading it to update.

    const prompt = `
<input-current-tasks>
${taskList}
</input-current-tasks>

<instructions>
${step++}. ${focusedTaskId
        ? `**Work on Task #${focusedTaskId}** (you've been asked to focus on this one).`
        : `**Choose** which pending task to work on next based on YOUR judgment of priority/dependencies.`}
${step++}. Work on that single task.
${step++}. Run type checks and tests.
${step++}. Mark the task done using CLI: \`tt ralph task done <id>\`
${step++}. Append to @${progressFile} with what you did.
${skipCommit ? '' : `${step++}. Make a git commit.`}

**ONE TASK PER ITERATION**

**Before ending:** Run \`tt ralph task list\` to check remaining tasks.
**ONLY if ALL TASKS are done** then Output: <promise>${completionMarker}</promise>
</instructions>

<prior-context note="Reference only - these tasks are already completed, do not work on them">
${progressContent || '(No prior progress)'}
</prior-context>
`
    return prompt.trim()
}

// ============================================================================
// Marker Detection
// ============================================================================

export function detectCompletionMarker(output: string, marker: string): boolean {
    return output.includes(marker)
}
