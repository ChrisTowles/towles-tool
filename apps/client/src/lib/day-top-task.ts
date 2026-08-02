import type { TaskItem, TaskStatus } from "@/lib/data";

/** Higher wins. `done` is excluded before ranking, so it needs no rank here. */
const STATUS_RANK: Record<Exclude<TaskStatus, "done">, number> = {
  doing: 1,
  backlog: 0,
};

/** The one task the app header surfaces. Closed tasks are never eligible —
 * including one abandoned mid-`doing`, whose frozen status would otherwise
 * outrank every live card. */
export function pickTopTask(tasks: readonly TaskItem[]): TaskItem | undefined {
  let best: TaskItem | undefined;
  for (const task of tasks) {
    if (task.closed) continue;
    if (best === undefined || isHigherPriority(task, best)) {
      best = task;
    }
  }
  return best;
}

function isHigherPriority(a: TaskItem, b: TaskItem): boolean {
  const rankA = STATUS_RANK[a.status as Exclude<TaskStatus, "done">];
  const rankB = STATUS_RANK[b.status as Exclude<TaskStatus, "done">];
  if (rankA !== rankB) return rankA > rankB;
  return a.position < b.position;
}
