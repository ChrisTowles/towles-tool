import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  SERVER,
  checksToast,
  meetingFrom,
  needsLabel,
  prLabel,
  readyForDone,
  shouldWarn,
  statusLine,
  taskFor,
  untilLabel,
} from './band'

const snapshot = atom({ plugin: 'towles-tool-app', key: 'snapshot' } as const, null)
const warnedMeeting = atom({ plugin: 'towles-tool-app', key: 'warnedMeeting' } as const, null)
const seenChecks = atom({ plugin: 'towles-tool-app', key: 'seenChecks' } as const, null)

const REFRESH_MS = 60_000

/** A tool's result as JSON: the structured result when the server declares one, else its text. */
function payload(result: McpToolResult): unknown {
  if (result.isError) throw new Error('tool failed')
  if (result.structuredContent !== undefined) return result.structuredContent
  const block = result.content.find(one => one.type === 'text')
  return JSON.parse(block && 'text' in block && block.text ? block.text : 'null')
}

/** App closed means MCP down: the band and status line then hide rather than show stale state. */
async function refresh($: EngineInterface) {
  let next: Snapshot | null
  try {
    const [cwd, tasks, upcoming, waiting] = await Promise.all([
      $.session.cwd(),
      $.mcp.call(SERVER, 'task_list'),
      $.mcp.call(SERVER, 'calendar_next'),
      $.mcp.call(SERVER, 'needs_you'),
    ])
    const list = (payload(tasks) as { tasks: Parameters<typeof taskFor>[1] }).tasks
    next = {
      task: taskFor(cwd, list),
      meeting: meetingFrom(payload(upcoming) as Parameters<typeof meetingFrom>[0]),
      needsYou: (payload(waiting) as { sessions: unknown[] }).sessions.length,
    }
  } catch {
    next = null
  }
  await update($, snapshot, () => next)
  $.ui.status(statusLine(next))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap || (!snap.task && !snap.meeting && !snap.needsYou)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const { task, meeting, needsYou } = snap
    const soon = !!meeting && (meeting.live || meeting.minutesUntil <= 15)
    const others = needsLabel(needsYou)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="magenta">✦ tt</Text>
        {task && (
          <Text wrap="truncate-end">
            #{task.id} {task.text} <Text dimColor>({task.status})</Text>
          </Text>
        )}
        {task?.pr && (
          <Text dimColor>
            {prLabel(task.pr)}
          </Text>
        )}
        {readyForDone(task) && <Text color="green">ready for /done</Text>}
        {others && <Text color="yellow">{others}</Text>}
        {meeting && (
          <Text color={soon ? 'yellow' : undefined} dimColor={!soon}>
            {untilLabel(meeting)}
          </Text>
        )}
      </Box>
    )
  })
}
