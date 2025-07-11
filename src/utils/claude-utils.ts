import type { SDKMessage } from '@anthropic-ai/claude-code'
import type { TowlesToolConfig } from '../config'
import { query } from '@anthropic-ai/claude-code'

/**
 * Get the Monday of the week for a given date
 */

import { ensureDirectoryExists } from '../commands/today'

export async function invokeClaude({ prompt }: { config: TowlesToolConfig, prompt: string }): Promise<string> {
  const messages: SDKMessage[] = []

  for await (const message of query({
    prompt,
    abortController: new AbortController(),
    options: {
      maxTurns: 1,
    },
  })) {
    messages.push(message)
  }

  console.log(messages)

  // let result = ''
  // try {
  //   // Ensure zx is initialized
  //   $.shell = '/bin/zsh'

  //   ensureDirectoryExists(config.claudeAlias)

  //   // const args = ['--print', `${prompt}`, '--output-format', 'json']
  //   // const args = ['--print', '"tell a joke"']
  //   const command = [`--print "${prompt}" --output-format json`
  //   consola.info(`Invoking Claude with command: ${config.claudeAlias}  ${command}`)

  //   const message = await $`${config.claudeAlias}  ${command}`

  //   consola.info('Claude command found at:', config, prompt)
  //   // const message = await $`${config.claudeAlias} -p "${prompt}" --output-format json`
  //   // const message = await $`claude -p "${prompt}" --output-format json`
  //   result = message.stdout
  // }
  // catch (error) {
  //   consola.error('Error invoking:', error)
  //   process.exit(1)
  // }

  // // #| jq -r '.result')

  return messages.map(m => m).join('\n') // Assuming messages is an array of objects with a 'text' property
}

export async function claudeDoctor(config: TowlesToolConfig): Promise<string> {
  ensureDirectoryExists(config.claudeAlias)// ??

  return 'I\'m Claude, your virtual assistant!'
}
