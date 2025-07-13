import type { SendMessageInput } from './types'
import consola from 'consola'
import { describe, expect, it } from 'vitest'
import { ClaudeService } from './claude-service'
// import { invokeClaude } from './claude-service'

// describe.skip('claude utilities', () => {
//   it('invokeClaude should return a string', async () => {
//     const result = await invokeClaude({ prompt: 'tell a joke' })
//     expect(typeof result).toBe('object')
//   }, 15_000)
// })

describe('claude-service', () => {
  it('sendMessageStream should return a string', async () => {
    const service = new ClaudeService()

    const input: SendMessageInput = {
      message: 'tell me a joke',

    }

    const result = await service.sendMessageStream(input, (chunk) => {
      consola.log('Received chunk:', chunk)
    })

    expect(result.isErr()).toBe(false)
    expect(result.isOk()).toBe(true)

    // const result = await invokeClaude({ prompt: 'tell a joke' })
    // expect(typeof result).toBe('object')
  }, 15_000)
})
