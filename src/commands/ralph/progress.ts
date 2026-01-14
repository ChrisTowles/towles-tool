import * as fs from 'node:fs'
import * as path from 'node:path'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../base.js'
import { DEFAULT_PROGRESS_FILE } from './lib/state.js'

/**
 * Append progress message to ralph-progress.md (write-only, no read)
 */
export default class Progress extends BaseCommand {
  static override description = 'Append progress message (write-only, never reads file)'

  static override examples = [
    '<%= config.bin %> ralph progress "Completed user service implementation"',
    '<%= config.bin %> ralph progress "Starting tests" --file custom-progress.md',
  ]

  static override args = {
    message: Args.string({
      description: 'Progress message to append',
      required: true,
    }),
  }

  static override flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      char: 'f',
      description: 'Progress file path',
      default: DEFAULT_PROGRESS_FILE,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Progress)

    const timestamp = new Date().toISOString()
    const line = `- [${timestamp}] ${args.message}\n`

    fs.mkdirSync(path.dirname(flags.file), { recursive: true })
    fs.appendFileSync(flags.file, line)
  }
}
