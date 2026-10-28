import type { SnapshotMeeting, SnapshotTask, SeenChecks, Snapshot } from '../types'

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
export function taskFor(cwd: string, tasks: RawTask[]): SnapshotTask | null {
  const holds = (dir: string) => cwd === dir || cwd.startsWith(`${dir}/`)
  const match = tasks
    .filter(t => t.worktree?.dir && holds(t.worktree.dir))
    .sort((a, b) => (b.worktree?.dir?.length ?? 0) - (a.worktree?.dir?.length ?? 0))[0]
  if (!match) return null
  const pr = match.prs?.find(p => p.state === 'open') ?? match.prs?.at(-1) ?? null
  return { id: match.id, text: match.text, status: match.status, pr }
}

export function meetingFrom(next: RawNext): SnapshotMeeting | null {
  if (!next.event || next.minutesUntil === undefined) return null
  return {
    id: next.event.id,
    title: next.event.title,
    minutesUntil: next.minutesUntil,
    live: next.live ?? false,
  }
}

/** Whether the snapshot's meeting should raise the one-time heads-up toast. */
export function shouldWarn(snapshot: Snapshot, warned: number | null): boolean {
  const m = snapshot.meeting
  return !!m && !m.live && m.minutesUntil <= WARN_MINUTES && m.id !== warned
}

/** The toast for a PR whose checks settled since last seen; `null` on first sight or no change. */
export function checksToast(pr: SnapshotTask['pr'], seen: SeenChecks | null): string | null {
  if (!pr || seen?.pr !== pr.number || seen.checks === pr.checks) return null
  if (pr.checks === 'failing') return `PR #${pr.number} checks failing`
  if (pr.checks === 'passing') return `PR #${pr.number} checks passing`
  return null
}
