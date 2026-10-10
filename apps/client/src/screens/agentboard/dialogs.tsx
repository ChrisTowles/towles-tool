import { useState } from "react";
import { TerminalWindowIcon } from "@phosphor-icons/react";
import { Button, Checkbox, CommandPalette, Dialog, Input } from "@cloudflare/kumo";
import {
  sessionLabel,
  type RemoveTarget,
  type SessionData,
  type StartClaudeTarget,
} from "@/lib/agentboard";
import type { TaskItem, TaskOutcome } from "@/lib/data";
import { withHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** ab-split-session picker: pick one of the active folder's not-yet-opened
 * sessions to add as a pane in its active window. */
export function SplitSessionDialog({
  open,
  onOpenChange,
  folderName,
  candidates,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderName?: string;
  candidates: SessionData[];
  onPick: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = candidates.filter((s) => sessionLabel(s).toLowerCase().includes(q));
  return (
    <CommandPalette.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
      items={rows}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={sessionLabel}
    >
      <CommandPalette.Input
        autoFocus
        placeholder={`Search sessions${folderName ? ` in ${folderName}` : ""}…`}
        autoComplete="off"
        spellCheck={false}
      />
      <CommandPalette.List className="max-h-[60vh]">
        <CommandPalette.Results>
          {(s: SessionData) => (
            <CommandPalette.Item key={s.id} value={s} onClick={() => onPick(s.id)}>
              <TerminalWindowIcon className="size-3.5 shrink-0 text-kumo-subtle" />
              <span className="flex-1 truncate">{sessionLabel(s)}</span>
            </CommandPalette.Item>
          )}
        </CommandPalette.Results>
        <CommandPalette.Empty>No sessions match.</CommandPalette.Empty>
      </CommandPalette.List>
    </CommandPalette.Root>
  );
}

/** Confirm removing a repo (or all its checkouts) from the rail when live
 * sessions would be stopped. */
export function RemoveRepoDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  target: RemoveTarget | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={target != null} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold">
            Remove {target?.label} from the rail?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {target?.sessionIds.length}{" "}
            {target?.sessionIds.length === 1 ? "session is" : "sessions are"} still running.
            Removing will stop {target?.sessionIds.length === 1 ? "it" : "them"}.
          </Dialog.Description>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button variant="primary" onClick={onConfirm}>
            Stop &amp; remove
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

/** A forced delete must never read as the guarded one it is nothing like. */
function confirmLabel(hasTask: boolean, dirMissing: boolean, outcome: TaskOutcome, force: boolean) {
  if (dirMissing) return `Close as ${outcome}`;
  if (hasTask) return force ? `Close as ${outcome} & force delete` : `Close as ${outcome}`;
  return force ? "Force delete" : "Delete worktree";
}

/** Confirm deleting a worktree from disk — and, when a board task is bound to
 * it, how that task ended (defaulted to done, with a swap link to abandoned).
 * `force` waives the guards up front, for when the answer is already known. */
export function DeleteWorktreeDialog({
  target,
  task,
  outcome,
  force,
  onOpenChange,
  onSwapOutcome,
  onForceChange,
  onConfirm,
}: {
  target: RemoveTarget | null;
  task: TaskItem | null;
  outcome: TaskOutcome;
  force: boolean;
  onOpenChange: (open: boolean) => void;
  onSwapOutcome: () => void;
  onForceChange: (force: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={target != null} onOpenChange={onOpenChange}>
      {/* Same width as the blocked-delete dialog it can hand off to, so the
          flow doesn't jump size mid-decision. */}
      <Dialog size="lg" className="flex max-w-xl flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold wrap-anywhere">
            {/* Nothing is on disk to delete — the whole operation is the
                bookkeeping, so the question is about the task, not a checkout
                that isn't there. */}
            {target?.dirMissing
              ? `Close task ${target?.label}?`
              : task
                ? `Close task & delete worktree ${target?.label}?`
                : `Delete worktree ${target?.label}?`}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-pretty text-kumo-subtle">
            {target?.dirMissing ? (
              <>
                This task's worktree is already gone, so nothing is deleted from disk. Its branch
                survives in the primary. The task stays on the board, closed.
              </>
            ) : force ? (
              <>
                Removes the checkout from disk with the guards off — uncommitted changes and commits
                on no branch/remote go with it, and a dev server on its ports is left running. Its
                branch survives in the primary.
                {task && " The task stays on the board, closed."}
              </>
            ) : (
              <>
                Removes the checkout from disk (guarded — uncommitted changes, commits on no
                branch/remote, or a dev server still on its ports will stop it and tell you what to
                do). Its branch survives in the primary.
                {task && " The task stays on the board, closed."}
              </>
            )}
            {target && target.sessionIds.length > 0 && (
              <>
                {" "}
                {target.sessionIds.length}{" "}
                {target.sessionIds.length === 1 ? "session is" : "sessions are"} still running and
                will be stopped.
              </>
            )}
          </Dialog.Description>
        </div>
        {/* How the task ended, defaulted to `done` — the common case — with
            one underlined link to flip it to `abandoned`. Only rendered
            when a board task is bound; a bare worktree has nothing to
            record. */}
        {task && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono",
                outcome === "done"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-kumo-recessed text-kumo-subtle",
              )}
            >
              {(() => {
                const merged = task.prs.find((p) => p.state === "merged");
                return outcome === "done"
                  ? merged
                    ? `PR #${merged.number} merged — closing as done ✓`
                    : "closing as done ✓"
                  : merged
                    ? `closing as abandoned ⊘ (PR #${merged.number} merged)`
                    : "no merged PR — closing as abandoned ⊘";
              })()}
            </span>
            <button
              type="button"
              className="text-kumo-subtle underline underline-offset-2 hover:text-kumo-default"
              onClick={onSwapOutcome}
            >
              record as {outcome === "done" ? "abandoned" : "done"} instead
            </button>
          </div>
        )}
        {/* Nothing on disk means no guards to waive, so the option would be a
            checkbox that changes nothing. A wrapping `<label>`, not a button —
            the Checkbox is one already (see apps/client/CLAUDE.md). */}
        {target && !target.dirMissing && (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-xs",
              force
                ? "border-destructive/40 bg-destructive/10"
                : "border-kumo-hairline bg-kumo-recessed",
            )}
          >
            <Checkbox
              aria-label="Skip the guards"
              checked={force}
              onCheckedChange={(checked) => onForceChange(checked)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Skip the guards</span>
              <span className="text-kumo-subtle">
                Delete even with uncommitted changes, commits on no branch/remote, or a dev server
                on its ports.
              </span>
            </span>
          </label>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button
            variant={force && !target?.dirMissing ? "destructive" : "primary"}
            onClick={onConfirm}
            title={withHint("Confirm", "ab-confirm-close-worktree")}
          >
            {confirmLabel(task != null, target?.dirMissing === true, outcome, force)}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

/** The "what are you working toward?" prompt shown before Claude launches in a
 * fresh session. Blank is a valid answer — it just skips the initial prompt. */
export function StartClaudeDialog({
  target,
  prompt,
  onPromptChange,
  onCommit,
  onOpenChange,
}: {
  target: StartClaudeTarget | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  onCommit: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={target != null} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="flex flex-col gap-4 p-6">
        <Dialog.Title className="text-lg font-semibold">
          ✦ Start Claude{target ? ` in ${target.sessionName}` : ""}
        </Dialog.Title>
        <Input
          aria-label="Prompt for Claude"
          autoFocus
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            }
          }}
          placeholder="what are you working toward? (optional)"
        />
      </Dialog>
    </Dialog.Root>
  );
}
