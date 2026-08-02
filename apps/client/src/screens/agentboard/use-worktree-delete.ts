import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  liveSessions,
  type BlockedDelete,
  type RemoveTarget,
  type RepoData,
} from "@/lib/agentboard";
import { taskDelete, type TaskItem, type TaskOutcome } from "@/lib/data";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

export type WorktreeDelete = {
  requestDeleteWorktree: (dir: string, label: string) => void;
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
  tasks: TaskItem[];
  expectedKills: React.RefObject<Set<string>>;
  onSessionRemoved: (sessionId: string) => void;
}): WorktreeDelete {
  const { repos, tasks, expectedKills, onSessionRemoved } = args;

  const [confirmDeleteWt, setConfirmDeleteWt] = useState<RemoveTarget | null>(null);
  const [deleteWtTask, setDeleteWtTask] = useState<TaskItem | null>(null);
  const [deleteWtOutcome, setDeleteWtOutcome] = useState<TaskOutcome>("done");
  const [deleteWtForce, setDeleteWtForce] = useState(false);
  const [blockedDelete, setBlockedDelete] = useState<BlockedDelete | null>(null);
  const [stoppingPort, setStoppingPort] = useState<number | null>(null);
  const [deletingDirs, setDeletingDirs] = useState<Set<string>>(new Set());

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
    setConfirmDeleteWt({ label, dirs: [dir], sessionIds, dirMissing: folder?.dirMissing });
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
    // Claim these deaths first — Rust kills the PTYs while the panes are mounted,
    // so exits arrive as crashes. Unused claims are handed back below.
    for (const id of target.sessionIds) expectedKills.current.add(id);
    const removed = await taskDelete({ dir }, { force, outcome });
    // Cancelled or forced past while the call ran: a stale result must not
    // resurrect the dialog, but the `deletingDirs` release below still must run.
    const current = deleteFlowOf(dir) === flow;
    if (removed.isErr() || removed.value.status === "blocked") {
      for (const id of target.sessionIds) expectedKills.current.delete(id);
    }
    removed.match({
      ok: (verdict) => {
        if (verdict.status === "blocked") {
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
        for (const id of target.sessionIds) onSessionRemoved(id);
        for (const message of verdict.messages) toast(message);
        toast.success(
          target.dirMissing
            ? `Closed ${verdict.name || target.label}`
            : `Deleted worktree ${verdict.name || target.label}`,
        );
      },
      err: (e) => {
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
    const stopped = await invoke<string>("task_stop_port", { dir, port });
    if (stopped.isErr()) {
      toast.error(stopped.error.message);
    } else {
      toast.success(stopped.value);
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
