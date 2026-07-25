import { ownerRepoFromOrigin } from "@/lib/agentboard";
import { TASK_STATUSES, type TaskItem, type TaskStatus } from "@/lib/data";

/** The bucket for tasks with no discoverable repo. Sorts last. */
export const NO_REPO_GROUP = "__no_repo__";

/**
 * A Board swimlane: one repo's tasks, in the order the lanes are rendered.
 *
 * `key` stays stable across snapshots so React can keep lane identity as tasks
 * move — it must not be derived from anything that changes with a card's
 * status or position; repo identity only.
 */
export type TaskGroup = {
  key: string;
  /** The lane's `owner/name` in its own casing, for display and deep links.
   * `NO_REPO_GROUP` for the catch-all bucket. Distinct from `key`, which is
   * case-folded so casing variants can't split the lane. */
  slug: string;
  /** What the lane header shows — the bare repo name, not `owner/name`. */
  label: string;
  tasks: TaskItem[];
};

/**
 * Fold a repo slug to its grouping key.
 *
 * GitHub slugs are case-preserving but not case-sensitive, and this app has
 * more than one source for them: `gh` reports `ChrisTowles/towles-tool` on
 * issue and PR rows, while the origin-derived tracked-repo cache once stored a
 * folded copy, which `task_create` then stamped onto new tasks. Grouping on the
 * raw string turned those into two lanes that `repoGroupLabel` rendered
 * identically — one repo, apparently duplicated on the Board. Comparing folded
 * makes that unrepresentable, including for rows already written.
 */
export function foldRepoKey(slug: string): string {
  return slug === NO_REPO_GROUP ? slug : slug.toLowerCase();
}

/**
 * The repo a task belongs to, as a stable grouping key.
 *
 * Resolution order matters, and every GitHub-identity source is tried before
 * any filesystem path:
 *
 * 1. `task.repo` — the `owner/name` bound at submit. It survives the worktree
 *    being removed (`task_repo`/`task_repo_root` are kept as historical fact
 *    when `task_dir` is cleared), so a finished task stays in its lane instead
 *    of jumping to "No repo" the moment its task is cleaned up.
 * 2. The first issue, then PR link — for tasks that were never task-bound.
 * 3. `task.repoRoot`'s basename, last and only as a weak guess: it's a local
 *    directory name, not `owner/name`, so tasks resolved this way can't merge
 *    into a lane keyed by GitHub identity. It only exists so a task bound to a
 *    repo with no parseable GitHub origin still gets a named lane.
 *
 * Returns the slug in its own casing — see [`taskRepoKey`] for the folded
 * grouping key. Exported for direct unit tests; production code goes through
 * [`groupTasksByRepo`].
 */
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

/** The repo a task groups under, case-folded so casing variants of one slug
 * share a lane. Use [`taskRepoSlug`] when displaying the repo. */
export function taskRepoKey(task: TaskItem): string {
  return foldRepoKey(taskRepoSlug(task));
}

/** The slice of an Agentboard rail repo row this module resolves against —
 * structural so tests don't have to build full `RepoData` values. */
export type RailRepoRow = {
  key: string;
  dir: string;
  originUrl?: string | null;
  folders: { dir: string }[];
};

/**
 * The Agentboard rail row a task belongs to, as the row's focus key
 * (`RepoData.key`) — the id `openTabWithFocus({ screen: "agentboard", kind:
 * "repo" })` scrolls to. `null` when the task's repo isn't on the rail.
 *
 * Path evidence outranks GitHub identity: a task's worktree dir / repo root names
 * one specific checkout group, while `owner/name` could match a fork tracked
 * under a different local path. Untracked-repo tasks fall through to `null`
 * rather than guessing.
 */
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

/** The lane header text for a grouping key: `owner/name` renders as `name`.
 * Exported for direct unit tests. */
export function repoGroupLabel(key: string): string {
  if (key === NO_REPO_GROUP) return "No repo";
  return key.split("/").pop() || key;
}

/** The Board's card order within a status column: `position`, ties broken by
 * creation time. One comparator shared by the lane cells and the drop-time
 * insertion index, so they can never disagree about ordering. */
export function byBoardOrder(a: TaskItem, b: TaskItem): number {
  return a.position - b.position || a.createdAt - b.createdAt;
}

/** The column a card renders in. Closed tasks (`closed`, computed backend-side
 * in tt-store) render in the terminal "Closed" column whatever their frozen
 * kanban `status` says — an abandoned task keeps `status: "doing"` as
 * history, but the board shows where it *is*, not where it was. One helper
 * shared by bucketing, counting, and the drag handlers, so they can never
 * disagree about a card's column. */
export function boardColumnOf(task: Pick<TaskItem, "status" | "closed">): TaskStatus {
  return task.closed ? "done" : task.status;
}

/**
 * Bucket tasks into the three columns, each sorted in board order. Closed
 * tasks land in the terminal column via `boardColumnOf`.
 */
export function bucketByStatus(tasks: TaskItem[]): Record<TaskStatus, TaskItem[]> {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskItem[]])) as Record<
    TaskStatus,
    TaskItem[]
  >;
  // `?.`: `status` is a closed union in TS, but the value crosses IPC from
  // SQLite — an unknown status from an older/newer db drops that one card
  // rather than crashing the whole board render.
  for (const task of tasks) byStatus[boardColumnOf(task)]?.push(task);
  for (const status of TASK_STATUSES) byStatus[status].sort(byBoardOrder);
  return byStatus;
}

/**
 * Bucket tasks into repo swimlanes, alphabetical by label with "No repo" last.
 *
 * Lanes are derived purely from the tasks passed in, so a lane appears and
 * disappears with its work rather than needing to be created or cleaned up —
 * that's what makes the grouping "automatic". Callers pass the already-filtered
 * task list, so filtering to nothing also removes the lane.
 */
export function groupTasksByRepo(tasks: TaskItem[]): TaskGroup[] {
  // Keyed folded so casing variants merge; the lane's display slug is the first
  // spelling seen, so a lane still renders GitHub's own casing.
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
