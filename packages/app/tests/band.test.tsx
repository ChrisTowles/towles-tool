import { describe, expect, mock, test } from 'claude-code/testing'

import {
  checksToast,
  meetingFrom,
  needsLabel,
  prLabel,
  readyForDone,
  shouldWarn,
  statusLine,
  taskFor,
  untilLabel,
} from '../hooks/band'

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
    expect(shouldWarn({ task: null, meeting: soon, needsYou: 0 }, null)).toBe(true)
    expect(shouldWarn({ task: null, meeting: soon, needsYou: 0 }, 3)).toBe(false)
    expect(shouldWarn({ task: null, meeting: { ...soon, live: true }, needsYou: 0 }, null)).toBe(
      false,
    )
  })

  test('a CI toast fires when checks settle, never on first sight', async () => {
    const pr = { number: 42, state: 'open', checks: 'failing' }
    expect(checksToast(pr, null)).toBe(null)
    expect(checksToast(pr, { pr: 41, checks: 'passing' })).toBe(null)
    expect(checksToast(pr, { pr: 42, checks: 'failing' })).toBe(null)
    expect(checksToast(pr, { pr: 42, checks: 'pending' })).toBe('PR #42 checks failing')
    expect(checksToast({ ...pr, checks: 'passing' }, { pr: 42, checks: 'failing' })).toBe(
      'PR #42 checks passing',
    )
    expect(checksToast({ ...pr, checks: 'pending' }, { pr: 42, checks: 'passing' })).toBe(null)
  })

  test('ready for /done is an open PR with passing checks', async () => {
    const task = { id: 7, text: 't', status: 'doing', pr: null }
    expect(readyForDone(task)).toBe(false)
    expect(readyForDone({ ...task, pr: { number: 1, state: 'open', checks: 'passing' } })).toBe(true)
    expect(readyForDone({ ...task, pr: { number: 1, state: 'open', checks: 'pending' } })).toBe(false)
    expect(readyForDone({ ...task, pr: { number: 1, state: 'merged', checks: 'passing' } })).toBe(
      false,
    )
  })

  test('the status line', async () => {
    expect(needsLabel(0)).toBe(null)
    expect(needsLabel(1)).toBe('1 needs you')
    expect(statusLine(null)).toBe(undefined)
    expect(statusLine({ task: null, meeting: null, needsYou: 0 })).toBe(undefined)
    expect(
      statusLine({
        task: { id: 7, text: 't', status: 'doing', pr: { number: 42, state: 'open', checks: 'passing' } },
        meeting: { id: 3, title: 'Standup', minutesUntil: 4, live: false },
        needsYou: 2,
      }),
    ).toBe('tt #7 · PR #42 passing · ready for /done · 2 need you · 4m to Standup')
  })

  test('the band shows the task, its PR and the next meeting', async ($, on) => {
    mock.clock(on)
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => {
      status.push(e.text)
      return { value: undefined }
    })
    on('session.start', () => ({ cwd: '/r' }))
    on('session.cwd', () => ({ value: '/r/.claude/worktrees/mods' }))
    on('mcp.call', ($, e) => {
      const body =
        e.tool === 'task_list'
          ? { tasks: TASKS }
          : e.tool === 'needs_you'
            ? { sessions: [{ session: 'a' }, { session: 'b' }] }
            : { event: { id: 3, title: 'Standup' }, minutesUntil: 4, live: false }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '#7 Claude mods (doing)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PR #42 open · checks passing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4m to Standup' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ready for /done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 need you' })).toBeDefined()
    expect(toasts).toEqual(['Standup in 4m. Time to wrap up.'])
    expect(status.at(-1)).toBe('tt #7 · PR #42 passing · ready for /done · 2 need you · 4m to Standup')
    await ui.unmount()
  })

  test('app down: the band passes and the status line clears', async ($, on) => {
    mock.clock(on)
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => {
      status.push(e.text)
      return { value: undefined }
    })
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
    expect(status).toEqual([undefined])
    await ui.unmount()
  })
})
