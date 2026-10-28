import { describe, expect, mock, test } from 'claude-code/testing'

import { checksToast, meetingFrom, shouldWarn, taskFor } from '../hooks/snapshot'

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

describe('snapshot', () => {
  test('the deepest worktree holding cwd is the task', async () => {
    expect(taskFor('/r/.claude/worktrees/mods/packages/app', TASKS)?.id).toBe(7)
    expect(taskFor('/r/src', TASKS)?.id).toBe(1)
    expect(taskFor('/elsewhere', TASKS)).toBe(null)
    expect(taskFor('/r/.claude/worktrees/modsx', TASKS)?.id).toBe(1)
  })

  test('a meeting needs an event and a time until it', async () => {
    expect(meetingFrom({ event: { id: 3, title: 'Standup' }, minutesUntil: 95 })).toEqual({
      id: 3,
      title: 'Standup',
      minutesUntil: 95,
      live: false,
    })
    expect(meetingFrom({ event: null })).toBe(null)
  })

  test('the heads-up fires once per meeting, never while it runs', async () => {
    const soon = { id: 3, title: 'Standup', minutesUntil: 4, live: false }
    expect(shouldWarn({ task: null, meeting: soon }, null)).toBe(true)
    expect(shouldWarn({ task: null, meeting: soon }, 3)).toBe(false)
    expect(shouldWarn({ task: null, meeting: { ...soon, live: true } }, null)).toBe(
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

  test('a meeting five minutes out raises the heads-up toast once', async ($, on) => {
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
          : e.tool === 'inbox_take'
            ? { notes: [], pollMs: 3000 }
            : { event: { id: 3, title: 'Standup' }, minutesUntil: 4, live: false }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    expect(toasts).toEqual(['Standup in 4m. Time to wrap up.'])
  })
})
