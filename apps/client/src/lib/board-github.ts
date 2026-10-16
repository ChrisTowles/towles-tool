import { isItemDismissed, type IssueItem, type PrItem, type TaskItem } from "@/lib/data";

/** Issue rows are keyed case-folded: an origin URL's casing need not match a link's. */
export function issueKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** Every cached issue row by `repo#number`, the user's own winning over a watched copy. */
export function issueIndex(mine: IssueItem[], watched: IssueItem[]): Map<string, IssueItem> {
  const index = new Map<string, IssueItem>();
  for (const issue of [...watched, ...mine]) index.set(issueKey(issue.repo, issue.number), issue);
  return index;
}

/** Watched-label issues worth offering as a task: open, not dismissed, and not
 * already linked to any task — closed and archived ones included, since that
 * issue has had its turn. Newest update first. */
export function suggestedIssues(watched: IssueItem[], tasks: TaskItem[]): IssueItem[] {
  const linked = new Set<string>();
  for (const task of tasks) {
    for (const link of task.issues) linked.add(issueKey(link.repo, link.number));
  }
  return watched
    .filter((i) => i.state === "open" && !isItemDismissed(i))
    .filter((i) => !linked.has(issueKey(i.repo, i.number)))
    .toSorted((a, b) => b.updatedTs - a.updatedTs);
}

export type LandedToday = {
  /** The user's merged PRs last updated since local midnight. */
  prs: PrItem[];
  /** Tasks closed as done since local midnight. */
  tasks: TaskItem[];
};

export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Newest first. A merged PR's time is its last update, which is the merge unless
 * someone commented afterwards — the collector doesn't keep `mergedAt`. */
export function landedToday(prs: PrItem[], tasks: TaskItem[], nowMs: number): LandedToday {
  const since = startOfLocalDay(nowMs);
  return {
    prs: prs
      .filter((p) => p.state === "merged" && p.updatedTs >= since)
      .toSorted((a, b) => b.updatedTs - a.updatedTs),
    tasks: tasks
      .filter((t) => t.displayOutcome === "done" && (t.completedAt ?? 0) >= since)
      .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
  };
}
