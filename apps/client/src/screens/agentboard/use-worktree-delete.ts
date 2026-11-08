import { Result } from "effect";
import { useRef, useState } from "react";
import { toast } from "@/lib/toast";
import type { BlockedDelete, RemoveTarget } from "@/lib/agentboard/actions";
import { prForFolder } from "@/lib/agentboard/folder";
import {
  blockerShortLabel,
  folderDiscardable,
  landingSummaryForDir,
  type TaskBlocker,
} from "@/lib/agentboard/landing";
import { liveSessions } from "@/lib/agentboard/session";
import type { RepoData } from "@/lib/agentboard/types";
import { taskDelete, type PrItem, type TaskItem, type TaskOutcome } from "@/lib/data";
import { invoke, runIpc } from "@/lib/tauri";
import { hudNote } from "@/lib/rail-hud";
import { uiAction } from "@/lib/ui-action";

export type WorktreeDelete = {
  requestDeleteWorktree: (dir: string, label: string) => void;
  /** Delete a worktree that holds no work, with no dialog: the guards still run. */
  discardWorktree: (dir: string, label: string) => void;
  /** Dir → what refused its last delete, so the rail can say so at rest. */
  blockedByDir: ReadonlyMap<string, TaskBlocker[]>;
  confirmDeleteWorktree: () => void;

  confirmDeleteWt: RemoveTarget | null;
  clearConfirm: () => void;
  deleteWtTask: TaskItem | null;
  deleteWtOutcome: TaskOutcome;
  swapOutcome: () => void;
  deleteWtForce: boolean;
  setDeleteWtForce: (force: boolean) => void;

  blockedDelete: BlockedDelete | null;
  blockedDeleteDir: string | undefined;
  blockedRemovalInFlight: boolean;
  deleteBusy: boolean;
  stoppingPort: number | null;
  endDeleteFlow: (dir: string | undefined) => void;
  stopPortAndRetry: (blocked: BlockedDelete, port: number) => Promise<void>;
  forceDeleteBlocked: () => void;
  performDeleteWorktree: (
    target: RemoveTarget,
    options?: { force?: boolean; outcome?: TaskOutcome },
  ) => Promise<void>;
};

/** Confirm → guarded removal → blocked-with-remedies → retry. Rust returns a
 * dirty tree, unreachable commits or a foreign port as reasons, not a deletion. */
export function useWorktreeDelete(args: {
  repos: RepoData[];
  prs: PrItem[];
  tasks: TaskItem[];
}): WorktreeDelete {
  const { repos, prs, tasks } = args;

  const [confirmDeleteWt, setConfirmDeleteWt] = useState<RemoveTarget | null>(null);
  const [deleteWtTask, setDeleteWtTask] = useState<TaskItem | null>(null);
  const [deleteWtOutcome, setDeleteWtOutcome] = useState<TaskOutcome>("done");
  const [deleteWtForce, setDeleteWtForce] = useState(false);
  const [blockedDelete, setBlockedDelete] = useState<BlockedDelete | null>(null);
  const [stoppingPort, setStoppingPort] = useState<number | null>(null);
  const [deletingDirs, setDeletingDirs] = useState<Set<string>>(new Set());
  const [blockedByDir, setBlockedByDir] = useState<ReadonlyMap<string, TaskBlocker[]>>(new Map());

  function recordBlockers(dir: string, blockers: TaskBlocker[] | null) {
    setBlockedByDir((prev) => {
      if (!blockers && !prev.has(dir)) return prev;
      const next = new Map(prev);
      if (blockers) next.set(dir, blockers);
      else next.delete(dir);
      return next;
    });
  }

  // Generation per dir, bumped on every start and end, so an attempt resolving
  // after the user moved on can tell it's stale and not reopen a closed dialog.
  const deleteFlows = useRef(new Map<string, number>());
  const deleteFlowOf = (dir: string) => deleteFlows.current.get(dir) ?? 0;
  const bumpDeleteFlow = (dir: string) => deleteFlows.current.set(dir, deleteFlowOf(dir) + 1);

  function requestDeleteWorktree(dir: string, label: string) {
    const folder = repos.flatMap((r) => r.folders).find((f) => f.dir === dir);
    const sessionIds = folder ? liveSessions(folder).map((s) => s.id) : [];
    // Always `done`, never inferred from the linked PR: its cached state lags a
    // just-merged PR by a poll tick and would silently say "abandoned".
    const bound = tasks.find((t) => t.worktree?.dir === dir) ?? null;
    setDeleteWtTask(bound);
    setDeleteWtOutcome("done");
    // Never sticky: a waiver granted for one worktree must not carry to the next.
    setDeleteWtForce(false);
    bumpDeleteFlow(dir);
    setConfirmDeleteWt({
      label,
      dirs: [dir],
      sessionIds,
      dirMissing: folder?.dirMissing,
      baseBranch: folder?.baseBranch,
      landing: landingSummaryForDir(repos, prs, dir),
    });
  }

  function discardWorktree(dir: string, label: string) {
    const folder = repos.flatMap((r) => r.folders).find((f) => f.dir === dir);
    // Re-judged against the latest poll, not the render that armed the box: work
    // that landed since goes through the dialog that says what would be lost.
    const repo = repos.find((r) => r.folders.some((f) => f.dir === dir));
    const pr = folder && repo ? prForFolder(prs, repo.originUrl, folder.branch) : undefined;
    if (!folder || !folderDiscardable(folder, pr)) {
      requestDeleteWorktree(dir, label);
      return;
    }
    // It never got work, so the task it stood for was abandoned, not done.
    const bound = tasks.find((t) => t.worktree?.dir === dir);
    uiAction("agentboard.discard_worktree", "agentboard", bound ? "abandoned" : "no-task");
    bumpDeleteFlow(dir);
    void performDeleteWorktree(
      {
        label,
        dirs: [dir],
        // Its shells die with it, so claim those exits before Rust kills them.
        sessionIds: folder ? liveSessions(folder).map((s) => s.id) : [],
        baseBranch: folder?.baseBranch,
        landing: landingSummaryForDir(repos, prs, dir),
      },
      { outcome: bound ? "abandoned" : undefined },
    );
  }

  function confirmDeleteWorktree() {
    if (!confirmDeleteWt) return;
    // The same event as forcing past the blocked dialog: both are "the user
    // waived the guards", and splitting them would split that count in two.
    const force = deleteWtForce && !confirmDeleteWt.dirMissing;
    uiAction(
      force ? "agentboard.force_delete_worktree" : "agentboard.delete_worktree",
      "agentboard",
      deleteWtTask ? deleteWtOutcome : "no-task",
    );
    void performDeleteWorktree(confirmDeleteWt, {
      force,
      outcome: deleteWtTask ? deleteWtOutcome : undefined,
    });
    setConfirmDeleteWt(null);
  }

  function endDeleteFlow(dir: string | undefined) {
    if (dir !== undefined) bumpDeleteFlow(dir);
    setBlockedDelete(null);
  }

  async function performDeleteWorktree(
    target: RemoveTarget,
    { force = false, outcome }: { force?: boolean; outcome?: TaskOutcome } = {},
  ) {
    // Sessions are torn down only on success: closing them here would untrack
    // them even when blocked, leaving the rail clean but the worktree on disk.
    const dir = target.dirs[0];
    const flow = deleteFlowOf(dir);
    setDeletingDirs((prev) => new Set(prev).add(dir));
    const removed = await taskDelete({ dir }, { force, outcome });
    // Cancelled or forced past while the call ran: a stale result must not
    // resurrect the dialog, but the `deletingDirs` release below still must run.
    const current = deleteFlowOf(dir) === flow;
    Result.match(removed, {
      onSuccess: (verdict) => {
        if (verdict.status === "blocked") {
          recordBlockers(dir, verdict.blockers);
          const first = verdict.blockers[0];
          hudNote(
            first
              ? `Delete of ${target.label} blocked: ${blockerShortLabel(first)}`
              : `Delete of ${target.label} blocked`,
            "warn",
          );
          if (current)
            setBlockedDelete({
              target,
              name: verdict.name,
              outcome,
              blockers: verdict.blockers,
              messages: verdict.messages,
            });
          return;
        }
        endDeleteFlow(dir);
        recordBlockers(dir, null);
        for (const message of verdict.messages) toast(message);
        const done = target.dirMissing
          ? `Closed ${verdict.name || target.label}`
          : `Deleted worktree ${verdict.name || target.label}`;
        toast.success(done);
        hudNote(done, "ok");
      },
      onFailure: (e) => {
        hudNote(`Delete of ${target.label} failed: ${e.message}`, "danger");
        if (current) toast.error(e.message);
      },
    });
    setDeletingDirs((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
  }

  // The `foreignPort` remedy. `task_stop_port` refuses ports the task doesn't
  // claim, and returns only once free, so the retry can't race the release.
  async function stopPortAndRetry(blocked: BlockedDelete, port: number) {
    const dir = blocked.target.dirs[0];
    // Captured before the seconds-long stop: reading it after the await would
    // see the post-cancel value and delete a worktree the user chose to keep.
    const flow = deleteFlowOf(dir);
    setStoppingPort(port);
    const stopped = await runIpc(invoke<string>("task_stop_port", { dir, port }));
    if (Result.isFailure(stopped)) {
      toast.error(stopped.failure.message);
    } else {
      toast.success(stopped.success);
      if (deleteFlowOf(dir) === flow)
        await performDeleteWorktree(blocked.target, { outcome: blocked.outcome });
    }
    // Released only after the retry: clearing it sooner would let a second
    // row's "Stop it" start an overlapping removal of the same worktree.
    setStoppingPort(null);
  }

  const blockedDeleteDir = blockedDelete?.target.dirs[0];
  const blockedRemovalInFlight = blockedDeleteDir != null && deletingDirs.has(blockedDeleteDir);
  const deleteBusy = stoppingPort !== null || blockedRemovalInFlight;

  function forceDeleteBlocked() {
    // `deleteBusy` is what makes the mod+shift+Enter binding safe to hold: a
    // shortcut ignoring it could start a second removal of the same worktree.
    if (!blockedDelete || deleteBusy) return;
    const { target, outcome } = blockedDelete;
    uiAction("agentboard.force_delete_worktree", "agentboard", outcome ?? "no-task");
    endDeleteFlow(blockedDeleteDir);
    void performDeleteWorktree(target, { force: true, outcome });
  }

  return {
    requestDeleteWorktree,
    discardWorktree,
    blockedByDir,
    confirmDeleteWorktree,
    confirmDeleteWt,
    clearConfirm: () => setConfirmDeleteWt(null),
    deleteWtTask,
    deleteWtOutcome,
    swapOutcome: () => setDeleteWtOutcome((cur) => (cur === "done" ? "abandoned" : "done")),
    deleteWtForce,
    setDeleteWtForce,
    blockedDelete,
    blockedDeleteDir,
    blockedRemovalInFlight,
    deleteBusy,
    stoppingPort,
    endDeleteFlow,
    stopPortAndRetry,
    forceDeleteBlocked,
    performDeleteWorktree,
  };
}
