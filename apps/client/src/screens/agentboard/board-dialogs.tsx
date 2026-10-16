import { BlockedDeleteDialog } from "@/components/task-blockers";
import type { RemoveTarget, StartClaudeTarget } from "@/lib/agentboard/actions";
import type { FolderData, SessionData } from "@/lib/agentboard/types";
import { shortcutHint } from "@/lib/shortcuts";
import {
  DeleteWorktreeDialog,
  RemoveRepoDialog,
  SplitSessionDialog,
  StartClaudeDialog,
} from "./dialogs";
import { closeOnFalse } from "./helpers";
import type { WorktreeDelete } from "./use-worktree-delete";

/** Every modal Agent Board can raise, kept apart from the screen that owns the
 * state behind them. */
export function BoardDialogs({
  split,
  remove,
  worktreeDelete,
  startClaude,
}: {
  split: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    folder: FolderData | undefined;
    candidates: SessionData[];
    onPick: (sessionId: string) => void;
  };
  remove: {
    target: RemoveTarget | null;
    onCancel: () => void;
    onConfirm: (target: RemoveTarget) => void;
  };
  worktreeDelete: WorktreeDelete;
  startClaude: {
    target: StartClaudeTarget | null;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  };
}) {
  return (
    <>
      <SplitSessionDialog
        open={split.open}
        onOpenChange={split.onOpenChange}
        folderName={split.folder?.name}
        candidates={split.candidates}
        onPick={split.onPick}
      />

      <RemoveRepoDialog
        target={remove.target}
        onOpenChange={closeOnFalse(remove.onCancel)}
        onConfirm={() => {
          if (remove.target) remove.onConfirm(remove.target);
          remove.onCancel();
        }}
      />

      <DeleteWorktreeDialog
        target={worktreeDelete.confirmDeleteWt}
        task={worktreeDelete.deleteWtTask}
        outcome={worktreeDelete.deleteWtOutcome}
        force={worktreeDelete.deleteWtForce}
        onOpenChange={closeOnFalse(worktreeDelete.clearConfirm)}
        onSwapOutcome={worktreeDelete.swapOutcome}
        onForceChange={worktreeDelete.setDeleteWtForce}
        onConfirm={worktreeDelete.confirmDeleteWorktree}
      />

      {/* The guards refused — shared shell, see `BlockedDeleteDialog`. */}
      <BlockedDeleteDialog
        open={worktreeDelete.blockedDelete != null}
        // Escape/cancel abandons the flow — except once the removal is running,
        // when "keep" can no longer be honored: the dialog stays up, buttons
        // locked, until the removal resolves and closes it honestly.
        onOpenChange={closeOnFalse(() => {
          if (!worktreeDelete.blockedRemovalInFlight)
            worktreeDelete.endDeleteFlow(worktreeDelete.blockedDeleteDir);
        })}
        name={worktreeDelete.blockedDelete?.name}
        landing={worktreeDelete.blockedDelete?.target.landing}
        description="The worktree is still on disk. Clear what’s below and it’ll delete cleanly, or delete anyway."
        cancelLabel="Keep the worktree"
        blockers={worktreeDelete.blockedDelete?.blockers ?? []}
        messages={worktreeDelete.blockedDelete?.messages ?? []}
        busy={worktreeDelete.deleteBusy}
        cancelDisabled={worktreeDelete.blockedRemovalInFlight}
        stoppingPort={worktreeDelete.stoppingPort}
        onStopPort={(port) => {
          const blocked = worktreeDelete.blockedDelete;
          if (blocked) void worktreeDelete.stopPortAndRetry(blocked, port);
        }}
        forceHint={shortcutHint("ab-confirm-close-worktree")}
        onForce={worktreeDelete.forceDeleteBlocked}
      />

      <StartClaudeDialog
        target={startClaude.target}
        prompt={startClaude.prompt}
        onPromptChange={startClaude.onPromptChange}
        onCommit={startClaude.onCommit}
        // Dismissing a fresh start launches with what's typed; dismissing a
        // start-over keeps the running agent, since that one kills it first.
        onOpenChange={closeOnFalse(
          startClaude.target?.restart ? startClaude.onCancel : startClaude.onCommit,
        )}
      />
    </>
  );
}
