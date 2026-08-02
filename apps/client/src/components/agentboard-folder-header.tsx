/**
 * A checkout's header row: identity, git facts, toolbar. A single-checkout
 * repo renders this at `scope="repo"` instead of a separate repo header,
 * which is why identity, accent and the toolbar all branch on `scope`.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Folder, FolderPlus, FolderX, Plus, Trash2 } from "lucide-react";
import { Hint } from "@/components/hint";
import {
  BaseMovedChip,
  BranchLabel,
  Chevron,
  CollapsedLive,
  CommittedChip,
  CreatingBadge,
  DeletingBadge,
  DetachedActions,
  DetachedBadge,
  NoTaskBadge,
  SettingUpBadge,
  FilesButton,
  FolderLandedBadge,
  GhostBadge,
  IconBtn,
  IssueChip,
  BrowserButton,
  JarvisButton,
  NeedsBadge,
  PortDriftBadge,
  PrChip,
  PreviewButton,
  RepoMenu,
  SafeToDeleteBadge,
  UncommittedChip,
} from "@/components/agentboard-bits";
import { DevServersButton } from "@/components/dev-servers";
import { Input } from "@/components/ui/input";
import { hasRepoColor, repoAccentStyles, repoIcon, type RepoMeta } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import {
  branchRedundant,
  comparedBaseLabel,
  folderCreating,
  folderDetached,
  folderIsUnclaimed,
  folderPortDrift,
  folderRemoving,
  folderSafeToDelete,
  humanizeFolderName,
  pathScope,
  type FolderData,
  type SessionActions,
} from "@/lib/agentboard";
import { storeUpdateTask, type PrItem, type TaskItem } from "@/lib/data";

export function FolderHeader({
  scope,
  title,
  meta,
  folder,
  needs,
  pr,
  task,
  collapsed,
  active,
  now,
  deleting,
  deletingLabel,
  onAdoptWorktree,
  settingUpSince,
  actions,
  onToggle,
  onNewSession,
  onNewTask,
  onRemoveRepo,
  onDeleteWorktree,
  onRecreateWorktree,
  onOpenDiff,
  onOpenFiles,
  onOpenPreview,
  onOpenJarvis,
  onOpenBrowser,
}: {
  scope: "repo" | "folder";
  /** repo.name at repo scope, folder.name at folder scope. */
  title: string;
  /** The owning repo's chosen icon/color — set only at repo scope (a solo
   * repo's collapsed repo+folder header). Absent renders the default look. */
  meta?: RepoMeta;
  /** The checkout this header describes: dir, branch, worktree + diff facts. */
  folder: FolderData;
  needs: number;
  /** The open PR for this folder's branch, when the store knows of one. */
  pr?: PrItem;
  /** The board task bound to this folder's worktree, when one exists — source
   * of the manually-linked issue chips and the "Attach issue…" target. */
  task?: TaskItem;
  collapsed: boolean;
  /** Whether this folder is the one currently shown in the main pane area. */
  active: boolean;
  now: number;
  /** An operation on this worktree is in flight — the caller already dims and
   * disables the whole row (`pointer-events-none opacity-50`); the badges here
   * say which operation. Derived from `folder.phase`, same as they are. */
  deleting?: boolean;
  /** Live phase text for the in-flight operation ("fetching origin", "deleting
   * git worktree", …) — the badges fall back to a static label when absent
   * (nothing has been stamped yet, and browser dev never gets one). */
  deletingLabel?: string;
  /** Adopt this row's detected worktree as the user's own task. Absent when
   * the row isn't a detected one. */
  onAdoptWorktree?: () => void;
  /** When this checkout's setup step started (epoch ms), while it's still
   * running. Absent means nothing is installing. */
  settingUpSince?: number;
  /** Session lifecycle dispatch — the dev-servers popover launches/focuses
   * through it. */
  actions: SessionActions;
  onToggle: () => void;
  onNewSession: () => void;
  /** Opens the new-task modal — set only on a solo task-convention repo's
   * collapsed repo+folder header (the multi-checkout repo tier renders its
   * own button). */
  onNewTask?: () => void;
  onRemoveRepo?: () => void;
  /** Deletes this worktree from disk (guarded, `task_delete`) — set
   * only on worktree checkouts, where untracking makes no sense (they are
   * auto-discovered from the primary and would reappear next poll). */
  onDeleteWorktree?: () => void;
  /** Rebuild a detached task's worktree (`git worktree add` on its branch,
   * re-bound to the same task row). Set only on a `no worktree` task row. */
  onRecreateWorktree?: () => void;
  /** Opens the folder's diff pane in its focused window. */
  onOpenDiff: () => void;
  /** Opens the folder's files pane in its focused window. */
  onOpenFiles: () => void;
  /** Opens the folder's live-preview pane in its focused window. */
  onOpenPreview: () => void;
  /** Opens the folder's native (Bevy) pane — undefined while
   * `agentboard.jarvisPane` is off. */
  onOpenJarvis?: () => void;
  onOpenBrowser?: () => void;
}) {
  const scopePrefix = pathScope(folder.dir);
  // Repo identity, repo scope only. A repo-scope header is sticky, so its
  // tint must mix into an opaque base (see the background comment below).
  const HeaderIcon = repoIcon(meta);
  const accent = repoAccentStyles(meta, "var(--card)");
  // Ghost checkout: dim the band and swap the git-facts line (meaningless)
  // for the one useful action, Untrack.
  const missing = folder.dirMissing;
  // A task's human-authored title applies to worktree rows only — on the
  // primary checkout it would misname the repo itself (see `taskForFolder`).
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  // git-worktree(1)'s "main worktree", shortened to "Root" so the folder-scope
  // sub-header reads as a distinct entry rather than repeating the repo title.
  const isMainWorktreeSubrow = scope === "folder" && !folder.isWorktree;
  const displayTitle =
    humanTitle ||
    (folder.isWorktree ? humanizeFolderName(title) : isMainWorktreeSubrow ? "Root" : title);
  // A real title doesn't restate the branch — keep it visible; the
  // de-slugified fallback does, so that case keeps the redundancy check.
  const showBranchLabel =
    isMainWorktreeSubrow || Boolean(humanTitle) || !branchRedundant(folder.name, folder.branch);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  function startRename() {
    if (!task) return;
    setRenameValue(task.text);
    setRenaming(true);
  }

  async function commitRename() {
    setRenaming(false);
    const trimmed = renameValue.trim();
    if (!task || !trimmed || trimmed === task.text) return;
    const result = await storeUpdateTask(task.id, trimmed, task.notes);
    if (result.isErr()) toast.error(`Couldn't rename — ${result.error.message}`);
  }

  return (
    // The transparent border-l-2 is always present so the active violet edge
    // never shifts content.
    <div
      style={
        // Identity never outranks true status: needs-you or missing keep the
        // row to themselves; active is a ring on top, not a fill.
        scope === "repo" && needs === 0 && !missing
          ? { ...accent.edgeStyle, ...accent.surfaceStyle }
          : undefined
      }
      className={cn(
        // pr-3 matches the repo-scope header above and the session rows below:
        // the rail's trailing controls all land on one right edge instead of a
        // ragged one that shifts by tier.
        "group @container/row border-b border-l-2 border-border border-l-transparent bg-card pr-3",
        // A repo-scope header is sticky, so rows scroll underneath it and every
        // background it can take must be opaque — a translucent tint lets their
        // text show through the stuck header, so its active state is a ring
        // instead of a fill. Folder-scope rows sit in normal flow with nothing
        // passing beneath and carry no identity wash, so they keep the fill.
        scope === "repo"
          ? cn(
              "sticky top-0 z-10 pl-3 hover:bg-accent",
              active && "ring-1 ring-inset ring-violet-500/50",
            )
          : cn("pl-6 hover:bg-accent/50", active && "bg-accent/60"),
        active && "border-l-violet-500",
      )}
    >
      {/* Three blocks: who this is (title, GitHub links), what git says
          (branch, counts), what you can do (toolbar). Wide enough to hold all
          three and they sit on one line; below 34rem the git block wraps to a
          line of its own, right-aligned under the toolbar, because the
          alternative at that width is a title truncated to two words. The
          `order` swap is what keeps the toolbar on the *name's* line in both
          layouts while the counts move. `@container/row` asks the question
          that actually matters — does this row have room — rather than
          measuring the window. */}
      <div className="flex flex-wrap items-center gap-x-2 py-1.5 @[34rem]/row:flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Split from a single button into a button (toggle only) + a
              span/input sibling, per this repo's "swap the element, don't nest
              one" rule for inline rename — an <Input> can't live inside a
              <button>. */}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              // Ghost: dim the identity cluster so it reads as inert. The action
              // buttons (Untrack, kebab) sit outside this and stay full-strength.
              missing && "opacity-60",
            )}
          >
            <button type="button" onClick={onToggle} className="flex shrink-0 items-center gap-2">
              <Chevron collapsed={collapsed} />
              {missing ? (
                <FolderX className="size-3.5 shrink-0 text-muted-foreground/70" />
              ) : scope === "repo" ? (
                <HeaderIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    !hasRepoColor(meta) && "text-muted-foreground",
                  )}
                  style={accent.iconStyle}
                />
              ) : (
                <Folder className="size-3.5 shrink-0 text-muted-foreground/70" />
              )}
              {scope === "repo" && scopePrefix && (
                <span className="shrink-0 font-mono text-sm text-muted-foreground/60">
                  {scopePrefix}
                </span>
              )}
            </button>
            {renaming ? (
              <Input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={() => void commitRename()}
                className="h-6 min-w-0 flex-1 px-1.5 py-0 text-sm"
                aria-label="Rename task"
              />
            ) : (
              <Hint label={humanTitle ? folder.name : undefined} side="right">
                <span
                  onClick={onToggle}
                  onDoubleClick={
                    task && !missing
                      ? (e) => {
                          e.stopPropagation();
                          startRename();
                        }
                      : undefined
                  }
                  className={cn(
                    "min-w-0 flex-1 cursor-pointer truncate",
                    scope === "repo"
                      ? "text-sm font-semibold"
                      : "text-sm font-medium text-muted-foreground",
                    missing && "line-through decoration-muted-foreground/40",
                  )}
                >
                  {displayTitle}
                </span>
              </Hint>
            )}
            {missing && <GhostBadge />}
          </div>
          {/* The GitHub links belong to identity — they are what the row is
              *about* (which PR, which issue), where the git block beside them
              is state. */}
          {pr && <PrChip pr={pr} stats={folder} />}
          {task?.issues.map((issue) => (
            <IssueChip key={`${issue.repo}#${issue.number}`} taskId={task.id} issue={issue} />
          ))}
          {collapsed && !missing && <CollapsedLive sessions={folder.sessions} />}
          {needs > 0 && <NeedsBadge n={needs} />}
        </div>
        {/* What git says. `pl-11` only matters in the wrapped layout, where it
            lines this block's left edge up under the name (chevron + icon +
            gaps); inline it sits wherever the title leaves it. */}
        {missing ? (
          <div className="order-3 flex min-w-0 basis-full items-center justify-end gap-2 pl-11 @[34rem]/row:order-2 @[34rem]/row:basis-auto @[34rem]/row:pl-0">
            <span className="mr-auto min-w-0 truncate text-[11px] text-muted-foreground/70 italic">
              directory missing — moved or deleted
            </span>
            {/* Untrack is a repos.json operation, so it only makes sense on a
                tracked checkout; a task row with a gone directory is detached,
                and its remedies live on the task itself. */}
            {folder.record.origin === "checkout"
              ? onRemoveRepo && (
                  <Hint label="Untrack this checkout — remove it from the rail">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveRepo();
                      }}
                      className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <Trash2 className="size-3" /> Untrack
                    </button>
                  </Hint>
                )
              : folderDetached(folder) && (
                  <>
                    <DetachedBadge />
                    <DetachedActions onRecreate={onRecreateWorktree} onClose={onDeleteWorktree} />
                  </>
                )}
          </div>
        ) : (
          <div className="order-3 flex min-w-0 basis-full items-center justify-end gap-x-1.5 pl-11 @[34rem]/row:order-2 @[34rem]/row:basis-auto @[34rem]/row:pl-0">
            {/* `mr-auto` so the branch hugs the left of its own line in the
                wrapped layout, and does nothing in the inline one. A real task
                title and the branch are two different pieces of information,
                so the branch stays visible whenever one exists. Falling back to
                the de-slugified folder name is still the same information
                reformatted, so that case keeps the old redundancy check (a
                worktree task's folder name IS its slugged branch; the main
                checkout, "towles-tool" on `main`, is never redundant). */}
            {showBranchLabel && (
              <span className="mr-auto flex min-w-0 items-center">
                <BranchLabel
                  branch={folder.branch}
                  isWorktree={folder.isWorktree}
                  onClick={onToggle}
                />
              </span>
            )}
            {folderRemoving(folder) && <DeletingBadge label={deletingLabel} />}
            {folderCreating(folder) && <CreatingBadge label={deletingLabel} />}
            {folderIsUnclaimed(folder) && <NoTaskBadge onAdopt={onAdoptWorktree} />}
            {settingUpSince !== undefined && !deleting && (
              <SettingUpBadge since={settingUpSince} now={now} />
            )}
            {folder.hasPortDrift && <PortDriftBadge drift={folderPortDrift(folder)} />}
            <FolderLandedBadge folder={folder} pr={pr} />
            {/* Merged PR, and nothing here would be lost. A PR-less task never
                shows this — git alone can't tell landed work from abandoned
                work, so the affirmative claim needs the merged PR. See
                `folderSafeToDelete`. */}
            {folder.isWorktree && onDeleteWorktree && folderSafeToDelete(folder, pr) && (
              <SafeToDeleteBadge
                base={comparedBaseLabel(folder)}
                landed={folder.landed}
                onDeleteWorktree={onDeleteWorktree}
              />
            )}
            <BaseMovedChip stats={folder} />
            <UncommittedChip stats={folder} onOpen={onOpenDiff} />
            <CommittedChip stats={folder} onOpen={onOpenDiff} />
          </div>
        )}
        {/* What you can do. One `shrink-0` cluster, not loose siblings of the
            title: grouped, it is a fixed-width toolbar pinned to the right edge
            with its own tighter gap, and — because the group can't be split or
            squeezed — every pixel a narrowing rail needs comes out of the title
            (min-w-0, truncating) rather than out of the toolbar. It keeps the
            name's line in both layouts (`order-2` while the counts wrap below),
            so the rail's controls stay in one column top to bottom. */}
        <div className="order-2 flex shrink-0 items-center gap-1 pl-1 @[34rem]/row:order-3">
          {/* files/preview/jarvis are pure actions carrying no state
              (unlike the diff chips' dirty counts), so they don't earn
              resting-rail pixels on every folder — they fade in on header hover
              or keyboard focus. `w-0 overflow-hidden` and not opacity alone:
              fading them left ~120px reserved on every row, which at a 520px
              rail is the whole branch name. Not `hidden`, which would take them
              out of the tab order — clipped to zero width they stay focusable,
              and `focus-within` opens the strip for whoever tabbed into it. */}
          {!missing && (
            <span className="pointer-events-none flex w-0 items-center gap-1 overflow-hidden opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:w-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:w-auto group-hover:opacity-100">
              <FilesButton onOpen={onOpenFiles} />
              {folder.hasLaunchConfig && <PreviewButton onOpen={onOpenPreview} />}
              {onOpenBrowser && <BrowserButton onOpen={onOpenBrowser} />}
              {onOpenJarvis && <JarvisButton onOpen={onOpenJarvis} />}
            </span>
          )}
          {/* No "New session"/"New task" on a ghost — the directory is gone. */}
          {/* The dev-servers button is the one slot a row can legitimately not
              have (no .claude/launch.json), and dropping it shifted every other
              icon on that row sideways — the columns went ragged down the rail.
              An empty slot of the same size keeps them lined up. */}
          {!missing &&
            (folder.hasLaunchConfig ? (
              <DevServersButton folder={folder} actions={actions} ghost />
            ) : (
              <span aria-hidden className="size-6 shrink-0" />
            ))}
          {!missing && (
            <IconBtn
              ghost
              title="New session"
              shortcut="ab-new-session"
              onClick={() => {
                onNewSession();
              }}
              className="hover:text-violet-500"
            >
              <Plus className="size-3.5" />
            </IconBtn>
          )}
          {!missing && onNewTask && (
            <IconBtn
              ghost
              title="New task — goal, issues, branch"
              shortcut="ab-new-task"
              onClick={() => {
                onNewTask();
              }}
              className="hover:text-violet-500"
            >
              <FolderPlus className="size-3.5" />
            </IconBtn>
          )}
          {onRemoveRepo && (
            <RepoMenu
              ghost
              path={folder.dir}
              onRemove={onRemoveRepo}
              dir={folder.dir}
              isWorktree={folder.isWorktree}
              quiet={folder.quiet}
              onNewTask={!missing ? onNewTask : undefined}
              // Every menu item needs a directory except closing the task
              // out, which is the one thing a detached row is *for*.
              onDeleteWorktree={!missing || folderDetached(folder) ? onDeleteWorktree : undefined}
              deleteLabel={missing ? "Close task…" : undefined}
              taskId={!missing ? task?.id : undefined}
              dirMissing={missing}
            />
          )}
        </div>
      </div>
    </div>
  );
}
