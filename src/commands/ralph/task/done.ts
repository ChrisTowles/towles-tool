import { Args, Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../base.js'
import { DEFAULT_STATE_FILE, loadState, saveState } from '../lib/state.js'

/**
 * Mark a ralph task as done
 */
export default class TaskDone extends BaseCommand {
  static override description = 'Mark a task as done by ID'

  static override examples = [
    '<%= config.bin %> ralph task done 1',
    '<%= config.bin %> ralph task done 5 --stateFile custom-state.json',
  ]

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
      description: 'State file path',
      default: DEFAULT_STATE_FILE,
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
      this.error(`Task #${taskId} not found. Use: tt ralph task list`)
    }

    if (task.status === 'done') {
      console.log(pc.yellow(`Task #${taskId} is already done.`))
      return
    }

    task.status = 'done'
    task.completedAt = new Date().toISOString()
    saveState(state, flags.stateFile)

    console.log(pc.green(`✓ Marked task #${taskId} as done: ${task.description}`))

    const remaining = state.tasks.filter(t => t.status !== 'done').length
    if (remaining === 0) {
      console.log(pc.bold(pc.green('All tasks complete!')))
    } else {
      console.log(pc.dim(`Remaining tasks: ${remaining}`))
    }
  }
}
