import { byBoardOrder, NO_REPO_GROUP, repoGroupLabel, taskRepoSlug } from "./board-groups";
import type { TaskItem, TaskStatus } from "./data";

/** Where selecting the row lands: the bound checkout on Agentboard, or the
 * card itself on the Board (a `todo` focus target) when no worktree is live. */
export type PaletteTaskTarget =
  | { kind: "worktree"; folderDir: string }
  | { kind: "board"; taskId: number };

export type PaletteTaskEntry = {
  key: string;
  id: number;
  /** cmdk keys rows on this; the id keeps two same-titled quick todos apart. */
  value: string;
  title: string;
  repo: string | null;
  branch: string | null;
  meta: string;
  target: PaletteTaskTarget;
  keywords: string[];
};

const STATUS_RANK: Record<TaskStatus, number> = { doing: 0, backlog: 1, done: 2 };

/** Open cards only — archived and closed tasks are history, not destinations.
 * In-progress work leads, then board order within a column. */
export function paletteTaskEntries(tasks: readonly TaskItem[]): PaletteTaskEntry[] {
  return tasks
    .filter((t) => t.archivedAt === undefined && !t.closed)
    .toSorted((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byBoardOrder(a, b))
    .map(toEntry);
}

export function paletteTaskTarget(task: TaskItem): PaletteTaskTarget {
  const dir = task.worktree?.dir?.trim();
  if (task.hasWorktree && dir) return { kind: "worktree", folderDir: dir };
  return { kind: "board", taskId: task.id };
}

function toEntry(task: TaskItem): PaletteTaskEntry {
  const slug = taskRepoSlug(task);
  const repo = slug === NO_REPO_GROUP ? null : slug;
  const short = repo ? repoGroupLabel(repo) : null;
  const branch = task.worktree?.branch?.trim() || null;
  const links = [...task.issues, ...task.prs].map((l) => `#${l.number}`);
  return {
    key: `task:${task.id}`,
    id: task.id,
    value: `task ${task.id} ${task.text} ${repo ?? ""} ${branch ?? ""}`,
    title: task.text,
    repo,
    branch,
    meta: [short, branch].filter((s): s is string => s !== null).join(" · "),
    target: paletteTaskTarget(task),
    keywords: ["task", "board", repo, short, branch, ...links].filter((k): k is string => !!k),
  };
}
