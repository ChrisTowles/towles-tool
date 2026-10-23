import { describe, expect, mock, test } from 'claude-code/testing'

import { QUIET_MS, clipShown, offers, quiet } from '../hooks/clip'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

describe('offers', () => {
  test('a status report of identifiers offers nothing', async () => {
    const report =
      'Merged as 58f357dd (#783).\n\nThe `clip.skipped` event fires from crates/x.rs, see ' +
      'https://github.com/o/r/pull/783 and ~/code/p/notes.md.\n```sh\ncargo test --all\n```'
    expect(offers(report)).toEqual([])
  })

  test('fenced, indented and inline commands keep their bang', async () => {
    expect(offers('Run this:\n\n```sh\n! cd ~/x && gh pr merge 780 --squash --admin\n```\n')).toEqual([
      '! cd ~/x && gh pr merge 780 --squash --admin',
    ])
    expect(offers('Sign in:\n    ! gcloud auth login\n')).toEqual(['! gcloud auth login'])
    expect(offers('Type `! gcloud auth login` first.')).toEqual(['! gcloud auth login'])
  })

  test('a bang elsewhere is not a command', async () => {
    for (const text of [
      'Done! All green.',
      'Skip it ! really',
      '```rust\nif a != b {}\n```',
      '![img](x.png)',
      'Use `a != b` here and `!x` there.',
      '',
    ]) {
      expect(offers(text)).toEqual([])
    }
  })

  test('continued lines stay one command', async () => {
    expect(offers('```\n! cargo test \\\n  -p tt-mcp\n```')).toEqual(['! cargo test \\\n  -p tt-mcp'])
  })

  test('deduplicated and capped at three', async () => {
    expect(offers('! a one\n! a one\n`! b two`\n! c three\n! d four')).toEqual([
      '! a one',
      '! b two',
      '! c three',
    ])
  })

  test('the toast shows one short line', async () => {
    expect(clipShown(' ! gh pr\n view 9 ')).toBe('! gh pr view 9')
    expect(clipShown('x'.repeat(60)).length).toBe(40)
  })

  test('three ignored offers go quiet, with a probe after the quiet spell', async () => {
    expect(quiet({ offers: 2, lastMs: 0 }, 1)).toBe(false)
    expect(quiet({ offers: 3, lastMs: 0 }, 1)).toBe(true)
    expect(quiet({ offers: 3, lastMs: 0 }, QUIET_MS)).toBe(false)
  })
})

describe('mod', () => {
  test('a finished turn offers its commands under the band; a digit copies, the next turn clears', async ($, on) => {
    const clock = mock.clock(on)
    const copied: string[] = []
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.copy', ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    on('turn.start', () => ({ turnId: 't2' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>beneath</Text>
    })
    const answer = 'Run `! gh pr merge 9 --squash --admin`, then `! bun run e2e`.'
    await $.turn.complete({ answer, reason: 'answer', turnId: 't1' } as never)

    const ui = await $.ui.mount({ plugin: 'tt', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    expect(await ui.find({ text: ' ! gh pr merge 9 --squash --admin' })).toBeDefined()
    await ui.press({ key: 'clip:1' })
    expect(copied).toEqual(['! bun run e2e'])
    expect(toasts.at(-1)).toBe('Copied ! bun run e2e')

    const all = ui.press({ key: 'clip:all' })
    await clock.advance(1000)
    await all
    expect(copied).toEqual(['! bun run e2e', '! gh pr merge 9 --squash --admin', '! bun run e2e'])
    await ui.unmount()

    await $.turn.start({ text: 'next', turnId: 't2' } as never)
    const after = await $.ui.mount({ plugin: 'tt', surface: 'terminal', ...BAND })
    expect(await after.find({ text: ' ! gh pr merge 9 --squash --admin' })).toBe(undefined)
    expect(await after.find({ text: 'beneath' })).toBeDefined()
    await after.unmount()
  })
})
