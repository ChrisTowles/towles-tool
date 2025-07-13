import type { SDKMessage } from '@anthropic-ai/claude-code'
import type { Config } from '../config'

import { query } from '@anthropic-ai/claude-code'

import { consola } from 'consola'
import { printJson } from './print-utils'

export async function invokeClaude({ prompt }: { prompt: string }): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  for await (const message of query({
    prompt,
    abortController: new AbortController(),
    options: {
      maxTurns: 1,
    },
  })) {
    printJson(message)
    messages.push(message)
  }

  return messages
}

export async function claudeDoctor(config: Config): Promise<string> {
  return `${config.cwd} ${config.userConfig.journalDir}`
}
