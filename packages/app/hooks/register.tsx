import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { InboxNote, Snapshot } from '../types'
import { SERVER, checksToast, meetingFrom, shouldWarn, taskFor } from './snapshot'
import { type Appended, midTurnText, promptText, remember, stranded, unseen } from './inbox'
import { parkArgs } from './park'
import { emptyLog, logTool, taken, withAnswer } from './suggest'

const snapshot = atom({ plugin: 'towles-tool-app', key: 'snapshot' } as const, null)
const warnedMeeting = atom({ plugin: 'towles-tool-app', key: 'warnedMeeting' } as const, null)
const seenChecks = atom({ plugin: 'towles-tool-app', key: 'seenChecks' } as const, null)
const seenNotes = atom({ plugin: 'towles-tool-app', key: 'seenNotes' } as const, [])
const lastTurn = atom({ plugin: 'towles-tool-app', key: 'lastTurn' } as const, null)
const suggestion = atom({ plugin: 'towles-tool-app', key: 'suggestion' } as const, null)
const asking = atom({ plugin: 'towles-tool-app', key: 'asking' } as const, false)

const REFRESH_MS = 60_000
const INBOX_MS = 3_000
/** The plugin's MCP server connects after session start, so the first refresh usually misses it. */
const STARTUP_RETRIES = 10
const SUGGEST_DELAY_MS = 250
/** The tools only this mod calls: the model is kept off them. */
const MOD_ONLY = /^mcp__plugin_towles-tool-app_towles-tool__(inbox_|next_prompt)/

/** A tool's result as JSON: the structured result when the server declares one, else its text. */
function payload(result: McpToolResult): unknown {
  if (result.isError) throw new Error('tool failed')
  if (result.structuredContent !== undefined) return result.structuredContent
  const block = result.content.find(one => one.type === 'text')
  return JSON.parse(block && 'text' in block && block.text ? block.text : 'null')
}

async function call<T>($: EngineInterface, tool: string, args?: Record<string, unknown>) {
  return payload(await $.mcp.call(SERVER, tool, args)) as T
}

/** App closed means MCP down: the snapshot clears rather than go stale. */
async function refresh($: EngineInterface) {
  let next: Snapshot | null
  try {
    const [cwd, tasks, upcoming] = await Promise.all([
      $.session.cwd(),
      call<{ tasks: Parameters<typeof taskFor>[1] }>($, 'task_list'),
      call<Parameters<typeof meetingFrom>[0]>($, 'calendar_next'),
    ])
    next = { task: taskFor(cwd, tasks.tasks), meeting: meetingFrom(upcoming) }
  } catch {
    next = null
  }
  await update($, snapshot, () => next)
  if (!next) return

  const pr = next.task?.pr ?? null
  const ci = checksToast(pr, await read($, seenChecks))
  await update($, seenChecks, () => (pr ? { pr: pr.number, checks: pr.checks } : null))
  if (ci) $.ui.toast(ci)

  if (shouldWarn(next, await read($, warnedMeeting))) {
    const m = next.meeting!
    await update($, warnedMeeting, () => m.id)
    $.ui.toast(`${m.title} in ${m.minutesUntil}m. Time to wrap up.`)
  }
}

/** The main loop's turn as this module saw it; a reload starts it over, mid-turn or not. */
let busy = false
let step = -1
let appended: (Appended & { notes: InboxNote[] })[] = []
let log = emptyLog()
let taking = false
let inboxTimer: { cancel: () => void } | null = null

function preview(notes: readonly InboxNote[]): string {
  const first = notes[0]?.body.split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

async function ack($: EngineInterface, ids: number[], how: 'midTurn' | 'prompt') {
  try {
    await call($, 'inbox_ack', { ids, how })
  } catch {
    // The lease lapses and the app offers the note again; `seenNotes` keeps it from landing twice.
  }
}

async function submitNotes($: EngineInterface, notes: InboxNote[]) {
  await $.prompt.submit({ text: promptText(notes), asUser: true })
  $.ui.log(`✉ note from the tt app, sent as your prompt: ${preview(notes)}`)
  await ack($, notes.map(n => n.id), 'prompt')
}

/** Mid-turn the note joins the conversation for the model's next step; at rest it is the prompt. */
async function takeInbox($: EngineInterface) {
  if (taking) return
  taking = true
  try {
    const taken = await call<{ notes: InboxNote[]; pollMs: number }>($, 'inbox_take')
    if (taken.pollMs === 0) {
      inboxTimer?.cancel()
      inboxTimer = null
    }
    const fresh = unseen(taken.notes, await read($, seenNotes))
    if (!fresh.length) return
    const ids = fresh.map(n => n.id)
    await update($, seenNotes, seen => remember(seen, ids))
    if (busy) {
      const text = midTurnText(fresh)
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      appended.push({ ids, text, step, notes: fresh })
      $.ui.log(`✉ note from the tt app, read at the agent's next step: ${preview(fresh)}`)
    } else {
      await submitNotes($, fresh)
    }
  } catch {
    // App closed: the next poll tries again.
  } finally {
    taking = false
  }
}

async function askNext($: EngineInterface): Promise<string> {
  const turn = await read($, lastTurn)
  if (!turn) return 'Nothing to go on yet: /next suggests after a turn has finished.'
  if (await read($, asking)) return 'Already asking.'
  await update($, asking, () => true)
  try {
    const task = (await read($, snapshot))?.task
    const answer = await call<{ prompt: string | null; costUsd: number | null; budgetLeftUsd: number }>(
      $,
      'next_prompt',
      { ...turn, ...(task ? { taskId: task.id } : {}) },
    )
    if (!answer.prompt) {
      return answer.budgetLeftUsd <= 0
        ? "Today's next-prompt budget is spent; raise it in the app's settings."
        : 'No confident guess this time.'
    }
    const text = answer.prompt
    await update($, suggestion, () => text)
    // Proposed once the command's own output is drawn: while it runs the box refuses one.
    $.clock.after(SUGGEST_DELAY_MS, () => void $.prompt.suggest({ text }))
    return `Next prompt, Tab to take it: ${text} ($${answer.budgetLeftUsd.toFixed(2)} left today)`
  } catch {
    return 'The tt app is not reachable, so there is no suggestion.'
  } finally {
    await update($, asking, () => false)
  }
}

async function park($: EngineInterface, args: string): Promise<string> {
  const idea = args.trim() || (await $.ui.selection())?.text || ''
  const task = (await read($, snapshot))?.task ?? null
  const request = parkArgs(await $.session.cwd(), idea, task)
  if (!request) return 'Nothing to park: type /park <idea>, or select the text first.'
  try {
    const created = await call<{ task: { id: number } }>($, 'task_create', request)
    return `Parked as #${created.task.id} in the backlog: ${request.title}`
  } catch {
    return 'Not parked: the tt app is not reachable, or this checkout is not one it tracks.'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    let tries = 0
    const retry = $.clock.every(INBOX_MS, async () => {
      if (++tries > STARTUP_RETRIES || (await read($, snapshot))) return retry.cancel()
      await refresh($)
    })
    $.clock.every(REFRESH_MS, () => void refresh($))
    inboxTimer = $.clock.every(INBOX_MS, () => void takeInbox($))
    // Last, so a host that registers no commands still gets the toasts and the inbox.
    await $.command.register({
      name: 'park',
      description: 'Park an idea as a backlog task on the tt board, without leaving this session',
      argumentHint: '[idea, or select it first]',
    })
    await $.command.register({
      name: 'next',
      description: 'Suggest your next prompt (one small model call, within your daily budget)',
    })
    return ran
  })

  on('command.run', { command: 'park' }, async ($, e) => ({ text: await park($, e.args) }))
  on('command.run', { command: 'next' }, async $ => ({ text: await askNext($) }))
  // `$.mcp.call` rides `tool.call` too, so the mod's own calls are told apart by their origin.
  on('tool.call', { tool: MOD_ONLY }, ($, e, next) =>
    next.origin.plugin === 'towles-tool-app'
      ? next(e)
      : { deny: 'This tool belongs to the tt Claude mod; agents never call it.' },
  )

  on('tool.call', async ($, e, next) => {
    if (busy && e.agentId === undefined) {
      log = logTool(log, e.tool, (e as { command?: unknown }).command)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const offered = await read($, suggestion)
      if (offered && e.origin.kind !== 'plugin') {
        const how = taken(e.text, offered)
        await update($, suggestion, () => null)
        if (how) void call($, 'next_prompt_taken', { edited: how === 'edited' }).catch(() => {})
      }
    } catch {
      // Bookkeeping only: the prompt goes through whatever happened here.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      step = -1
      appended = []
      log = emptyLog()
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      step = e.index
      // This step's request carries every note appended before it: those were read.
      const read = appended.filter(a => a.step < e.index)
      appended = appended.filter(a => a.step >= e.index)
      for (const a of read) void ack($, a.ids, 'midTurn')
      void takeInbox($)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    busy = false
    const missed = stranded(appended, step)
    appended = []
    await update($, lastTurn, () => withAnswer(log, e.answer))
    for (const a of missed) await submitNotes($, a.notes)
    await refresh($)
    void takeInbox($)
    return ran
  })
}
