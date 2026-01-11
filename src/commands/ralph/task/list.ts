import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../base'
import { DEFAULT_STATE_FILE, loadState } from '../state'
import { formatTasksAsMarkdown } from '../formatter'

export default class TaskList extends BaseCommand {
    static override description = 'List all tasks'

    static override aliases = ['ralph:task:ls']

    static override flags = {
        ...BaseCommand.baseFlags,
        stateFile: Flags.string({
            char: 's',
            default: DEFAULT_STATE_FILE,
            description: `State file path (default: ${DEFAULT_STATE_FILE})`,
        }),
        format: Flags.string({
            char: 'f',
            default: 'default',
            description: 'Output format: default, markdown',
            options: ['default', 'markdown'],
        }),
    }

    async run(): Promise<void> {
        const { flags } = await this.parse(TaskList)
        const state = loadState(flags.stateFile)

        if (!state) {
            this.log(pc.yellow(`No state file found at: ${flags.stateFile}`))
            return
        }

        if (state.tasks.length === 0) {
            this.log(pc.yellow('No tasks in state file.'))
            this.log(pc.dim('Use: tt ralph task add "description"'))
            return
        }

        if (flags.format === 'markdown') {
            this.log(formatTasksAsMarkdown(state.tasks))
            return
        }

        // Default format output
        this.log(pc.bold('\nTasks:\n'))
        for (const task of state.tasks) {
            const statusColor = task.status === 'done' ? pc.green
                : task.status === 'in_progress' ? pc.yellow
                : task.status === 'hold' ? pc.blue
                : task.status === 'cancelled' ? pc.red
                : pc.dim
            const icon = task.status === 'done' ? '✓'
                : task.status === 'in_progress' ? '→'
                : task.status === 'hold' ? '⏸'
                : task.status === 'cancelled' ? '✗'
                : '○'
            const sessionInfo = task.sessionId ? pc.dim(` [session: ${task.sessionId.slice(0, 8)}...]`) : ''
            this.log(statusColor(`  ${icon} ${task.id}. ${task.description} (${task.status})${sessionInfo}`))
        }
        this.log()
    }
}
