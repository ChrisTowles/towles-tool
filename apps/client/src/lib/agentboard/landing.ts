import type { PrItem } from "@/lib/data";
import type { TaskBlockerSchema } from "@/lib/schemas/task";
import { comparedBaseLabel, prForFolder } from "./folder";
import { folderPortDrift } from "./session";
import type { FolderData, RepoData } from "./types";

/** A pure git fact, and only *half* of {@link folderSafeToDelete}'s gate. */
export function folderHoldsNoWork(folder: Pick<FolderData, "dirty" | "commitsUnlanded">): boolean {
  return !folder.dirty && folder.commitsUnlanded === 0;
}

/** Safe to delete: its PR merged, *and* nothing here would be lost. */
export function folderSafeToDelete(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return pr?.state === "merged" && folderHoldsNoWork(folder);
}

/** A worktree that never got work: no commits past its base, a clean tree, no
 * agent in it and no PR in flight. Deleting it loses nothing, so the rail
 * offers that at rest — where {@link folderSafeToDelete} needs a merged PR.
 * A bare shell doesn't count: selecting a checkout opens one. */
export function folderDiscardable(
  folder: Pick<
    FolderData,
    "isWorktree" | "dirty" | "commitsAhead" | "commitsUnlanded" | "sessions"
  >,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  if (!folder.isWorktree || pr?.state === "open" || pr?.state === "merged") return false;
  if (folder.commitsAhead > 0 || !folderHoldsNoWork(folder)) return false;
  // A session started with a purpose is a task just begun, even before its agent registers.
  return !folder.sessions.some((s) => s.live && (s.agents.length > 0 || Boolean(s.purpose)));
}

/** Proven by git itself (merge, rebase or squash alike) or by a merged PR. */
export function folderLanded(
  folder: Pick<FolderData, "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folder.landed !== null || pr?.state === "merged";
}

/** Whether the delete-worktree affordances apply to a folder. */
export function folderRemovableTask(
  folder: Pick<FolderData, "record" | "isWorktree" | "dirMissing">,
): boolean {
  if (folder.record.origin === "home") return false;
  if (folder.record.origin !== "checkout") return true;
  return folder.isWorktree && !folder.dirMissing;
}

const TASK_BLOCKER_KINDS = ["dirtyTree", "unreachableCommits", "foreignPort"] as const;

export type TaskBlockerKind = (typeof TASK_BLOCKER_KINDS)[number];

export type TaskBlocker = typeof TaskBlockerSchema.Type;

/** What forcing past a blocker would discard, as a noun for the button. */
const DISCARDED: Record<string, string> = {
  dirtyTree: "changes",
  unreachableCommits: "commits",
};

/** The last refusal's blockers that the folder's current facts still bear out:
 * committing or cleaning up clears the badge without a retry. A port can't be
 * re-checked from here, so it stands until the next attempt. */
export function stillBlocking(
  blockers: TaskBlocker[],
  folder: Pick<FolderData, "dirty" | "commitsUnlanded">,
): TaskBlocker[] {
  return blockers.filter((b) => {
    if (b.kind === "dirtyTree") return folder.dirty;
    if (b.kind === "unreachableCommits") return folder.commitsUnlanded > 0;
    return true;
  });
}

/** A blocker named in the few words a rail box has room for. */
export function blockerShortLabel(blocker: Pick<TaskBlocker, "kind" | "message" | "port">): string {
  if (blocker.kind === "dirtyTree") return "uncommitted changes";
  if (blocker.kind === "unreachableCommits") return "unpushed commits";
  if (blocker.kind === "foreignPort")
    return typeof blocker.port === "number" ? `port ${blocker.port} in use` : "port in use";
  return blocker.message;
}

/** Label for the force button in the blocked-delete dialog. */
export function forceDeleteLabel(blockers: TaskBlocker[]): string {
  const nouns = blockers
    .filter((b) => b.losesWork)
    .map((b) => DISCARDED[b.kind])
    .filter((noun): noun is string => noun !== undefined);
  const unique = [...new Set(nouns)];
  return unique.length > 0 ? `Delete and discard the ${unique.join(" and ")}` : "Delete anyway";
}

/** The port this blocker offers to clear, or `null` when there's nothing to act on. */
export function stoppablePort(blocker: TaskBlocker): number | null {
  if (blocker.kind !== "foreignPort") return null;
  return typeof blocker.port === "number" ? blocker.port : null;
}

/** Landed, yet the checkout still holds uncommitted or unlanded work. */
export function folderLandedButHasWork(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded" | "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folderLanded(folder, pr) && !folderHoldsNoWork(folder);
}

/** Where a checkout's branch stands against its base, in one line. */
export type LandingSummary = {
  /** Same gate as {@link folderLanded}: only then is the full diff worth reading. */
  landed: boolean;
  text: string;
  /** The PR's page, where GitHub shows the merge commit; only with a PR. */
  url?: string;
};

/** The "Safe to delete" callout's lead, and what every close dialog leads with. */
export function folderLandingSummary(
  folder: Pick<FolderData, "landed" | "comparedBase">,
  pr: Pick<PrItem, "state" | "number" | "url"> | undefined,
): LandingSummary {
  const base = comparedBaseLabel(folder);
  const via = folder.landed ? `${folder.landed} into ${base}` : null;
  const landed = folderLanded(folder, pr);
  if (!pr) return { landed, text: via ?? `Not merged into ${base}` };
  const { url } = pr;
  if (pr.state === "merged") {
    return {
      landed,
      text: via ? `PR #${pr.number} merged, ${via}` : `PR #${pr.number} merged`,
      url,
    };
  }
  const state = pr.state === "open" ? "open" : `${pr.state}, unmerged`;
  return {
    landed,
    text: via ? `PR #${pr.number} ${state}, ${via}` : `PR #${pr.number} ${state}, not in ${base}`,
    url,
  };
}

/** {@link folderLandingSummary} for a checkout found by dir, `undefined` when
 * the rail doesn't track it. */
export function landingSummaryForDir(
  repos: RepoData[],
  prs: PrItem[],
  dir: string,
): LandingSummary | undefined {
  for (const repo of repos) {
    const folder = repo.folders.find((f) => f.dir === dir);
    if (folder)
      return folderLandingSummary(folder, prForFolder(prs, repo.originUrl, folder.branch));
  }
  return undefined;
}

/** A per-folder actionable signal. */
export type ActionableKind = "safe-to-delete" | "needs-you" | "port-drift";

export type ActionableItem = {
  kind: ActionableKind;
  subtitle: string;
  pr?: Pick<PrItem, "number" | "url">;
};

/** The same gates the rail's badges use, in one list. */
export function folderActionableItems(
  folder: Pick<
    FolderData,
    "isWorktree" | "dirty" | "commitsUnlanded" | "landed" | "comparedBase" | "needs" | "sessions"
  >,
  pr: PrItem | undefined,
): ActionableItem[] {
  const items: ActionableItem[] = [];

  const merged = pr?.state === "merged" ? pr : undefined;
  if (merged && folder.isWorktree && folderSafeToDelete(folder, pr)) {
    items.push({
      kind: "safe-to-delete",
      subtitle: `${folderLandingSummary(folder, pr).text}, no uncommitted changes, every commit landed`,
      pr: { number: merged.number, url: merged.url },
    });
  }

  if (folder.needs > 0) {
    items.push({
      kind: "needs-you",
      subtitle: `${folder.needs} session${folder.needs === 1 ? "" : "s"} waiting on you`,
    });
  }

  const drift = folderPortDrift(folder);
  if (drift.length > 0) {
    items.push({
      kind: "port-drift",
      subtitle: drift.map((d) => `${d.key} ${d.spawnedPort} → ${d.currentPort}`).join(", "),
    });
  }

  return items;
}
