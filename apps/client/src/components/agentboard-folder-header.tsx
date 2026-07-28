/**
 * A checkout's header row — the rail's densest row, and the one the
 * `folder-rail-ui` skill's layout rules are mostly about. Three blocks: who
 * this checkout is (title, PR/issue links), what git says about it (branch,
 * base-moved, uncommitted, committed), and what you can do to it (dev
 * servers, new session, new task, the kebab).
 *
 * A repo with a single checkout renders this at `scope="repo"` instead of a
 * separate repo header, which is why identity, accent and the toolbar all
 * branch on `scope`.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Folder, FolderPlus, FolderX, Plus, Trash2 } from "lucide-react";
import {
  AgentStatusLine,
  BaseMovedChip,
  BranchLabel,
  Chevron,
  CollapsedLive,
  CommittedChip,
  DeletingBadge,
  SettingUpBadge,
  FilesButton,
  FolderLandedBadge,
  GhostBadge,
  IconBtn,
  IssueChip,
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
  folderPortDrift,
  folderSafeToDelete,
  humanizeFolderName,
  pathScope,
  type FolderData,
  type SessionActions,
} from "@/lib/agentboard";
import { storeUpdateTask, type PrItem, type TaskItem } from "@/lib/data";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";

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
  settingUpSince,
  actions,
  onToggle,
  onNewSession,
  onNewTask,
  onRemoveRepo,
  onDeleteWorktree,
  onOpenDiff,
  onOpenFiles,
  onOpenPreview,
  onOpenJarvis,
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
  /** This worktree's `task_delete` is in flight — the caller already dims and
   * disables the whole row (`pointer-events-none opacity-50`); this just adds
   * the `DeletingBadge` label explaining why. */
  deleting?: boolean;
  /** Live phase text for the in-flight delete ("running teardown command",
   * "deleting git worktree", …) — passed to `DeletingBadge`, which falls
   * back to a static label when absent (no phase event has landed yet). */
  deletingLabel?: string;
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
  /** Opens the folder's diff pane in its focused window. */
  onOpenDiff: () => void;
  /** Opens the folder's files pane in its focused window. */
  onOpenFiles: () => void;
  /** Opens the folder's live-preview pane in its focused window. */
  onOpenPreview: () => void;
  /** Opens the folder's native (Bevy) pane — undefined while
   * `agentboard.jarvisPane` is off. */
  onOpenJarvis?: () => void;
}) {
  const scopePrefix = pathScope(folder.dir);
  const progress = folder.metadata?.progress;
  // Repo identity, repo scope only. A repo-scope header is sticky, so its
  // tint must mix into an opaque base (see the background comment below).
  const HeaderIcon = repoIcon(meta);
  const accent = repoAccentStyles(meta, "var(--card)");
  // Ghost checkout: the tracked directory is gone. Dim the whole band and
  // swap the git-facts line (branch/diff are meaningless) for an inline
  // Untrack — a dead folder's one useful action, surfaced not buried.
  const missing = folder.dirMissing;
  // A worktree task's real, human-authored title — never substituted for the
  // primary checkout's own header (its `title` is the repo's actual name, not
  // a slug, and a task-only task can bind to it too — see `taskForFolder` —
  // so showing a stray task's title there would misname the repo itself).
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  // Git's own term for this checkout (git-worktree(1): "main worktree", as
  // opposed to a "linked worktree") — shortened to "Root" so the sub-header
  // reads as a distinct entry instead of just repeating the repo-scope title
  // above it. Only at folder scope: the solo repo-scope header already shows
  // `repo.name` with nothing to disambiguate against.
  const isMainWorktreeSubrow = scope === "folder" && !folder.isWorktree;
  const displayTitle =
    humanTitle ||
    (folder.isWorktree ? humanizeFolderName(title) : isMainWorktreeSubrow ? "Root" : title);
  // Once a real title is shown, the branch is no longer restating the same
  // information under a different name — always keep it visible. Falling
  // back to the de-slugified name (no task/title at all) is still the same
  // information reformatted, so the existing redundancy check still applies.
  // "Root" never restates the branch, so it always keeps the branch label too.
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
    // Name, git facts and controls on one line when the rail is wide enough,
    // the git facts wrapping to a second line when it isn't — see the row
    // comment below. The transparent border-l-2 is always present so the
    // active violet edge never shifts content.
    <div
      style={
        // Identity never outranks true status: an amber needs-you count or a
        // missing checkout keep the row to themselves. Being the active
        // selection is a ring layered on top, not a fill, so it doesn't erase
        // the identity wash.
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
                title={humanTitle ? folder.name : undefined}
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
            {onRemoveRepo && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveRepo();
                }}
                title="Untrack this checkout — remove it from the rail"
                className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="size-3" /> Untrack
              </button>
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
            {deleting && <DeletingBadge label={deletingLabel} />}
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
            {typeof progress?.percent === "number" && (
              <span
                title={progress.label ?? "agent-reported progress"}
                className="shrink-0 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 font-mono text-[10.5px] text-violet-500"
              >
                {Math.round(progress.percent)}%{progress.label ? ` ${progress.label}` : ""}
              </span>
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
              title={`New session (${shortcutHint("ab-new-session")})`}
              onClick={() => {
                mouseAction("ab-new-session", "agentboard");
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
              title={`New task — goal, issues, branch (${shortcutHint("ab-new-task")})`}
              onClick={() => {
                mouseAction("ab-new-task", "agentboard");
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
              onDeleteWorktree={!missing ? onDeleteWorktree : undefined}
              taskId={!missing ? task?.id : undefined}
            />
          )}
        </div>
      </div>
      {/* The agent's own status line (ab_set_status), when one was pushed. */}
      <div className="ml-11 empty:hidden [&:not(:empty)]:pb-1.5">
        <AgentStatusLine metadata={folder.metadata} now={now} />
      </div>
    </div>
  );
}
