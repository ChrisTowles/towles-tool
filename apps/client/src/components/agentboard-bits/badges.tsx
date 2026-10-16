import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  ChecksIcon,
  CircleNotchIcon,
} from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { Hint } from "@/components/hint";
import type { PortDrift } from "@/lib/agentboard/types";
import { cn } from "@/lib/utils";
import { fmtElapsed } from "@/lib/format";

/** Violet is "a Claude session is live here" app-wide: pane headers, selection
 * chip and in-editor hint all use it, so it reads as one signal. */
export function ClaudeBadge({
  title = "A Claude Code session in this folder is connected — the files it opens land in this pane, and it reads this checkout's diagnostics",
  className,
  children = "✦ claude",
}: {
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Hint label={title}>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border border-agent/50 bg-agent/10 px-1.5 font-mono text-mini text-agent",
          className,
        )}
      >
        {children}
      </span>
    </Hint>
  );
}

export function NeedsBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md border border-warn/50 bg-warn/10 px-1.5 font-mono text-mini text-warn",
        className,
      )}
    >
      {n} ⚑
    </span>
  );
}

/** A checkout marked quiet, on a row the rail is showing anyway — peeked from
 * the footer, or the one you're working in. Grayscale and inert: it explains
 * why the row is normally absent, it doesn't ask for anything. */
export function QuietBadge() {
  return (
    <Hint label="Marked quiet — normally hidden from the rail. Unmark it from this row's ⋮ menu.">
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-muted-foreground/40 px-1 font-mono text-micro text-kumo-subtle">
        <ArchiveIcon className="size-2.5" /> quiet
      </span>
    </Hint>
  );
}

/** A tracked checkout whose directory is gone. Grayscale, not the needs-you
 * amber: this is inert, not something to act on. */
export function GhostBadge() {
  return (
    <Hint label="This checkout's directory is gone (moved or deleted). Untrack it, or restore the directory to bring it back.">
      <span className="shrink-0 rounded-md border border-dashed border-muted-foreground/40 px-1 font-mono text-micro text-kumo-subtle">
        ⚠ missing
      </span>
    </Hint>
  );
}

/** The `⎇ branch` line. Worktree tasks are the common case, so they stay
 * muted; the primary checkout is the special row and carries the sky tint. */
export function BranchLabel({
  branch,
  isWorktree,
  onClick,
}: {
  branch: string;
  isWorktree: boolean;
  onClick?: () => void;
}) {
  return (
    // Every surface truncates this element first, so the tooltip is the only
    // place a long branch is readable.
    <Hint
      label={
        isWorktree
          ? branch
          : `${branch} — primary checkout, the main clone; its .git is load-bearing for every worktree`
      }
    >
      <span className="min-w-0 truncate font-mono text-mini text-kumo-subtle" onClick={onClick}>
        ⎇ {branch}
      </span>
    </Hint>
  );
}

/** Why a mid-delete row went inert. Red, not `GhostBadge`'s gray: this is an
 * active, irreversible deletion. `label` is the backend's live phase text. */
export function DeletingBadge({ label }: { label?: string }) {
  return (
    <Hint
      label={
        label ? `Deleting this worktree from disk — ${label}…` : "Deleting this worktree from disk…"
      }
    >
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-1 font-mono text-micro text-danger">
        <CircleNotchIcon className="size-2.5 animate-spin" /> {label ? `${label}…` : "deleting…"}
      </span>
    </Hint>
  );
}

/** Why a task's row can exist before its directory does. Sky, not
 * `DeletingBadge`'s red: nothing is wrong and nothing is being destroyed. */
export function CreatingBadge({ label }: { label?: string }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-md border border-info/40 bg-info/10 px-1 font-mono text-micro text-info"
      title={label ? `Creating this worktree — ${label}…` : "Creating this worktree…"}
    >
      <CircleNotchIcon className="size-2.5 animate-spin" /> {label ? `${label}…` : "creating…"}
    </span>
  );
}

/** An open task whose worktree isn't on disk. The row stays and says so rather
 * than vanishing with the directory and stranding a card on the Board. */
export function DetachedBadge() {
  return (
    <span
      className="shrink-0 rounded-md border border-warn/50 bg-warn/10 px-1 font-mono text-micro text-warn"
      title="This task's worktree isn't on disk — start it again to recreate one, or delete the task to close it"
    >
      no worktree
    </span>
  );
}

/** The remedies for a `no worktree` row. Inline and boxed, unlike the rail's
 * other affordances: every other control here needs the missing directory. */
export function DetachedActions({
  onRecreate,
  onClose,
}: {
  /** Absent when there's no branch to rebuild on (`folderRecreateBranch`). */
  onRecreate?: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      {onRecreate && (
        <Hint label="Recreate this task's worktree on its branch — the task keeps its place, issues and PRs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRecreate();
            }}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-kumo-hairline px-1.5 font-mono text-mini text-kumo-subtle transition-colors hover:border-info/50 hover:bg-info/10 hover:text-info"
          >
            <ArrowClockwiseIcon className="size-3" /> Recreate
          </button>
        </Hint>
      )}
      {onClose && (
        <Hint label="Close this task — record it as done or abandoned; nothing is deleted from disk">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-kumo-hairline px-1.5 font-mono text-mini text-kumo-subtle transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
          >
            <ChecksIcon className="size-3" /> Close…
          </button>
        </Hint>
      )}
    </>
  );
}

/** A git worktree no task claims — Claude Code's own, or one added by hand. It
 * still has a `detected` record, so it holds its position and can be adopted. */
export function NoTaskBadge({ onAdopt }: { onAdopt?: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className="rounded-md border border-kumo-hairline bg-muted/40 px-1 font-mono text-micro text-kumo-subtle"
        title="A git worktree of this repo that no task claims — adopt it to track it as your own work"
      >
        no task
      </span>
      {onAdopt && (
        <button
          type="button"
          className="rounded-md px-1 font-mono text-micro text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          title="Track this worktree as one of your tasks — the row keeps its place"
          onClick={(e) => {
            e.stopPropagation();
            onAdopt();
          }}
        >
          adopt
        </button>
      )}
    </span>
  );
}

/** Setup (`TT_TASK_SETUP`) runs after `task_create` returns, so the pending row
 * is already gone; this says the task isn't finished being built. */
export function SettingUpBadge({ since, now }: { since: number; now: number }) {
  return (
    <Hint label="Running this task's setup step (TT_TASK_SETUP) — an install, so it can take a while">
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-info/40 bg-info/10 px-1 font-mono text-micro text-info">
        <CircleNotchIcon className="size-2.5 animate-spin" /> setup {fmtElapsed(now - since)}
      </span>
    </Hint>
  );
}

/** A sibling task's re-render rotated a port this pane already bound to. Amber:
 * worth acting on (restart the pane), not a dead state. */
export function BranchDriftBadge({
  recorded,
  live,
  onSync,
}: {
  recorded: string;
  live: string;
  onSync: () => void;
}) {
  return (
    <Hint
      label={`The task still records ${recorded}, but its worktree is on ${live}. Click to record ${live} — the board card and PR linking follow it.`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSync();
        }}
        className="max-w-40 shrink-0 truncate rounded-md border border-warn/50 bg-warn/10 px-1 font-mono text-micro text-warn hover:bg-warn/20"
      >
        ⎇ was {recorded}
      </button>
    </Hint>
  );
}

export function PortDriftBadge({ drift }: { drift: PortDrift[] }) {
  if (drift.length === 0) return null;
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          <div className="flex flex-col gap-0.5 font-mono text-mini">
            <span className="text-kumo-subtle">
              {drift.length === 1 ? "A pane" : "Panes"} started before{" "}
              {drift.length === 1 ? "this" : "these"} port{drift.length === 1 ? "" : "s"} last
              changed — restart to pick up the current .env:
            </span>
            {drift.map((d) => (
              <span key={`${d.key}:${d.spawnedPort}:${d.currentPort}`}>
                {d.key} {d.spawnedPort} → {d.currentPort}
              </span>
            ))}
          </div>
        </>
      }
      render={
        <span className="shrink-0 rounded-md border border-warn/50 bg-warn/10 px-1 font-mono text-micro text-warn">
          ⚡ port drift
        </span>
      }
    />
  );
}
