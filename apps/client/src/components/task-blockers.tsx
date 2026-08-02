import type { ReactNode } from "react";
import { CircleAlert, FileDiff, GitCommitHorizontal, Network } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  forceDeleteLabel,
  type TaskBlocker,
  type TaskBlockerKind,
  stoppablePort,
} from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/** Exhaustive over `TaskBlockerKind`, so a guard added in Rust fails the build
 * here rather than silently picking up whatever icon a ternary ended on. */
const BLOCKER_ICONS: Record<TaskBlockerKind, typeof CircleAlert> = {
  dirtyTree: FileDiff,
  unreachableCommits: GitCommitHorizontal,
  foreignPort: Network,
};

/** Tinted by consequence, not kind: destructive means forcing loses that work.
 * An unrecognized kind falls back to neutral rather than asserting a wrong one. */
function BlockerIcon({ kind, losesWork }: { kind: string; losesWork: boolean }) {
  const Icon = BLOCKER_ICONS[kind as TaskBlockerKind] ?? CircleAlert;
  return (
    <Icon
      className={cn(
        "mt-0.5 size-4 shrink-0",
        losesWork ? "text-destructive" : "text-muted-foreground",
      )}
      aria-hidden
    />
  );
}

export function BlockedDeleteDialog({
  open,
  onOpenChange,
  name,
  description,
  cancelLabel,
  blockers,
  /** Rendered above the list because it qualifies every row below it — chiefly
   * a failed `fetch --prune`, judging blockers against a stale `origin/*`. */
  messages,
  forceHint,
  busy = false,
  /** Separate from `busy`: backing out of a port stop is still real, but once
   * the delete runs "keep it" can no longer be honored. */
  cancelDisabled = false,
  stoppingPort,
  /** Omitted on screens without the retry loop; the row then renders its remedy
   * as text with no button. */
  onStopPort,
  onForce,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: ReactNode;
  description: ReactNode;
  cancelLabel: string;
  blockers: TaskBlocker[];
  messages: string[];
  busy?: boolean;
  cancelDisabled?: boolean;
  stoppingPort?: number | null;
  onStopPort?: (port: number) => void;
  forceHint?: string;
  onForce: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* `!` beats the primitive's own `data-[size=default]:` width. */}
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-xl!">
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Can’t delete {name} yet</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {messages.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
            {messages.map((message) => (
              <li key={message} className="text-[11.5px] text-amber-600 dark:text-amber-400">
                {message}
              </li>
            ))}
          </ul>
        )}
        {/* Scrolls rather than growing past the viewport: the footer must stay
            reachable however many blockers there are. */}
        <ul className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
          {blockers.map((blocker, i) => {
            const port = stoppablePort(blocker);
            return (
              <li
                key={`${blocker.kind}-${port ?? i}`}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
              >
                <BlockerIcon kind={blocker.kind} losesWork={blocker.losesWork} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-snug wrap-anywhere">{blocker.message}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {blocker.remedy}
                  </span>
                </div>
                {port !== null &&
                  onStopPort && (
                    // Every row disables while any stop+retry runs: they all end
                    // in a delete of the same worktree.
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => onStopPort(port)}
                    >
                      {stoppingPort === port ? "Stopping…" : "Stop it"}
                    </Button>
                  )}
              </li>
            );
          })}
        </ul>
        <AlertDialogFooter className="sm:justify-between">
          <AlertDialogCancel disabled={cancelDisabled}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={onForce}
            title={forceHint ? `Delete anyway (${forceHint})` : undefined}
          >
            {forceDeleteLabel(blockers)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
