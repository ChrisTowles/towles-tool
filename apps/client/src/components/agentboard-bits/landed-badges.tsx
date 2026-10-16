import { CheckIcon, GitMergeIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { comparedBaseLabel } from "@/lib/agentboard/folder";
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
