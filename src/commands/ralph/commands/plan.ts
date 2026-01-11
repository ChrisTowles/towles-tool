import 'zx/globals'
import { defineCommand } from 'citty'
import { DEFAULT_STATE_FILE, loadState } from '../state'
import { formatPlanAsMarkdown, formatPlanAsJson, copyToClipboard } from '../formatter'

// ============================================================================
// Shared Args
// ============================================================================

const sharedArgs = {
    stateFile: {
        type: 'string' as const,
        alias: 's',
        default: DEFAULT_STATE_FILE,
        description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    },
}

// ============================================================================
// Plan Command
// ============================================================================

export const planCommand = defineCommand({
    meta: {
        name: 'plan',
        description: 'Show plan summary with status, tasks, and mermaid graph',
    },
    args: {
        ...sharedArgs,
        format: {
            type: 'string' as const,
            alias: 'f',
            default: 'default',
            description: 'Output format: default, markdown, json',
        },
        copy: {
            type: 'boolean' as const,
            default: false,
            description: 'Copy output to clipboard',
        },
    },
    run({ args }) {
        const state = loadState(args.stateFile)

        if (!state) {
            console.log(chalk.yellow(`No state file found at: ${args.stateFile}`))
            process.exit(0)
        }

        if (state.tasks.length === 0) {
            console.log(chalk.yellow('No tasks in state file.'))
            console.log(chalk.dim(`Use: tt ralph task add "description"`))
            process.exit(0)
        }

        let output: string

        if (args.format === 'json') {
            output = formatPlanAsJson(state.tasks, state)
        } else {
            output = formatPlanAsMarkdown(state.tasks, state)
        }

        console.log(output)

        if (args.copy) {
            if (copyToClipboard(output)) {
                console.log(chalk.green('✓ Copied to clipboard'))
            } else {
                console.log(chalk.yellow('⚠ Could not copy to clipboard (xclip/xsel not installed?)'))
            }
        }
    },
})
