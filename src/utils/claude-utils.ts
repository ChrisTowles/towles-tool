import type { SDKMessage } from '@anthropic-ai/claude-code'
import type { TowlesToolSettings } from '../config'

import { query } from '@anthropic-ai/claude-code'

import consola from 'consola'

export async function invokeClaude({ prompt }: { config: TowlesToolSettings, prompt: string }): Promise<string> {
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

  consola.log(messages)

  return messages.map(m => m).join('\n') // Assuming messages is an array of objects with a 'text' property
}

export async function claudeDoctor(_config: TowlesToolSettings): Promise<string> {
  return 'I\'m Claude, your virtual assistant!'
}
