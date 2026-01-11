import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../../commands/base.js'
import { DEFAULT_STATE_FILE, loadState } from '../../../commands/ralph/state.js'
import { formatTasksAsMarkdown } from '../../../commands/ralph/formatter.js'

/**
 * List all ralph tasks
 */
export default class TaskList extends BaseCommand {
  static override description = 'List all tasks'

  static override aliases = ['ralph:task:list', 'ralph:task:ls']

  static override examples = [
    '<%= config.bin %> ralph task list',
    '<%= config.bin %> ralph task list --format markdown',
    '<%= config.bin %> ralph task list --label backend',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: 's',
      description: 'State file path',
      default: DEFAULT_STATE_FILE,
    }),
    format: Flags.string({
      char: 'f',
      description: 'Output format: default, markdown',
      default: 'default',
      options: ['default', 'markdown'],
    }),
    label: Flags.string({
      char: 'l',
      description: 'Filter tasks by label',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(TaskList)

    const state = loadState(flags.stateFile)

    if (!state) {
      console.log(pc.yellow(`No state file found at: ${flags.stateFile}`))
      return
    }

    // Filter by label if specified
    let tasks = state.tasks
    if (flags.label) {
      tasks = tasks.filter(t => t.label === flags.label)
      if (tasks.length === 0) {
        console.log(pc.yellow(`No tasks with label: ${flags.label}`))
        return
      }
    }

    if (tasks.length === 0) {
      console.log(pc.yellow('No tasks in state file.'))
      console.log(pc.dim('Use: tt ralph task add "description"'))
      return
    }

    if (flags.format === 'markdown') {
      console.log(formatTasksAsMarkdown(tasks))
      return
    }

    // Default format output
    const header = flags.label ? `Tasks (label: ${flags.label})` : 'Tasks'
    console.log(pc.bold(`\n${header}:\n`))
    for (const task of tasks) {
      const statusColor = task.status === 'done' ? pc.green
        : task.status === 'in_progress' ? pc.yellow
        : pc.dim
      const icon = task.status === 'done' ? '✓'
        : task.status === 'in_progress' ? '→'
        : '○'
      const labelSuffix = task.label && !flags.label ? pc.dim(` [${task.label}]`) : ''
      console.log(statusColor(`  ${icon} ${task.id}. ${task.description} (${task.status})`) + labelSuffix)
    }
    console.log()
  }
}
