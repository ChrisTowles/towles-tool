import { describe, expect, mock, test } from 'claude-code/testing'

import {
  checksToast,
  meetingFrom,
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
    expect(statusLine(null)).toBe(undefined)
    expect(statusLine({ task: null, meeting: null })).toBe(undefined)
    expect(
      statusLine({
        task: { id: 7, text: 't', status: 'doing', pr: { number: 42, state: 'open', checks: 'passing' } },
        meeting: { id: 3, title: 'Standup', minutesUntil: 4, live: false },
      }),
    ).toBe('tt #7 · PR #42 passing · ready for /done · 4m to Standup')
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
          : e.tool === 'inbox_take'
            ? { notes: [], pollMs: 3000 }
            : { event: { id: 3, title: 'Standup' }, minutesUntil: 4, live: false }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '#7 Claude mods (doing)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PR #42 open · checks passing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4m to Standup' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ready for /done' })).toBeDefined()
    expect(await ui.find({ text: '2 need you' })).toBe(undefined)
    expect(toasts).toEqual(['Standup in 4m. Time to wrap up.'])
    expect(status.at(-1)).toBe('tt #7 · PR #42 passing · ready for /done · 4m to Standup')
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

  test('a finished turn offers its copyable strings; a digit copies, the next turn clears', async ($, on) => {
    const clock = mock.clock(on)
    const calls: { tool: string; args: unknown }[] = []
    const copied: string[] = []
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', () => ({ value: undefined }))
    on('ui.copy', ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    on('session.start', () => ({ cwd: '/r' }))
    on('session.cwd', () => ({ value: '/elsewhere' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('turn.start', () => ({ turnId: 't2' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('mcp.call', ($, e) => {
      calls.push({ tool: e.tool, args: e.args })
      const body =
        e.tool === 'task_list'
          ? { tasks: [] }
          : e.tool === 'inbox_take'
            ? { notes: [], pollMs: 3000 }
            : e.tool === 'clip_suggest'
              ? {
                  items: [
                    { label: 'gh pr', text: '! gh pr merge 9 --squash --admin' },
                    { label: 'bun run', text: '! bun run e2e' },
                  ],
                  skipped: null,
                }
              : e.tool === 'clip_copied'
                ? { recorded: true }
                : { event: null }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const answer = 'Run `! gh pr merge 9 --squash --admin`, then `! bun run e2e`.'
    await $.turn.complete({ answer, reason: 'answer', turnId: 't1' } as never)
    expect(calls.find(c => c.tool === 'clip_suggest')?.args).toEqual({ answer })

    const ui = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: '! gh pr merge 9 --squash --admin' })).toBeDefined()
    await ui.press({ key: 'clip:1' })
    expect(copied).toEqual(['! bun run e2e'])
    expect(toasts.at(-1)).toBe('Copied ! bun run e2e')

    const all = ui.press({ key: 'clip:all' })
    await clock.advance(1000)
    await all
    expect(copied).toEqual(['! bun run e2e', '! gh pr merge 9 --squash --admin', '! bun run e2e'])
    expect(calls.filter(c => c.tool === 'clip_copied').map(c => c.args)).toEqual([
      { count: 1, index: 1 },
      { count: 2 },
    ])
    await ui.unmount()

    await $.turn.start({ text: 'next', turnId: 't2' } as never)
    const after = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await after.find({ text: '! gh pr merge 9 --squash --admin' })).toBe(undefined)
    expect(await after.find({ text: 'engine' })).toBeDefined()
    await after.unmount()
  })

  test('each copy offer gets its own row under the facts, as many as the band has room for', async ($, on) => {
    mock.clock(on)
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/r' }))
    on('session.cwd', () => ({ value: '/r/.claude/worktrees/mods' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('mcp.call', ($, e) => {
      const body =
        e.tool === 'task_list'
          ? { tasks: TASKS }
          : e.tool === 'inbox_take'
            ? { notes: [], pollMs: 3000 }
            : e.tool === 'clip_suggest'
              ? {
                  items: [
                    { label: 'tests', text: 'cargo test -p tt-tasks' },
                    { label: 'file', text: 'crates/tt-tasks/src/landed.rs' },
                    { label: 'e2e', text: 'bun run e2e' },
                  ],
                  costUsd: 0,
                  skipped: null,
                }
              : { event: null }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false } }
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: 'run `cargo test -p tt-tasks`', reason: 'answer', turnId: 't1' } as never)

    const band = await $.ui.mount({ plugin: 'towles-tool-app', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Text', text: '#7 Claude mods (doing)' })).toBeDefined()
    expect(await band.find({ text: ' cargo test -p tt-tasks' })).toBeDefined()
    expect(await band.find({ text: ' bun run e2e' })).toBeDefined()
    await band.unmount()

    const short = await $.ui.mount({
      plugin: 'towles-tool-app',
      surface: 'terminal',
      ...BAND,
      props: { ...BAND.props, maxRows: 3 },
    })
    expect(await short.find({ text: ' crates/tt-tasks/src/landed.rs' })).toBeDefined()
    expect(await short.find({ text: ' bun run e2e' })).toBe(undefined)
    await short.unmount()
  })
})
