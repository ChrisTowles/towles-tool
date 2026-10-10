import {
  folderSafeToDelete,
  humanizeFolderName,
  type NeedsReason,
  ownerRepoFromOrigin,
  prForFolder,
  type RepoData,
  sessionSaid,
} from "./agentboard";
import type { PrItem } from "./data";

/** The Cockpit's work queue: every agent session and task the Agentboard says is
 * waiting on you, oldest first within each reason. Status is only *reported* —
 * a row reveals its session in Agentboard, it never acts on the agent. */

export type QueueReason = NeedsReason | "cleanup";

export type QueueItem = {
  id: string;
  reason: QueueReason;
  /** `owner/name` when the origin parses, so the Cockpit's repo filter applies. */
  repo: string;
  title: string;
  folderName: string;
  branch: string;
  folderDir: string;
  /** Absent for a task row, which reveals the folder rather than a session. */
  sessionId?: string;
  /** When it joined the queue; `undefined` sorts last within its reason. */
  sinceMs?: number;
};

/** Errored work is blocked, waiting work is a question, finished work is a review,
 * and a landed task only wants tidying. */
const REASON_ORDER: Record<QueueReason, number> = {
  errored: 0,
  waitingForInput: 1,
  finished: 2,
  cleanup: 3,
};

export function buildWorkQueue(repos: readonly RepoData[], prs: readonly PrItem[]): QueueItem[] {
  const items: QueueItem[] = [];
  for (const repo of repos) {
    const repoLabel = ownerRepoFromOrigin(repo.originUrl) ?? repo.name;
    for (const folder of repo.folders) {
      const folderName = folder.isWorktree ? humanizeFolderName(folder.name) : "Root";
      for (const session of folder.sessions) {
        if (session.needsReason == null) continue;
        items.push({
          id: `session:${session.id}`,
          reason: session.needsReason,
          repo: repoLabel,
          title: sessionSaid(session) ?? session.name,
          folderName,
          branch: folder.branch,
          folderDir: folder.dir,
          sessionId: session.id,
          sinceMs: session.needsSinceMs ?? undefined,
        });
      }
      const pr = prForFolder([...prs], repo.originUrl, folder.branch);
      if (folder.isWorktree && folderSafeToDelete(folder, pr)) {
        items.push({
          id: `cleanup:${folder.dir}`,
          reason: "cleanup",
          repo: repoLabel,
          title: pr ? `PR #${pr.number} merged — ready to remove` : "Landed — ready to remove",
          folderName,
          branch: folder.branch,
          folderDir: folder.dir,
          sinceMs: pr?.updatedTs,
        });
      }
    }
  }
  return items.toSorted(
    (a, b) =>
      REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
      (a.sinceMs ?? Infinity) - (b.sinceMs ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
}

/** The loop's next/previous stop: the queue's session rows in queue order, so
 * answering one and pressing next lands on the most urgent remaining item. A
 * session not in the queue (already answered) restarts from the head. */
export function cycleQueue(
  queue: readonly QueueItem[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): string | null {
  const ids = queue.flatMap((item) => (item.sessionId ? [item.sessionId] : []));
  if (ids.length === 0) return null;
  const from = fromSessionId ? ids.indexOf(fromSessionId) : -1;
  if (from === -1) return direction === "next" ? ids[0] : ids[ids.length - 1];
  const step = direction === "next" ? 1 : -1;
  return ids[(from + step + ids.length) % ids.length];
}
