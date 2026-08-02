import { ownerRepoFromOrigin } from "@/lib/agentboard";
import { TASK_STATUSES, type TaskItem, type TaskStatus } from "@/lib/data";

export const NO_REPO_GROUP = "__no_repo__";

export type TaskGroup = {
  key: string;
  /** `owner/name` in its own casing; `key` is the folded form of the same. */
  slug: string;
  label: string;
  tasks: TaskItem[];
};

/** GitHub slugs are case-preserving but not case-sensitive, and this app's
 * sources disagree on casing — folding keeps one repo from splitting in two. */
export function foldRepoKey(slug: string): string {
  return slug === NO_REPO_GROUP ? slug : slug.toLowerCase();
}

/** Every GitHub-identity source is tried before the repo-root basename, which
 * is a local directory name and so can never merge into an `owner/name` lane. */
export function taskRepoSlug(task: TaskItem): string {
  const taskRepo = task.worktree?.repo?.trim();
  if (taskRepo) return taskRepo;

  const linked = task.issues[0]?.repo ?? task.prs[0]?.repo;
  if (linked) return linked;

  const root = task.worktree?.repoRoot?.trim();
  if (root) {
    const base = root
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop();
    if (base) return base;
  }

  return NO_REPO_GROUP;
}

export function taskRepoKey(task: TaskItem): string {
  return foldRepoKey(taskRepoSlug(task));
}

export type RailRepoRow = {
  key: string;
  dir: string;
  originUrl?: string | null;
  folders: { dir: string }[];
};

/** Path evidence outranks GitHub identity here: a worktree dir names one
 * checkout, while `owner/name` could match a fork tracked under another path. */
export function railRepoKeyForTask(repos: RailRepoRow[], task: TaskItem): string | null {
  const dirs = [task.worktree?.dir, task.worktree?.repoRoot].filter(
    (d): d is string => !!d?.trim(),
  );
  for (const repo of repos) {
    if (dirs.some((d) => d === repo.dir || repo.folders.some((f) => f.dir === d))) return repo.key;
  }

  const ghKey = taskRepoKey(task);
  if (ghKey === NO_REPO_GROUP) return null;
  for (const repo of repos) {
    const originKey = ownerRepoFromOrigin(repo.originUrl);
    if (originKey && foldRepoKey(originKey) === ghKey) return repo.key;
  }
  return null;
}

export function repoGroupLabel(key: string): string {
  if (key === NO_REPO_GROUP) return "No repo";
  return key.split("/").pop() || key;
}

/** One comparator shared by the lane cells and the drop-time insertion index. */
export function byBoardOrder(a: TaskItem, b: TaskItem): number {
  return a.position - b.position || a.createdAt - b.createdAt;
}

/** A closed task keeps its frozen kanban `status` as history, but the board
 * shows where a card *is*. Shared by bucketing, counting and the drag handlers. */
export function boardColumnOf(task: Pick<TaskItem, "status" | "closed">): TaskStatus {
  return task.closed ? "done" : task.status;
}

export function bucketByStatus(tasks: TaskItem[]): Record<TaskStatus, TaskItem[]> {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskItem[]])) as Record<
    TaskStatus,
    TaskItem[]
  >;
  // `?.`: an unknown status from an older/newer db drops that one card only.
  for (const task of tasks) byStatus[boardColumnOf(task)]?.push(task);
  for (const status of TASK_STATUSES) byStatus[status].sort(byBoardOrder);
  return byStatus;
}

export function groupTasksByRepo(tasks: TaskItem[]): TaskGroup[] {
  // Display slug is the first spelling seen, so a lane renders GitHub's casing.
  const byKey = new Map<string, { slug: string; tasks: TaskItem[] }>();
  for (const task of tasks) {
    const key = taskRepoKey(task);
    const bucket = byKey.get(key);
    if (bucket) bucket.tasks.push(task);
    else byKey.set(key, { slug: taskRepoSlug(task), tasks: [task] });
  }

  return [...byKey.entries()]
    .map(([key, { slug, tasks: groupTasks }]) => ({
      key,
      slug,
      label: repoGroupLabel(slug),
      tasks: groupTasks,
    }))
    .toSorted((a, b) => {
      if (a.key === NO_REPO_GROUP) return 1;
      if (b.key === NO_REPO_GROUP) return -1;
      return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
    });
}
