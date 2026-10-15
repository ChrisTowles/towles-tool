const TITLE_MAX = 80

export type ParkArgs = {
  dir: string
  title: string
  goal: string
  notes?: string
  status: 'backlog'
  origin: 'park'
}

/** The board task `/park` files: the idea's first line as its title, all of it as the goal. */
export function parkArgs(
  cwd: string,
  text: string,
  from: { id: number; text: string } | null,
): ParkArgs | null {
  const goal = text.trim()
  if (!goal) return null
  const first = (goal.split('\n')[0] ?? '').trim()
  const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first
  return {
    dir: cwd,
    title,
    goal,
    ...(from ? { notes: `Parked from #${from.id} ${from.text}` } : {}),
    status: 'backlog',
    origin: 'park',
  }
}
