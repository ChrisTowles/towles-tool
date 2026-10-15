import type { ReactNode } from "react";
import {
  FileMagnifyingGlassIcon,
  GitCommitIcon,
  GraphIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Button, Dialog } from "@cloudflare/kumo";
import {
  forceDeleteLabel,
  type LandingSummary,
  type TaskBlocker,
  type TaskBlockerKind,
  stoppablePort,
} from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/** Exhaustive over `TaskBlockerKind`, so a guard added in Rust fails the build
 * here rather than silently picking up whatever icon a ternary ended on. */
const BLOCKER_ICONS: Record<TaskBlockerKind, typeof WarningCircleIcon> = {
  dirtyTree: FileMagnifyingGlassIcon,
  unreachableCommits: GitCommitIcon,
  foreignPort: GraphIcon,
};

/** Tinted by consequence, not kind: destructive means forcing loses that work.
 * An unrecognized kind falls back to neutral rather than asserting a wrong one. */
function BlockerIcon({ kind, losesWork }: { kind: string; losesWork: boolean }) {
  const Icon = BLOCKER_ICONS[kind as TaskBlockerKind] ?? WarningCircleIcon;
  return (
    <Icon
      className={cn("mt-0.5 size-4 shrink-0", losesWork ? "text-kumo-danger" : "text-kumo-subtle")}
      aria-hidden
    />
  );
}

/** Where the branch stands, atop every close dialog — the same line the
 * header's "Safe to delete" callout leads with. */
export function LandingLine({ landing }: { landing: LandingSummary }) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 rounded-md border border-l-2 bg-card px-2.5 py-1.5 text-xs",
        landing.landed ? "border-ok/40" : "border-kumo-hairline",
      )}
    >
      <span
        className={cn("shrink-0 font-mono", landing.landed ? "text-ok" : "text-kumo-subtle")}
        aria-hidden
      >
        {landing.landed ? "✓" : "○"}
      </span>
      <span className="min-w-0 wrap-anywhere text-kumo-default">{landing.text}</span>
    </p>
  );
}

export function BlockedDeleteDialog({
  open,
  onOpenChange,
  name,
  landing,
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
  /** `undefined` for a checkout the rail doesn't track. */
  landing?: LandingSummary;
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="flex max-w-xl flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold wrap-anywhere">
            Can’t delete {name} yet
          </Dialog.Title>
          <Dialog.Description className="text-sm text-pretty text-kumo-subtle">
            {description}
          </Dialog.Description>
        </div>
        {landing && <LandingLine landing={landing} />}
        {messages.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2">
            {messages.map((message) => (
              <li key={message} className="text-mini text-warn">
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
                className="flex items-start gap-3 rounded-lg border border-kumo-hairline bg-kumo-recessed px-3 py-2.5"
              >
                <BlockerIcon kind={blocker.kind} losesWork={blocker.losesWork} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-snug wrap-anywhere">{blocker.message}</span>
                  <span className="text-xs leading-snug text-kumo-subtle">{blocker.remedy}</span>
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
        <div className="mt-2 flex justify-between gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary" disabled={cancelDisabled}>
                {cancelLabel}
              </Button>
            )}
          />
          <Button
            variant="destructive"
            disabled={busy}
            onClick={onForce}
            title={forceHint ? `Delete anyway (${forceHint})` : undefined}
          >
            {forceDeleteLabel(blockers)}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
