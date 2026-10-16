import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { midTurnText, promptText, remember, stranded, unseen } from '../hooks/inbox'
import { parkArgs } from '../hooks/park'
import { clipAnswer, clipLabel, offersFrom } from '../hooks/clip'
import { emptyLog, logTool, taken, withAnswer } from '../hooks/suggest'

const NOTE = { id: 4, body: 'also cover the empty state', images: ['/tmp/a.png'] }

describe('inbox', () => {
  test('a note reads as the prompt at rest, framed mid-turn', async () => {
    expect(promptText([NOTE])).toBe('also cover the empty state\nAttached image, read it first: /tmp/a.png')
    expect(midTurnText([NOTE])).toContain('sent from the tt app while you work')
  })

  test('a note is handed over once', async () => {
    expect(unseen([NOTE, { ...NOTE, id: 5 }], [4]).map(n => n.id)).toEqual([5])
    expect(remember(Array.from({ length: 50 }, (_, i) => i), [99]).at(-1)).toBe(99)
    expect(remember(Array.from({ length: 50 }, (_, i) => i), [99]).length).toBe(50)
  })

  test("a note appended in the turn's last step was never read", async () => {
    const appended = [
      { ids: [1], text: 'a', step: 0 },
      { ids: [2], text: 'b', step: 2 },
    ]
    expect(stranded(appended, 2).map(a => a.ids)).toEqual([[2]])
  })
})

describe('park', () => {
  test('the first line titles the task, all of it is the goal', async () => {
    const args = parkArgs('/r', 'cap the inbox\nand sweep old notes', { id: 7, text: 'mods' })
    expect(args).toEqual({
      dir: '/r',
      title: 'cap the inbox',
      goal: 'cap the inbox\nand sweep old notes',
      notes: 'Parked from #7 mods',
      status: 'backlog',
      origin: 'park',
    })
    expect(parkArgs('/r', '   ', null)).toBe(null)
    expect(parkArgs('/r', 'x'.repeat(200), null)?.title.length).toBe(80)
  })
})

describe('suggest', () => {
  test('the turn log keeps tools and Bash commands, bounded', async () => {
    let log = logTool(emptyLog(), 'Bash', 'cargo test')
    log = logTool(log, 'Read', undefined)
    expect(log).toEqual({ tools: ['Bash', 'Read'], commands: ['cargo test'], answer: '' })
    expect(withAnswer(log, 'x'.repeat(3000)).answer.length).toBe(2000)
  })

  test('a sent prompt is the suggestion as-is, edited, or not', async () => {
    expect(taken('run the tests', 'run the tests')).toBe('as-is')
    expect(taken('run the tests you just wrote, then commit', 'run the tests you just wrote')).toBe(
      'edited',
    )
    expect(taken('ship it', 'run the tests')).toBe(null)
    expect(taken('anything', null)).toBe(null)
  })
})

describe('clip', () => {
  test('offers keep only well-formed, non-empty strings, at most three', async () => {
    const raw = {
      items: [
        { label: 'tests', text: 'cargo test' },
        { label: 'blank', text: '  ' },
        { label: 3, text: 'x' },
        { label: 'a', text: 'a' },
        { label: 'b', text: 'b' },
        { label: 'c', text: 'c' },
      ],
    }
    expect(offersFrom(raw).map(o => o.text)).toEqual(['cargo test', 'a', 'b'])
    expect(offersFrom(null)).toEqual([])
    expect(offersFrom({ items: 'no' })).toEqual([])
  })

  test('labels fall back to the text and stay short', async () => {
    expect(clipLabel({ label: ' ', text: 'gh pr view 9' })).toBe('gh pr view 9')
    expect(clipLabel({ label: 'x'.repeat(40), text: 't' }).length).toBe(28)
    expect(clipAnswer('y'.repeat(5000)).length).toBe(4000)
  })
})

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

type Call = { tool: string; args: Record<string, unknown> | undefined }

function app(on: On, notes: unknown[], calls: Call[]) {
  let pending = notes
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args as Record<string, unknown> | undefined })
    const body =
      e.tool === 'task_list'
        ? { tasks: [] }
        : e.tool === 'inbox_take'
          ? { notes: pending.splice(0), pollMs: 3000 }
          : e.tool === 'inbox_ack'
            ? { acked: 1 }
            : e.tool === 'task_create'
              ? { task: { id: 12 } }
              : { event: null }
    return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
  })
}

describe('mod', () => {
  test('a note to an idle session is submitted as the user and acked', async ($, on) => {
    const clock = mock.clock(on)
    const calls: Call[] = []
    app(on, [NOTE], calls)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('ui.log', () => ({ value: undefined }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    expect(submitted).toEqual([promptText([NOTE])])
    expect(calls.find(c => c.tool === 'inbox_ack')?.args).toEqual({ ids: [4], how: 'prompt' })
    await clock.advance(3000)
    expect(submitted.length).toBe(1)
  })

  test('/park files the typed idea as a backlog task', async ($, on) => {
    mock.clock(on)
    const calls: Call[] = []
    app(on, [], calls)
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: 'park', args: 'try a smaller model', ...RUN })
    expect(ran.text).toBe('Parked as #12 in the backlog: try a smaller model')
    expect(calls.find(c => c.tool === 'task_create')?.args).toEqual({
      dir: '/r',
      title: 'try a smaller model',
      goal: 'try a smaller model',
      status: 'backlog',
      origin: 'park',
    })
  })

  test('/next before any turn says so, and asks nothing', async ($, on) => {
    mock.clock(on)
    const calls: Call[] = []
    app(on, [], calls)
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: 'next', args: '', ...RUN })
    expect(ran.text).toContain('after a turn has finished')
    expect(calls.some(c => c.tool === 'next_prompt')).toBe(false)
  })

  test('the model is kept off the mod-only tools', async ($, on) => {
    mock.clock(on)
    app(on, [], [])
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const res = await $.tool.call({ tool: 'mcp__plugin_towles-tool-app_towles-tool__inbox_take' })
    expect(JSON.stringify(res)).toContain('agents never call it')
    const clip = await $.tool.call({ tool: 'mcp__plugin_towles-tool-app_towles-tool__clip_suggest' })
    expect(JSON.stringify(clip)).toContain('agents never call it')
  })
})
