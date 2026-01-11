import { Args, Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../base'
import { DEFAULT_STATE_FILE, loadState, saveState } from '../state'

export default class TaskDone extends BaseCommand {
    static override description = 'Mark a task as done by ID'

    static override args = {
        id: Args.integer({
            description: 'Task ID to mark done',
            required: true,
        }),
    }

    static override flags = {
        ...BaseCommand.baseFlags,
        stateFile: Flags.string({
            char: 's',
            default: DEFAULT_STATE_FILE,
            description: `State file path (default: ${DEFAULT_STATE_FILE})`,
        }),
    }

    async run(): Promise<void> {
        const { args, flags } = await this.parse(TaskDone)
        const taskId = args.id

        if (taskId < 1) {
            this.error('Invalid task ID')
        }

        const state = loadState(flags.stateFile)

        if (!state) {
            this.error(`No state file found at: ${flags.stateFile}`)
        }

        const task = state.tasks.find(t => t.id === taskId)

        if (!task) {
            this.error(`Task #${taskId} not found\nUse: tt ralph task list`)
        }

        if (task.status === 'done') {
            this.log(pc.yellow(`Task #${taskId} is already done.`))
            return
        }

        task.status = 'done'
        task.completedAt = new Date().toISOString()
        saveState(state, flags.stateFile)

        this.log(pc.green(`✓ Marked task #${taskId} as done: ${task.description}`))

        const remaining = state.tasks.filter(t => t.status !== 'done').length
        if (remaining === 0) {
            this.log(pc.bold(pc.green('All tasks complete!')))
        } else {
            this.log(pc.dim(`Remaining tasks: ${remaining}`))
        }
    }
}
