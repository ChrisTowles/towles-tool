import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { ClipOffer, InboxNote, Snapshot } from '../types'
import {
  SERVER,
  checksToast,
  meetingFrom,
  prLabel,
  readyForDone,
  shouldWarn,
  statusLine,
  taskFor,
  untilLabel,
} from './band'
import { COPY_ALL_GAP_MS, clipAnswer, clipShown, offersFrom } from './clip'
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
const clips = atom({ plugin: 'towles-tool-app', key: 'clips' } as const, [] as ClipOffer[])

const PANE = 'tt'
const REFRESH_MS = 60_000
const INBOX_MS = 3_000
/** The plugin's MCP server connects after session start, so the first refresh usually misses it. */
const STARTUP_RETRIES = 10
const SUGGEST_DELAY_MS = 250
/** The tools only this mod calls: the model is kept off them. */
const MOD_ONLY = /^mcp__plugin_towles-tool-app_towles-tool__(inbox_|next_prompt|clip_)/

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

/** App closed means MCP down: the band and status line then hide rather than show stale state. */
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
  $.ui.status(statusLine(next))
  if (!next) return
  if (next.task || next.meeting) await openPane($, false)

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

/** Opened once a session; one the person closed comes back only through `/tt`. */
let paneOpened = false
let paneClosed = false

/** Unasked it seats only in a wide terminal and waits below that, so the band stays the fallback. */
async function openPane($: EngineInterface, asked: boolean) {
  if (!asked && (paneOpened || paneClosed)) return
  paneOpened = true
  paneClosed = false
  try {
    await $.ui.open({ id: PANE, title: 'tt' })
  } catch {
    // A surface that seats no panes: the band carries everything.
  }
  $.ui.invalidate('ui.render')
}

async function paneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
  } catch {
    return false
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

/** A turn's question, so a late answer to an older turn never replaces a newer one's. */
let clipTurn = 0

/** One model call per finished turn; the app skips it for prose and past the budget. */
async function askClip($: EngineInterface, answer: string) {
  const turn = ++clipTurn
  try {
    const task = (await read($, snapshot))?.task
    const raw = await call<unknown>($, 'clip_suggest', {
      answer: clipAnswer(answer),
      ...(task ? { taskId: task.id } : {}),
    })
    if (turn !== clipTurn) return
    const offers = offersFrom(raw)
    await update($, clips, () => offers)
    if (offers.length) await openPane($, false)
  } catch {
    // App closed or the call failed: nothing is offered.
  }
}

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** Several go one at a time, apart, so the clipboard manager keeps each in order. */
async function copyOffers($: EngineInterface, offers: ClipOffer[], surface: Surface, index?: number) {
  let copied = 0
  for (const [i, offer] of offers.entries()) {
    if (i > 0) await new Promise<void>(done => $.clock.after(COPY_ALL_GAP_MS, done))
    if ((await $.ui.copy({ text: offer.text, surface })).isCopied) copied++
  }
  if (!copied) {
    $.ui.toast('Nothing reached the clipboard.')
    return
  }
  $.ui.toast(offers.length === 1 ? `Copied ${clipShown(offers[0]!)}` : `Copied ${copied}, in order`)
  const args = { count: copied, ...(index === undefined ? {} : { index }) }
  void call($, 'clip_copied', args).catch(() => {})
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
    // Last, so a host that registers no commands still gets the band and the inbox.
    await $.command.register({
      name: 'park',
      description: 'Park an idea as a backlog task on the tt board, without leaving this session',
      argumentHint: '[idea, or select it first]',
    })
    await $.command.register({
      name: 'tt',
      description: "Open the tt pane: this checkout's task, PR, next meeting and copy offers",
    })
    await $.command.register({
      name: 'next',
      description: 'Suggest your next prompt (one small model call, within your daily budget)',
    })
    return ran
  })

  on('command.run', { command: 'park' }, async ($, e) => ({ text: await park($, e.args) }))
  on('command.run', { command: 'next' }, async $ => ({ text: await askNext($) }))
  on('command.run', { command: 'tt' }, async $ => {
    await openPane($, true)
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined && e.origin.kind === 'person') paneClosed = true
    $.ui.invalidate('ui.render')
    return closed
  })

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
      clipTurn++
      await update($, clips, () => [])
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
    if (e.reason === 'answer') void askClip($, e.answer)
    await refresh($)
    void takeInbox($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const offers = await read($, clips)
    const task = snap?.task ?? null
    const meeting = snap?.meeting ?? null
    const soon = !!meeting && (meeting.live || meeting.minutesUntil <= 15)
    const canSuggest = !!(await read($, lastTurn))
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {!snap && <Text dimColor>The tt app is not reachable.</Text>}
        {task && (
          <Box flexDirection="column">
            <Text bold>
              #{task.id} {task.text}
            </Text>
            <Text dimColor>{task.status}</Text>
            {task.pr && <Text dimColor>{prLabel(task.pr)}</Text>}
            {readyForDone(task) && <Text color="green">ready for /done</Text>}
          </Box>
        )}
        {meeting && (
          <Text color={soon ? 'yellow' : undefined} dimColor={!soon}>
            {untilLabel(meeting)}
          </Text>
        )}
        {offers.length > 0 && (
          <Box flexDirection="column">
            {offers.map((offer, i) => (
              <Button
                key={`clip:${i}`}
                hotkey={String(i + 1)}
                plain
                onPress={press => void copyOffers($, [offer], press.surface, i)}
              >
                <Text backgroundColor="magenta" color="black">
                  {' copy '}
                </Text>
                <Text> {offer.text.trim()}</Text>
              </Button>
            ))}
            {offers.length > 1 && (
              <Button
                key="clip:all"
                hotkey="a"
                plain
                dimColor
                onPress={press => void copyOffers($, offers, press.surface)}
              >
                copy all
              </Button>
            )}
          </Box>
        )}
        {canSuggest && (
          <Button key="next" hotkey="n" plain dimColor onPress={() => void askNext($)}>
            next prompt
          </Button>
        )}
      </Box>
    )
  })

  // Docked, the pane holds the facts and the band keeps only the keys: a pane's hotkeys need its focus.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const docked = await paneShown($)
    const snap = docked ? null : await read($, snapshot)
    const offers = e.props.isWorking ? [] : await read($, clips)
    const canSuggest = !e.props.isWorking && !!(await read($, lastTurn))
    const hasFacts = !!snap && (!!snap.task || !!snap.meeting)
    if (docked ? !offers.length && !canSuggest : !hasFacts && !offers.length) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const task = snap?.task ?? null
    const meeting = snap?.meeting ?? null
    const soon = !!meeting && (meeting.live || meeting.minutesUntil <= 15)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="magenta">✦ tt</Text>
        {task && (
          <Text wrap="truncate-end">
            #{task.id} {task.text} <Text dimColor>({task.status})</Text>
          </Text>
        )}
        {task?.pr && <Text dimColor>{prLabel(task.pr)}</Text>}
        {readyForDone(task) && <Text color="green">ready for /done</Text>}
        {meeting && (
          <Text color={soon ? 'yellow' : undefined} dimColor={!soon}>
            {untilLabel(meeting)}
          </Text>
        )}
        {canSuggest && (
          <Button key="next" hotkey="n" plain dimColor onPress={() => void askNext($)}>
            next prompt
          </Button>
        )}
        {offers.map((offer, i) => (
          <Button
            key={`clip:${i}`}
            hotkey={String(i + 1)}
            plain
            onPress={press => void copyOffers($, [offer], press.surface, i)}
          >
            <Text backgroundColor="magenta" color="black">
              {' copy '}
            </Text>
            {!docked && <Text> {clipShown(offer)}</Text>}
          </Button>
        ))}
        {offers.length > 1 && (
          <Button
            key="clip:all"
            hotkey="a"
            plain
            dimColor
            onPress={press => void copyOffers($, offers, press.surface)}
          >
            copy all
          </Button>
        )}
      </Box>
    )
  })
}
