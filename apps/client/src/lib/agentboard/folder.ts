import type { PrItem, TaskIssueLink, TaskItem } from "@/lib/data";
import { isEmptyQuery, matchesFilter } from "@/lib/settings-filter";
import type { RailFilter } from "@/lib/settings";
import { humanizeFolderName } from "./folder-name";
import { liveSessions, sessionCatchesEye } from "./session";
import type { FolderData, RepoData, RowTask } from "./types";

export function folderTask(folder: FolderData): RowTask | undefined {
  return "task" in folder.record ? folder.record.task : undefined;
}

export function folderIsHome(folder: Pick<FolderData, "record">): boolean {
  return folder.record.origin === "home";
}

/** The home row's group — a repo in the payload's shape only. */
export function isHomeRepo(r: Pick<RepoData, "folders">): boolean {
  return r.folders.some(folderIsHome);
}

export function folderIsUnclaimed(folder: FolderData): boolean {
  return folder.record.origin === "detected";
}

export function folderCreating(folder: FolderData): boolean {
  return folder.phase?.state === "creating";
}

export function folderRemoving(folder: FolderData): boolean {
  return folder.phase?.state === "removing";
}

/** Not on disk and nothing working on it — a failed create, or deleted outside. */
export function folderDetached(folder: FolderData): boolean {
  return "task" in folder.record && folder.dirMissing && !folderBusy(folder);
}

/** The task's own record first: a row with no directory has no git to read from.
 * `undefined` means nothing to rebuild — an unclaimed row isn't the user's. */
export function folderRecreateBranch(
  folder: Pick<FolderData, "record" | "branch">,
): string | undefined {
  if (folder.record.origin !== "task") return undefined;
  return folder.record.task.branch?.trim() || folder.branch.trim() || undefined;
}

/** A task row whose worktree switched branches after the record was written. Not
 * offered on the task's base branch. */
export function folderBranchDrift(
  folder: Pick<FolderData, "record" | "branch" | "dirMissing" | "taskBaseBranch">,
): { recorded: string; live: string } | undefined {
  if (folder.record.origin !== "task" || folder.dirMissing) return undefined;
  const recorded = folder.record.task.branch?.trim();
  const live = folder.branch.trim();
  if (!recorded || !live || recorded === live || live === folder.taskBaseBranch) return undefined;
  return { recorded, live };
}

/** Being created or removed, so it can't be worked in or acted on. */
export function folderBusy(folder: FolderData): boolean {
  return folder.phase !== undefined;
}

export function folderPhaseLabel(folder: FolderData): string | undefined {
  return folder.phase?.label;
}

export function gitCheckedLabel(computedAtMs: number | undefined, now: number): string | null {
  if (!computedAtMs) return null;
  const secs = Math.max(0, Math.round((now - computedAtMs) / 1000));
  if (secs < 60) return `checked ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `checked ${mins}m ago`;
  return `checked ${Math.round(mins / 60)}h ago`;
}

export function comparedBaseLabel(folder: Pick<FolderData, "comparedBase">): string {
  const base = folder.comparedBase?.trim();
  if (!base) return "main";
  return base.startsWith("origin/") ? base.slice("origin/".length) : base;
}

/** True when a repo's single folder should collapse into one rail header. */
export function isSoloRepo(r: RepoData): boolean {
  return r.folders.length === 1;
}

/** The rail minus its quiet checkouts, plus what was taken out. "Mark quiet"
 * is a hide, not a demotion, and it ignores the rail filter — under the
 * default `"all"` a filter-shaped quiet would do nothing at all. The checkout
 * you are working in is never taken, and `show` (the rail header's toggle)
 * puts them all back. `quietDirs` reports the marks either way, so a row shown
 * anyway can still say it is quiet, and the header can count them. */
export function partitionQuiet(
  repos: RepoData[],
  args: { show: boolean; activeFolderDir: string | null },
): { shown: RepoData[]; quietDirs: Map<string, Set<string>>; quietCount: number } {
  const quietDirs = new Map<string, Set<string>>();
  let quietCount = 0;
  for (const r of repos) {
    const dirs = new Set(
      r.folders.filter((f) => f.quiet && f.dir !== args.activeFolderDir).map((f) => f.dir),
    );
    if (dirs.size === 0) continue;
    quietDirs.set(r.key, dirs);
    quietCount += dirs.size;
  }
  if (args.show || quietCount === 0) return { shown: repos, quietDirs, quietCount };
  const shown = repos
    .map((r) => {
      const dirs = quietDirs.get(r.key);
      return dirs ? { ...r, folders: r.folders.filter((f) => !dirs.has(f.dir)) } : r;
    })
    .filter((r) => r.folders.length > 0);
  return { shown, quietDirs, quietCount };
}

/** The rail narrowed to what a typed query matches. A repo matched by *name*
 * keeps every checkout — you asked for the repo, not one branch in it. Branch
 * and the de-slugged title count, since that is what a worktree row reads as;
 * paths don't, or every `~/code/p` checkout would answer to "p". */
export function searchRepos(repos: RepoData[], query: string): RepoData[] {
  if (isEmptyQuery(query)) return repos;
  const kept: RepoData[] = [];
  for (const r of repos) {
    if (matchesFilter(query, r.name)) {
      kept.push(r);
      continue;
    }
    const folders = r.folders.filter((f) =>
      matchesFilter(query, f.name, [f.branch, humanizeFolderName(f.name)]),
    );
    if (folders.length > 0) kept.push({ ...r, folders });
  }
  return kept;
}

/** Grace after the last sign of agent life, so stopping a session doesn't make
 * a folder vanish from the rail the same instant. */
export const IDLE_GRACE_MS = 45 * 60_000;

function folderLastActivityAt(f: FolderData): number {
  let last = 0;
  for (const s of f.sessions) {
    for (const ev of [s.agentState, ...s.agents]) {
      if (!ev) continue;
      last = Math.max(last, ev.ts, ev.details?.lastActivityAt ?? 0);
    }
  }
  return last;
}

/** Nothing here needs attention: no live or eye-catching session, nothing
 * unpushed or dirty, and no agent activity inside `IDLE_GRACE_MS`. The rail
 * *filter*'s question — {@link FolderData.quiet}, the hand mark, is not part of
 * it: that one hides the checkout outright, whatever the filter says. */
export function isFolderIdle(f: FolderData, now: number): boolean {
  return (
    liveSessions(f).length === 0 &&
    f.uncommittedFiles === 0 &&
    f.commitsAhead === 0 &&
    f.sessions.every((s) => !sessionCatchesEye(s)) &&
    now - folderLastActivityAt(f) >= IDLE_GRACE_MS
  );
}

/** {@link FolderData.workedAtMs} plus the agent activity only the client sees. */
export function folderLastWorkedAt(f: FolderData): number {
  return Math.max(folderLastActivityAt(f), f.workedAtMs ?? 0);
}

/** Whether a folder falls outside the "worked in the last `hours` hours" window. */
export function isFolderStale(f: FolderData, now: number, hours: number): boolean {
  if (liveSessions(f).length > 0) return false;
  return now - folderLastWorkedAt(f) >= hours * 3_600_000;
}

/** Whether this folder demotes to the per-repo "N unmanaged" stub row. Agents
 * mint worktrees of their own, so a busy fleet buries the rail under folders
 * nobody asked for — but a live session, something waiting on you or a
 * create/remove in flight outranks the stub, so no worktree that wants a person
 * is folded away. */
export function isFolderUnmanaged(f: FolderData): boolean {
  if (!folderIsUnclaimed(f) || folderBusy(f)) return false;
  return (
    liveSessions(f).length === 0 && f.needs === 0 && f.sessions.every((s) => !sessionCatchesEye(s))
  );
}

/** A stub row's contents leave the list until the stub is peeked open — the one
 * answer for the render (`RepoGroup`). */
export function withoutFolded(
  folders: FolderData[],
  folded: Set<string> | undefined,
  revealed: boolean,
): FolderData[] {
  if (!folded || revealed) return folders;
  return folders.filter((f) => !folded.has(f.dir));
}

/** Whether `filter` demotes this folder to the per-repo "N idle" stub row. */
export function isFolderFiltered(
  f: FolderData,
  filter: RailFilter,
  now: number,
  recentHours: number,
): boolean {
  // Always on the rail: it is where a session with no repo goes.
  if (folderIsHome(f)) return false;
  switch (filter) {
    case "all":
      return false;
    case "active":
      return isFolderIdle(f, now);
    case "recent":
      return isFolderStale(f, now, recentHours);
  }
}

export function pathScope(dir: string): string | null {
  const m = dir.match(/\/code\/([a-z])\//);
  return m ? `${m[1]}/` : null;
}

/** PR rows carry gh's `owner/name`, which both https and ssh origins contain. */
export function ownerRepoFromOrigin(originUrl: string | null | undefined): string | undefined {
  if (!originUrl) return undefined;
  const match = originUrl.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

export function prForFolder(
  prs: PrItem[],
  originUrl: string | null | undefined,
  branch: string,
): PrItem | undefined {
  if (!branch) return undefined;
  const origin = originUrl?.toLowerCase();
  return prs.find((p) => p.branch === branch && (!origin || origin.includes(p.repo.toLowerCase())));
}

/** The one link from a rail folder back to its board task, via `worktree.dir`. */
export function taskForFolder(tasks: TaskItem[], dir: string): TaskItem | undefined {
  return tasks.find((t) => t.worktree?.dir === dir);
}

export function issuesForFolder(tasks: TaskItem[], dir: string): TaskIssueLink[] {
  return taskForFolder(tasks, dir)?.issues ?? [];
}
