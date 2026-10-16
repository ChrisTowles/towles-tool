import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, GitCommitIcon, PencilIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Hint } from "@/components/hint";
import { toast } from "@/lib/toast";
import { comparedBaseLabel, gitCheckedLabel } from "@/lib/agentboard/folder";
import type { CommitStat, FolderData } from "@/lib/agentboard/types";
import { mouseAction } from "@/lib/shortcut-coach";
import { withHint } from "@/lib/shortcuts";
import { errorMessage } from "@/lib/errors";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { fmtDiffLines } from "@/lib/format";

/** Which branch every git stat here was measured against, and the one place to
 * retarget it — the override used to live in the diff pane's header, and every
 * count in this row is measured from it. Click to edit, blank to auto-detect. */
export function ComparedBaseBadge({
  folder,
}: {
  folder: Pick<
    FolderData,
    "dir" | "comparedBase" | "baseBranch" | "taskBaseBranch" | "prBaseBranch"
  >;
}) {
  const [editing, setEditing] = useState(false);
  const label = comparedBaseLabel(folder);
  const manual = Boolean(folder.baseBranch?.trim());

  async function commit(value: string) {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed === (folder.baseBranch ?? "")) return;
    uiAction("folder.base_branch_set", "agentboard");
    const stored = await invoke<void>("ab_set_folder_base_branch", {
      dir: folder.dir,
      branch: trimmed || null,
    });
    // Silence reads as success while every count keeps the old baseline.
    if (stored.isErr()) toast.error(`Couldn't set base branch — ${errorMessage(stored.error)}`);
  }

  // Either the input or the chip, never nested: the chip is a button.
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={folder.baseBranch ?? ""}
        placeholder={
          folder.prBaseBranch
            ? `compare against (blank = its PR's base, "${folder.prBaseBranch}")`
            : folder.taskBaseBranch
              ? `compare against (blank = this task's base, "${folder.taskBaseBranch}")`
              : "compare against (blank = auto-detect main)"
        }
        onBlur={(e) => void commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-56 shrink-0 rounded-sm border border-input bg-background px-1.5 py-0.5 font-mono text-micro outline-none"
      />
    );
  }
  return (
    <Hint
      label={
        manual
          ? `Diffs against "${label}" — your override for this folder. Click to change.`
          : folder.prBaseBranch
            ? `Diffs against "${label}" — the branch its PR merges into. Click to override.`
            : folder.taskBaseBranch
              ? `Diffs against "${label}" — the ref this task was created from. Click to override.`
              : `Diffs against "${label}" (origin/main-or-master auto-detect). Click to override.`
      }
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="shrink-0 rounded-sm px-0.5 font-mono text-micro text-kumo-subtle hover:text-kumo-default"
      >
        vs {label}
      </button>
    </Hint>
  );
}

/** How far `comparedBase` has moved ahead — someone else's work, so its own
 * chip. The only *filled* git chip: weight, since amber is spoken for. */
export function BaseMovedChip({
  stats,
}: {
  stats: Pick<FolderData, "commitsBehind" | "comparedBase" | "baseBranch" | "taskBaseBranch">;
}) {
  const { commitsBehind } = stats;
  if (commitsBehind === 0) return null;
  const base = comparedBaseLabel(stats);
  return (
    <Hint
      label={`Base moved: ${base} has ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} this branch doesn't — rebase or merge ${base} in to catch up. Not a measure of your own work.`}
    >
      <span className={`${CHIP_CLASS} bg-muted font-medium text-kumo-default`}>
        <ArrowClockwiseIcon className="size-3" />
        {commitsBehind}
      </span>
    </Hint>
  );
}

export function CommitStatRow({ commit }: { commit: CommitStat }) {
  return (
    <div className="flex items-center gap-2 font-mono text-mini leading-tight">
      <span className="shrink-0 text-kumo-subtle">{commit.sha.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 truncate text-kumo-default">{commit.subject}</span>
      <span className="shrink-0 text-ok">+{commit.linesAdded}</span>
      <span className="shrink-0 text-danger">−{commit.linesRemoved}</span>
    </div>
  );
}

/** `CommittedChip`'s hover card, where the two totals are spelled out as the
 * separate things they are. Commits are fetched lazily and cached by the parent. */
function CommitBreakdownPreview({
  commits,
  stats,
  base,
}: {
  commits: CommitStat[] | null;
  stats: Pick<
    FolderData,
    | "committedFiles"
    | "committedAdded"
    | "committedRemoved"
    | "uncommittedFiles"
    | "uncommittedAdded"
    | "uncommittedRemoved"
  >;
  base: string;
}) {
  if (commits == null) {
    return <p className="p-1 text-xs text-kumo-subtle">loading commits…</p>;
  }
  return (
    <div className="max-h-80 overflow-auto">
      <div className="flex flex-col gap-1">
        {commits.length === 0 ? (
          <p className="text-xs text-kumo-subtle">no commits ahead of {base}</p>
        ) : (
          commits.map((c) => <CommitStatRow key={c.sha} commit={c} />)
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-kumo-hairline pt-1.5 font-mono text-mini font-semibold">
        <span className="min-w-0 flex-1 text-kumo-default">
          Committed
          {commits.length > 0 && ` — ${commits.length} commit${commits.length === 1 ? "" : "s"}`}
          {stats.committedFiles > 0 &&
            `, ${stats.committedFiles} file${stats.committedFiles === 1 ? "" : "s"}`}
        </span>
        <span className="shrink-0 text-ok">+{stats.committedAdded}</span>
        <span className="shrink-0 text-danger">−{stats.committedRemoved}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-dashed border-kumo-hairline pt-1.5 font-mono text-mini">
        <span className="min-w-0 flex-1 text-kumo-subtle">
          {stats.uncommittedFiles === 0
            ? "Uncommitted — nothing"
            : `Uncommitted — ${stats.uncommittedFiles} file${stats.uncommittedFiles === 1 ? "" : "s"}, lost if this checkout is deleted`}
        </span>
        {stats.uncommittedFiles > 0 && (
          <>
            <span className="shrink-0 text-ok">+{stats.uncommittedAdded}</span>
            <span className="shrink-0 text-danger">−{stats.uncommittedRemoved}</span>
          </>
        )}
      </div>
    </div>
  );
}

type DiffChipStats = Pick<
  FolderData,
  | "dir"
  | "committedFiles"
  | "committedAdded"
  | "committedRemoved"
  | "uncommittedFiles"
  | "uncommittedAdded"
  | "uncommittedRemoved"
  | "uncommittedCapped"
  | "commitsAhead"
  | "commitsUnlanded"
  | "landed"
  | "comparedBase"
  | "computedAtMs"
>;

type DiffChipProps = {
  stats: DiffChipStats;
  onOpen: () => void;
  /** A width budget, not a preference: two extra words push the rail row's
   * numbers off the end, so it's on for the pane header and off for the rail. */
  labeled?: boolean;
};

/** No resting border: a box means a control or an alert, plain type means a
 * fact, and diff stats are facts. The box returns on hover. */
export const CHIP_CLASS =
  "flex h-5 shrink-0 items-center gap-1 rounded-md px-1 font-mono text-mini transition-colors";

/** Muted, so the *number* stays what the eye lands on. */
function ChipLabel({ text, labeled }: { text: string; labeled: boolean }) {
  if (!labeled) return null;
  return <span className="opacity-60">{text}</span>;
}

/** Ticks on its own interval: a caller-passed `now` would freeze exactly when
 * nothing is changing, which is when the user is asking whether anything is alive. */
function CheckedAgo({ computedAtMs }: { computedAtMs: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{gitCheckedLabel(computedAtMs, now) ?? "not checked yet"}</>;
}

/** First of the two chips because its contents die with the checkout. A rail
 * row drops it at zero — a resting "clean" reads as a button to clean up — but
 * the `labeled` pane header keeps it, where an absent chip and one you missed
 * would look identical. */
export function UncommittedChip({ stats, onOpen, labeled = false }: DiffChipProps) {
  const { uncommittedFiles, uncommittedAdded, uncommittedRemoved, uncommittedCapped } = stats;
  const clean = uncommittedFiles === 0;
  if (clean && !labeled) return null;
  // A `+` because the count is a floor: an untracked directory was too large to list.
  const filesLabel = `${uncommittedFiles}${uncommittedCapped ? "+" : ""}f`;
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          {/* Multi-paragraph content needs its own column wrapper or the
            lines lay out side by side. */}
          <div className="flex flex-col gap-0.5">
            <span>
              {clean
                ? "Nothing uncommitted — every change here is in a commit."
                : uncommittedCapped
                  ? `At least ${uncommittedFiles} files not committed — an untracked directory was too large to list; open the files pane for which one.`
                  : `${uncommittedFiles} file${uncommittedFiles === 1 ? "" : "s"} not committed — staged, unstaged or untracked.`}
            </span>
            <span className="opacity-70">
              {clean
                ? "Deleting this checkout would lose nothing that isn't on the branch."
                : "Deleting this checkout destroys these. Untracked files count here but add no ± (they have no diff yet)."}
            </span>
            <span className="opacity-70">
              {withHint(
                clean ? "Opens the files pane" : "Opens these changes as a diff in the files pane",
                "ab-toggle-files",
              )}
            </span>
            <span className="opacity-70">
              <CheckedAgo computedAtMs={stats.computedAtMs} />
            </span>
          </div>
        </>
      }
      render={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            mouseAction("ab-toggle-files", "agentboard");
            onOpen();
            if (!clean) void invoke("code_server_show_changes", { dir: stats.dir });
          }}
          className={`${CHIP_CLASS} hover:bg-kumo-tint ${
            clean ? "text-kumo-subtle" : "font-medium text-kumo-default"
          }`}
        >
          <PencilIcon className="size-3" />
          <ChipLabel text="uncommitted" labeled={labeled} />
          {clean ? (
            <span>clean</span>
          ) : (
            <>
              <span>{filesLabel}</span>
              <span className="text-ok">+{fmtDiffLines(uncommittedAdded)}</span>
              <span className="text-danger">−{fmtDiffLines(uncommittedRemoved)}</span>
            </>
          )}
        </button>
      }
    />
  );
}

/** Shows `commitsUnlanded`, not `commitsAhead`, whenever they disagree: the
 * latter is SHA reachability, which a squash merge pins at 15 forever. */
export function CommittedChip({ stats, onOpen, labeled = false }: DiffChipProps) {
  const { dir, committedAdded, committedRemoved, commitsAhead, commitsUnlanded, comparedBase } =
    stats;
  const base = comparedBaseLabel(stats);
  const [commits, setCommits] = useState<CommitStat[] | null>(null);

  const landedClean = commitsAhead > 0 && stats.landed != null && commitsUnlanded === 0;
  const partly = commitsUnlanded > 0 && commitsUnlanded !== commitsAhead;
  const tone = landedClean
    ? "text-kumo-subtle hover:bg-kumo-tint"
    : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default";

  return (
    <HoverCard
      onOpenChange={(open) => {
        if (open && commits == null) {
          void invoke<CommitStat[]>("ab_get_commit_stats", {
            dir,
            baseBranch: comparedBase || null,
          }).then((c) => setCommits(c.unwrapOr([])));
        }
      }}
    >
      <HoverCardTrigger
        delay={250}
        render={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              mouseAction("ab-toggle-files", "agentboard");
              onOpen();
            }}
            className={`${CHIP_CLASS} ${tone}`}
          />
        }
      >
        <GitCommitIcon className="size-3" />
        <ChipLabel text="committed" labeled={labeled} />
        {commitsAhead === 0 ? (
          /* Unlabeled, the word doubles as the affordance; labeled,
               `committed` already names the chip. */
          <span>{labeled ? "none" : "files"}</span>
        ) : landedClean ? (
          <span>
            {commitsAhead}c {stats.landed}
          </span>
        ) : (
          <>
            <span>{partly ? `${commitsUnlanded}/${commitsAhead}c` : `${commitsAhead}c`}</span>
            <span className="text-ok">+{fmtDiffLines(committedAdded)}</span>
            <span className="text-danger">−{fmtDiffLines(committedRemoved)}</span>
          </>
        )}
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        className="w-[28rem] max-w-[calc(100vw-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1.5 text-mini leading-snug text-kumo-subtle">
          {commitsAhead === 0 ? (
            <>Nothing committed beyond {base}.</>
          ) : landedClean ? (
            <>
              All {commitsAhead} commit{commitsAhead === 1 ? "" : "s"} are already on {base} (
              {stats.landed}) — the commit count stays put because the rewrite gave them new SHAs,
              but nothing here is outstanding.
            </>
          ) : partly ? (
            <>
              {commitsUnlanded} of {commitsAhead} commits are not on {base} yet; the rest already
              landed under different SHAs.
            </>
          ) : (
            <>
              {commitsAhead} commit{commitsAhead === 1 ? "" : "s"} not on {base} yet.
            </>
          )}{" "}
          <CheckedAgo computedAtMs={stats.computedAtMs} />.{" "}
          {withHint("Opens the files pane", "ab-toggle-files")}.
        </p>
        <CommitBreakdownPreview commits={commits} stats={stats} base={base} />
      </HoverCardContent>
    </HoverCard>
  );
}
