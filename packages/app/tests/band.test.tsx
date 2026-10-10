import { describe, expect, mock, test } from 'claude-code/testing'

import { meetingFrom, prLabel, shouldWarn, taskFor, untilLabel } from '../hooks/band'

const TASKS = [
  { id: 1, text: 'repo root', status: 'todo', worktree: { dir: '/r' } },
  {
    id: 7,
    text: 'Claude mods',
    status: 'doing',
    worktree: { dir: '/r/.claude/worktrees/mods' },
    prs: [{ number: 42, state: 'open', checks: 'passing' }],
  },
]

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

describe('band', () => {
  test('the deepest worktree holding cwd is the task', async () => {
    expect(taskFor('/r/.claude/worktrees/mods/packages/app', TASKS)?.id).toBe(7)
    expect(taskFor('/r/src', TASKS)?.id).toBe(1)
    expect(taskFor('/elsewhere', TASKS)).toBe(null)
    expect(taskFor('/r/.claude/worktrees/modsx', TASKS)?.id).toBe(1)
  })

  test('labels', async () => {
    expect(prLabel({ number: 42, state: 'open', checks: 'passing' })).toBe(
      'PR #42 open · checks passing',
    )
    const m = meetingFrom({ event: { id: 3, title: 'Standup' }, minutesUntil: 95, live: false })
    expect(m && untilLabel(m)).toBe('1h 35m to Standup')
    expect(meetingFrom({ event: null })).toBe(null)
  })

  test('the heads-up fires once per meeting, never while it runs', async () => {
    const soon = { id: 3, title: 'Standup', minutesUntil: 4, live: false }
    expect(shouldWarn({ task: null, meeting: soon }, null)).toBe(true)
    expect(shouldWarn({ task: null, meeting: soon }, 3)).toBe(false)
    expect(shouldWarn({ task: null, meeting: { ...soon, live: true } }, null)).toBe(false)
  })

  test('the band shows the task, its PR and the next meeting', async ($, on) => {
    mock.clock(on)
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('session.start', () => ({ cwd: '/r' }))
    on('session.cwd', () => ({ value: '/r/.claude/worktrees/mods' }))
    on('mcp.call', ($, e) => {
      const body =
        e.tool === 'task_list'
          ? { tasks: TASKS }
          : { event: { id: 3, title: 'Standup' }, minutesUntil: 4, live: false }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '#7 Claude mods (doing)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PR #42 open · checks passing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4m to Standup' })).toBeDefined()
    expect(toasts).toEqual(['Standup in 4m. Time to wrap up.'])
    await ui.unmount()
  })

  test('app down: the band passes', async ($, on) => {
    mock.clock(on)
    on('session.start', () => ({ cwd: '/r' }))
    on('session.cwd', () => ({ value: '/r' }))
    on('mcp.call', () => {
      throw new Error('connection refused')
    })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: '✦ tt' })).toBe(undefined)
    expect(await ui.find({ text: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})
