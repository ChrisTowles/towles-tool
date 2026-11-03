import { useEffect, useState } from "react";
import { CheckIcon, GitMergeIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { Hint } from "@/components/hint";
import { comparedBaseLabel } from "@/lib/agentboard/folder";
import { blockerShortLabel, type TaskBlocker } from "@/lib/agentboard/landing";
import type { FolderData, LandedVia } from "@/lib/agentboard/types";
import { type PrItem } from "@/lib/data";

/** Each condition named with its own consequence: they are not equally serious.
 * Uncommitted changes die with the directory; unlanded commits stay on the branch. */
export function unsafeToDeleteReason(
  stats: Pick<FolderData, "dirty" | "commitsUnlanded">,
  base: string,
): string | null {
  const reasons: string[] = [];
  if (stats.dirty) reasons.push("uncommitted changes — deleting this checkout destroys them");
  if (stats.commitsUnlanded > 0) {
    reasons.push(
      `${stats.commitsUnlanded} commit${stats.commitsUnlanded === 1 ? "" : "s"} not on ${base} yet — those stay on the branch`,
    );
  }
  if (reasons.length === 0) return null;
  return reasons.join("; and ");
}

/** How this branch's work reached the base, straight from git — a squash merge
 * is invisible to naive checks, and a PR-less task has no other evidence. */
function LandedBadge({ landed, base }: { landed: LandedVia; base: string }) {
  return (
    <Tooltip
      side="bottom"
      content={`Git says this branch's work is already on ${base} (${landed}), with or without a PR.`}
      render={
        <span className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-merged/50 bg-merged/10 px-1.5 font-mono text-mini text-merged">
          <GitMergeIcon className="size-3" />
          {landed}
        </span>
      }
    />
  );
}

/** {@link LandedBadge}, gated on a merged `PrChip` not already saying it. */
export function FolderLandedBadge({
  folder,
  pr,
}: {
  folder: Pick<FolderData, "landed" | "comparedBase">;
  pr?: PrItem | null;
}) {
  if (!folder.landed || pr?.state === "merged") return null;
  return <LandedBadge landed={folder.landed} base={comparedBaseLabel(folder)} />;
}

/** A PR-less task never gets here by design: git can prove content landed but
 * not that it was *accepted*. Clicking reaches the same guarded confirmation as
 * the "···" menu — a louder path to it, not a shortcut around it. */
export function SafeToDeleteBadge({
  base,
  landed,
  onDeleteWorktree,
}: {
  base: string;
  /** Named in the tooltip, so the claim is attributable rather than asserted. */
  landed?: LandedVia | null;
  onDeleteWorktree: () => void;
}) {
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          No uncommitted changes, and every commit has landed on {base}
          {landed ? ` (${landed})` : ""}. Nothing here would be lost — click to delete this
          worktree.
        </>
      }
      render={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteWorktree();
          }}
          className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-ok/50 bg-ok/10 px-1.5 font-mono text-mini text-ok transition-colors hover:bg-ok/20"
        >
          <CheckIcon className="size-3" /> safe to delete
        </button>
      }
    />
  );
}

/** How long an armed discard waits for its second click before standing down. */
const DISCARD_ARM_MS = 4000;

/** A worktree that never got work: the first click arms, the second deletes.
 * The confirm lives in the box itself — nothing is lost, so no dialog. */
export function DiscardBadge({ onDiscard }: { onDiscard: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DISCARD_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed)
    return (
      <button
        type="button"
        autoFocus
        data-hud="Click again to delete this worktree · Esc keeps it"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
          onDiscard();
        }}
        onBlur={() => setArmed(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setArmed(false);
        }}
        className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-danger/60 bg-danger/15 px-1.5 font-mono text-mini text-danger"
      >
        <TrashIcon className="size-3" /> confirm discard
      </button>
    );
  return (
    <button
      type="button"
      data-hud="Discard: no commits, no changes and no agent here, so nothing would be lost"
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true);
      }}
      className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-kumo-hairline px-1.5 font-mono text-mini text-kumo-subtle transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
    >
      <TrashIcon className="size-3" /> discard
    </button>
  );
}

/** The last delete's refusal, kept on the line until a retry settles it, so
 * "it won't delete" always comes with the reason. Clicking retries. */
export function DeleteBlockedBadge({
  blockers,
  onRetry,
}: {
  blockers: TaskBlocker[];
  onRetry: () => void;
}) {
  const first = blockers[0];
  const label = first ? blockerShortLabel(first) : "refused";
  const detail = blockers.map((b) => `${b.message} ${b.remedy}`.trim()).join(" · ");
  return (
    <Hint label={detail || "The last delete was refused"}>
      <button
        type="button"
        data-hud={`Delete blocked: ${label}. Click to try again and see the fixes`}
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        className="flex h-5 max-w-48 min-w-0 items-center gap-1 rounded-md border border-warn/50 bg-warn/10 px-1.5 font-mono text-mini text-warn transition-colors hover:bg-warn/20"
      >
        <WarningIcon className="size-3 shrink-0" />
        <span className="truncate">blocked · {label}</span>
      </button>
    </Hint>
  );
}
