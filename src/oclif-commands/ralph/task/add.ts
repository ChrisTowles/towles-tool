import { Args, Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../../../commands/base.js'
import {
  DEFAULT_STATE_FILE,
  DEFAULT_MAX_ITERATIONS,
  loadState,
  saveState,
  createInitialState,
  addTaskToState,
} from '../../../commands/ralph/state.js'
import { findSessionByMarker } from '../../../commands/ralph/marker.js'

/**
 * Add a new task to ralph state
 */
export default class TaskAdd extends BaseCommand {
  static override description = 'Add a new task'

  static override aliases = ['ralph:task:add']

  static override examples = [
    '<%= config.bin %> ralph task add "Fix the login bug"',
    '<%= config.bin %> ralph task add "Implement feature X" --sessionId abc123',
    '<%= config.bin %> ralph task add "Implement feature X" --findMarker abc123',
  ]

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
      description: 'State file path',
      default: DEFAULT_STATE_FILE,
    }),
    sessionId: Flags.string({
      description: 'Claude session ID for resuming from prior research',
    }),
    findMarker: Flags.string({
      char: 'm',
      description: 'Find session by marker (searches ~/.claude for RALPH_MARKER_<value>)',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TaskAdd)

    const description = args.description.trim()

    if (!description || description.length < 3) {
      this.error('Task description too short (min 3 chars)')
    }

    // Resolve session ID from --sessionId or --findMarker
    let sessionId = flags.sessionId
    if (flags.findMarker) {
      if (sessionId) {
        this.error('Cannot use both --sessionId and --findMarker')
      }
      console.log(pc.dim(`Searching for marker: ${flags.findMarker}...`))
      sessionId = await findSessionByMarker(flags.findMarker) ?? undefined
      if (!sessionId) {
        this.error(`Marker not found: RALPH_MARKER_${flags.findMarker}\nMake sure Claude output this marker during research.`)
      }
      console.log(pc.cyan(`Found session: ${sessionId.slice(0, 8)}...`))
    }

    let state = loadState(flags.stateFile)

    if (!state) {
      state = createInitialState(DEFAULT_MAX_ITERATIONS)
    }

    const newTask = addTaskToState(state, description, sessionId)
    saveState(state, flags.stateFile)

    console.log(pc.green(`✓ Added task #${newTask.id}: ${newTask.description}`))
    if (sessionId) {
      console.log(pc.cyan(`  Session: ${sessionId.slice(0, 8)}...`))
    }
    console.log(pc.dim(`State saved to: ${flags.stateFile}`))
    console.log(pc.dim(`Total tasks: ${state.tasks.length}`))
  }
}
