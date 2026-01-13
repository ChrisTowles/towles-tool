import { Args, Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../base.js'
import { DEFAULT_STATE_FILE, loadState, saveState } from '../lib/state.js'

/**
 * Remove a ralph task by ID
 */
export default class TaskRemove extends BaseCommand {
  static override description = 'Remove a task by ID'

  static override examples = [
    '<%= config.bin %> ralph task remove 1',
    '<%= config.bin %> ralph task remove 5 --stateFile custom-state.json',
  ]

  static override args = {
    id: Args.integer({
      description: 'Task ID to remove',
      required: true,
    }),
  }

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: 's',
      description: 'State file path',
      default: DEFAULT_STATE_FILE,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TaskRemove)

    const taskId = args.id

    if (taskId < 1) {
      this.error('Invalid task ID')
    }

    const state = loadState(flags.stateFile)

    if (!state) {
      this.error(`No state file found at: ${flags.stateFile}`)
    }

    const taskIndex = state.tasks.findIndex(t => t.id === taskId)

    if (taskIndex === -1) {
      this.error(`Task #${taskId} not found. Use: tt ralph task list`)
    }

    const removedTask = state.tasks[taskIndex]
    state.tasks.splice(taskIndex, 1)
    saveState(state, flags.stateFile)

    console.log(pc.green(`✓ Removed task #${taskId}: ${removedTask.description}`))
    console.log(pc.dim(`Remaining tasks: ${state.tasks.length}`))
  }
}
