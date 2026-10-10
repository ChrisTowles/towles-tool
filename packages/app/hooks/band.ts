import type { BandMeeting, BandTask, SeenChecks, Snapshot } from '../types'

/** The app's MCP server, as `/mcp` lists it once this plugin is enabled. */
export const SERVER = 'plugin:towles-tool-app:towles-tool'

export const WARN_MINUTES = 5

type RawTask = {
  id: number
  text: string
  status: string
  worktree?: { dir?: string }
  prs?: { number: number; state: string; checks: string }[]
}

type RawNext = {
  event: { id: number; title: string } | null
  minutesUntil?: number
  live?: boolean
}

/** The open task whose worktree holds `cwd`; the deepest wins when worktrees nest. */
export function taskFor(cwd: string, tasks: RawTask[]): BandTask | null {
  const holds = (dir: string) => cwd === dir || cwd.startsWith(`${dir}/`)
  const match = tasks
    .filter(t => t.worktree?.dir && holds(t.worktree.dir))
    .sort((a, b) => (b.worktree?.dir?.length ?? 0) - (a.worktree?.dir?.length ?? 0))[0]
  if (!match) return null
  const pr = match.prs?.find(p => p.state === 'open') ?? match.prs?.at(-1) ?? null
  return { id: match.id, text: match.text, status: match.status, pr }
}

export function meetingFrom(next: RawNext): BandMeeting | null {
  if (!next.event || next.minutesUntil === undefined) return null
  return {
    id: next.event.id,
    title: next.event.title,
    minutesUntil: next.minutesUntil,
    live: next.live ?? false,
  }
}

export function untilLabel(m: BandMeeting): string {
  if (m.live) return `in ${m.title} now`
  if (m.minutesUntil < 60) return `${m.minutesUntil}m to ${m.title}`
  const h = Math.floor(m.minutesUntil / 60)
  const rest = m.minutesUntil % 60
  return `${h}h${rest ? ` ${rest}m` : ''} to ${m.title}`
}

export function prLabel(pr: NonNullable<BandTask['pr']>): string {
  const checks = pr.checks ? ` · checks ${pr.checks}` : ''
  return `PR #${pr.number} ${pr.state}${checks}`
}

/** Whether the snapshot's meeting should raise the one-time heads-up toast. */
export function shouldWarn(snapshot: Snapshot, warned: number | null): boolean {
  const m = snapshot.meeting
  return !!m && !m.live && m.minutesUntil <= WARN_MINUTES && m.id !== warned
}

/** The toast for a PR whose checks settled since last seen; `null` on first sight or no change. */
export function checksToast(pr: BandTask['pr'], seen: SeenChecks | null): string | null {
  if (!pr || seen?.pr !== pr.number || seen.checks === pr.checks) return null
  if (pr.checks === 'failing') return `PR #${pr.number} checks failing`
  if (pr.checks === 'passing') return `PR #${pr.number} checks passing`
  return null
}

/** Open and green: what `/towles-tool-app:done` needs to land it. */
export function readyForDone(task: BandTask | null): boolean {
  return task?.pr?.state === 'open' && task.pr.checks === 'passing'
}

export function needsLabel(count: number): string | null {
  return count > 0 ? `${count} need${count === 1 ? 's' : ''} you` : null
}

/** The band's facts on one short line, for the status line. */
export function statusLine(snap: Snapshot | null): string | undefined {
  if (!snap) return undefined
  const { task, meeting, needsYou } = snap
  const parts = [
    task && `#${task.id}`,
    task?.pr && `PR #${task.pr.number} ${task.pr.checks}`,
    readyForDone(task) && 'ready for /done',
    needsLabel(needsYou),
    meeting && untilLabel(meeting),
  ].filter(Boolean)
  return parts.length ? `tt ${parts.join(' · ')}` : undefined
}
