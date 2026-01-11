import { Flags } from '@oclif/core'
import pc from 'picocolors'
import { BaseCommand } from '../base'
import { DEFAULT_STATE_FILE, loadState } from './state'
import { formatPlanAsMarkdown, formatPlanAsJson, copyToClipboard } from './formatter'

export default class Plan extends BaseCommand {
    static override description = 'Show plan summary with status, tasks, and mermaid graph'

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
            description: 'Output format: default, markdown, json',
            options: ['default', 'markdown', 'json'],
        }),
        copy: Flags.boolean({
            default: false,
            description: 'Copy output to clipboard',
        }),
    }

    async run(): Promise<void> {
        const { flags } = await this.parse(Plan)
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

        let output: string

        if (flags.format === 'json') {
            output = formatPlanAsJson(state.tasks, state)
        } else {
            output = formatPlanAsMarkdown(state.tasks, state)
        }

        this.log(output)

        if (flags.copy) {
            if (copyToClipboard(output)) {
                this.log(pc.green('✓ Copied to clipboard'))
            } else {
                this.log(pc.yellow('Could not copy to clipboard (xclip/xsel not installed?)'))
            }
        }
    }
}
