import { Args, Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../base'
import {
    DEFAULT_STATE_FILE,
    DEFAULT_MAX_ITERATIONS,
    loadState,
    saveState,
    createInitialState,
    addTaskToState,
} from '../state'

export default class TaskAdd extends BaseCommand {
    static override description = 'Add a new task'

    static override args = {
        description: Args.string({
            description: 'Task description',
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
        sessionId: Flags.string({
            description: 'Session ID to resume when running this task',
        }),
    }

    async run(): Promise<void> {
        const { args, flags } = await this.parse(TaskAdd)
        const description = args.description.trim()

        if (description.length < 3) {
            this.error('Task description too short (min 3 chars)')
        }

        let state = loadState(flags.stateFile)

        if (!state) {
            state = createInitialState(DEFAULT_MAX_ITERATIONS)
        }

        const newTask = addTaskToState(state, description, flags.sessionId)
        saveState(state, flags.stateFile)

        this.log(pc.green(`✓ Added task #${newTask.id}: ${newTask.description}`))
        if (flags.sessionId) {
            this.log(pc.dim(`  Session ID: ${flags.sessionId}`))
        }
        this.log(pc.dim(`State saved to: ${flags.stateFile}`))
        this.log(pc.dim(`Total tasks: ${state.tasks.length}`))
    }
}
