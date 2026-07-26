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
  /** Ask to delete a worktree — always confirms (it deletes from disk). */
  requestDeleteWorktree: (dir: string, label: string) => void;
  /** Confirms the close-task dialog (button click *and* the
   * mod+shift+Enter shortcut, so the two paths can't drift — telemetry
   * included). */
  confirmDeleteWorktree: () => void;
  /** Folder dirs mid-delete — the rail dims/disables those rows. */
  deletingDirs: Set<string>;
  /** Live phase text per dir mid-delete ("deleting git worktree", …). */
  deletingPhase: Map<string, string>;
  /** Record a `task://delete_progress` event for a dir. */
  setDeletePhase: (dir: string, label: string) => void;

  // Confirm dialog
  confirmDeleteWt: RemoveTarget | null;
  clearConfirm: () => void;
  /** The board task bound to the worktree being deleted (null = none on the
   * board) and the outcome the close will record. */
  deleteWtTask: TaskItem | null;
  deleteWtOutcome: TaskOutcome;
  swapOutcome: () => void;

  // Blocked dialog
  blockedDelete: BlockedDelete | null;
  blockedDeleteDir: string | undefined;
  /** The removal itself (as opposed to the port stop before it) is running —
   * "Keep the worktree" can no longer be honored, so the cancel affordances
   * lock rather than promising an undo they can't do. */
  blockedRemovalInFlight: boolean;
  /** Any blocked-dialog action in flight — a port stop, or the removal that
   * follows it. Every button in that dialog ends in a removal of the same
   * worktree, so they share one gate rather than each disabling only itself. */
  deleteBusy: boolean;
  /** The port whose "Stop it" is in flight, held until the follow-up removal
   * finishes too, so the whole dialog is inert for the duration. */
  stoppingPort: number | null;
  /** Abandon the flow for `dir`: closes the blocked dialog and invalidates any
   * still-in-flight attempt. Every exit from the blocked dialog goes here. */
  endDeleteFlow: (dir: string | undefined) => void;
  stopPortAndRetry: (blocked: BlockedDelete, port: number) => Promise<void>;
  /** Delete anyway from the blocked dialog — its destructive button *and* the
   * same mod+shift+Enter that confirmed the first dialog, so the two paths
   * can't drift. Inert while an action is in flight, mirroring the button's
   * own disabled state; a no-op when no blocked dialog is open. */
  forceDeleteBlocked: () => void;
  /** `force` skips every guard — only ever passed from the blocked dialog's
   * force button, which names what's being discarded. */
  performDeleteWorktree: (
    target: RemoveTarget,
    options?: { force?: boolean; outcome?: TaskOutcome },
  ) => Promise<void>;
};

/**
 * Deleting a worktree from disk, end to end: confirm → guarded removal →
 * blocked-with-remedies → retry.
 *
 * The Rust side's guards protect real work — a dirty tree, commits unreachable
 * from any branch/remote, or a foreign listener on a claimed port come back as
 * *reasons* rather than a deletion, and the blocked dialog offers each one's
 * remedy. Everything here exists to keep that conversation coherent across
 * calls that take seconds.
 */
export function useWorktreeDelete(args: {
  repos: RepoData[];
  /** Board tasks — to find the row bound to the worktree being deleted. */
  tasks: TaskItem[];
  /** Sessions whose shell we're about to kill on purpose (`task_delete` kills
   * a folder's PTYs in Rust while the panes are still mounted, so those deaths
   * arrive as crashes at a still-listening TerminalView). */
  expectedKills: React.RefObject<Set<string>>;
  /** Tear down this screen's local pane state for a session the removal killed. */
  onSessionRemoved: (sessionId: string) => void;
}): WorktreeDelete {
  const { repos, tasks, expectedKills, onSessionRemoved } = args;

  const [confirmDeleteWt, setConfirmDeleteWt] = useState<RemoveTarget | null>(null);
  const [deleteWtTask, setDeleteWtTask] = useState<TaskItem | null>(null);
  const [deleteWtOutcome, setDeleteWtOutcome] = useState<TaskOutcome>("done");
  const [blockedDelete, setBlockedDelete] = useState<BlockedDelete | null>(null);
  const [stoppingPort, setStoppingPort] = useState<number | null>(null);
  const [deletingDirs, setDeletingDirs] = useState<Set<string>>(new Set());
  const [deletingPhase, setDeletingPhase] = useState<Map<string, string>>(new Map());

  // Generation counter per worktree dir. Bumped when a dir's flow starts and
  // whenever one ends (cancel, force, success), so an attempt that resolves
  // after the user moved on can tell it's stale — a `task_stop_port` plus
  // retry runs for seconds, and without this a removal returning "blocked"
  // would pop the dialog back open after it was dismissed. Scoped per dir
  // rather than one global counter so starting a delete on a second worktree
  // can't silently swallow the first one's still-in-flight outcome.
  const deleteFlows = useRef(new Map<string, number>());
  const deleteFlowOf = (dir: string) => deleteFlows.current.get(dir) ?? 0;
  const bumpDeleteFlow = (dir: string) => deleteFlows.current.set(dir, deleteFlowOf(dir) + 1);

  const setDeletePhase = (dir: string, label: string) =>
    setDeletingPhase((prev) => new Map(prev).set(dir, label));

  function requestDeleteWorktree(dir: string, label: string) {
    const folder = repos.flatMap((r) => r.folders).find((f) => f.dir === dir);
    const sessionIds = folder ? liveSessions(folder).map((s) => s.id) : [];
    // The bound board task, if the board knows this worktree: deleting the
    // worktree closes it, so the dialog asks how it ended. Defaults to
    // `done` — the common case — rather than inferring from the linked PR's
    // cached state, which can lag a just-merged PR by a full poll tick and
    // silently default to "abandoned". The user flips it via the dialog's
    // swap link on the (rarer) actually-abandoned case.
    const bound = tasks.find((t) => t.worktree?.dir === dir) ?? null;
    setDeleteWtTask(bound);
    setDeleteWtOutcome("done");
    bumpDeleteFlow(dir); // a fresh flow — see `endDeleteFlow`
    setConfirmDeleteWt({ label, dirs: [dir], sessionIds });
  }

  function confirmDeleteWorktree() {
    if (!confirmDeleteWt) return;
    uiAction(
      "agentboard.delete_worktree",
      "agentboard",
      deleteWtTask ? deleteWtOutcome : "no-task",
    );
    void performDeleteWorktree(confirmDeleteWt, {
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
    // `task_delete` kills the folder's live PTYs itself — only once the
    // guards have passed and the removal is really happening, so a refusal
    // costs nothing — and only tears down the session records once removal
    // actually succeeds; closing sessions here first would untrack them even
    // when removal is blocked (dirty tree, unpushed commits, a foreign
    // port), leaving the rail looking clean while the worktree stays on
    // disk. `deletingDirs` dims/disables the rail's row for this dir while
    // the (possibly slow — git checks, docker cleanup) call is in flight, so
    // it can't be clicked into or deleted twice; cleared at the end so a
    // blocked/failed removal leaves the row interactive again.
    const dir = target.dirs[0];
    const flow = deleteFlowOf(dir);
    setDeletingDirs((prev) => new Set(prev).add(dir));
    // Claim these deaths before asking for them — when removal proceeds, the
    // kill happens in Rust while the panes are still mounted, so the exits
    // come back as crashes. A blocked/failed attempt kills nothing, so the
    // unconsumed claims are handed back below — otherwise they'd linger and
    // silently swallow a later genuine crash of the same session.
    for (const id of target.sessionIds) expectedKills.current.add(id);
    const removed = await taskDelete({ dir }, { force, outcome });
    // The user may have cancelled, or forced past this, while the call ran.
    // A stale result must not resurrect the dialog or re-report an outcome
    // for a flow that's over — but the `deletingDirs` release below still has
    // to run, or the rail row stays dimmed forever.
    const current = deleteFlowOf(dir) === flow;
    if (removed.isErr() || removed.value.status === "blocked") {
      // Nothing was removed, so no PTY was killed — return the claims.
      for (const id of target.sessionIds) expectedKills.current.delete(id);
    }
    removed.match({
      ok: (verdict) => {
        // Refused, not failed: hand the reasons to the dialog that can act on
        // them rather than a toast that can only be dismissed.
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
        toast.success(`Deleted worktree ${verdict.name || target.label}`);
      },
      // A genuine failure (bad path, broken worktree, git fell over) — there
      // is no remedy to offer, so this stays a toast.
      err: (e) => {
        if (current) toast.error(e.message);
      },
    });
    setDeletingDirs((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
    // Blocked/failed leaves the row interactive again — its last phase text
    // must go with it, or a later delete attempt on the same dir would
    // briefly show a stale label from this attempt before its own first
    // event lands.
    setDeletingPhase((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
  }

  // Clear a stale dev server off one of the task's claimed ports, then retry
  // the delete — the remedy for a `foreignPort` blocker, so the whole flow
  // finishes where it started instead of sending the user to a terminal.
  // `task_stop_port` refuses any port the task doesn't claim in its `.env`,
  // and only returns once the port is actually free, so the retry can't race
  // the socket's release.
  async function stopPortAndRetry(blocked: BlockedDelete, port: number) {
    const dir = blocked.target.dirs[0];
    // Captured before the stop runs (it takes seconds — SIGTERM, wait,
    // maybe SIGKILL): "Keep the worktree" stays clickable during it, and a
    // cancel bumps the flow, so this is what lets the check below actually
    // see the cancel. Capturing after the await would always read the
    // post-cancel value and retry anyway — deleting a worktree the user
    // just chose to keep.
    const flow = deleteFlowOf(dir);
    setStoppingPort(port);
    const stopped = await invoke<string>("task_stop_port", { dir, port });
    if (stopped.isErr()) {
      toast.error(stopped.error.message);
    } else {
      // The stop really happened, so it's reported even if the user has
      // moved on — but the retry is theirs to want, not ours to assume.
      toast.success(stopped.value);
      // Re-run the guarded removal: the port is free now, but a dirty tree or
      // unreachable commits may still (correctly) block, in which case the
      // dialog just re-renders with one fewer reason. A port that was already
      // free comes back `Ok` too (the user may have quit the dev server
      // themselves after reading the blocker), so that also lands here rather
      // than dead-ending on an error toast.
      if (deleteFlowOf(dir) === flow)
        await performDeleteWorktree(blocked.target, { outcome: blocked.outcome });
    }
    // Released only now, after the retry: clearing it before would re-enable
    // this row's button while the removal is still running, letting a second
    // row's "Stop it" start an overlapping removal of the same worktree.
    setStoppingPort(null);
  }

  const blockedDeleteDir = blockedDelete?.target.dirs[0];
  const blockedRemovalInFlight = blockedDeleteDir != null && deletingDirs.has(blockedDeleteDir);
  const deleteBusy = stoppingPort !== null || blockedRemovalInFlight;

  function forceDeleteBlocked() {
    // The busy check is what makes the keystroke safe to hold: the button is
    // disabled mid-stop/mid-removal, and a shortcut that ignored that could
    // start a second removal of the same worktree.
    if (!blockedDelete || deleteBusy) return;
    const { target, outcome } = blockedDelete;
    uiAction("agentboard.force_delete_worktree", "agentboard", outcome ?? "no-task");
    endDeleteFlow(blockedDeleteDir);
    void performDeleteWorktree(target, { force: true, outcome });
  }

  return {
    requestDeleteWorktree,
    confirmDeleteWorktree,
    deletingDirs,
    deletingPhase,
    setDeletePhase,
    confirmDeleteWt,
    clearConfirm: () => setConfirmDeleteWt(null),
    deleteWtTask,
    deleteWtOutcome,
    swapOutcome: () => setDeleteWtOutcome((cur) => (cur === "done" ? "abandoned" : "done")),
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
