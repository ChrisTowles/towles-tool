/**
 * The working-context band above the panes — which checkout the terminals
 * below belong to, what git says about it, and everything you can do to it,
 * plus the full-detail callouts for whatever about it is actionable.
 *
 * The band is the rail's folder row at a larger size and it shares that
 * row's grammar deliberately (identity left, counts right, controls
 * trailing) — see `agentboard-folder-header.tsx` and the `folder-rail-ui`
 * skill. Pane *chrome* (one session's header, the cold-cache overlay) is
 * `agentboard-pane.tsx`.
 */
import { FolderGit2, FolderPlus, GitPullRequest, Plus, Trash2 } from "lucide-react";
import {
  BaseMovedChip,
  ComparedBaseBadge,
  DeletingBadge,
  CommittedChip,
  UncommittedChip,
  FilesButton,
  JarvisButton,
  FolderLandedBadge,
  GhostBadge,
  IconBtn,
  IssueChip,
  PreviewButton,
  PrChip,
  RepoMenu,
  BranchLabel,
} from "@/components/agentboard-bits";
import { DevServersButton } from "@/components/dev-servers";
import type { NewTaskRepo } from "@/components/inline-new-task";
import {
  folderActionableItems,
  humanizeFolderName,
  pathScope,
  type ActionableItem,
  type ActionableKind,
  type FolderData,
  type RepoData,
  type SessionActions,
} from "@/lib/agentboard";
import type { PrItem, TaskItem } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { mouseAction } from "@/lib/shortcut-coach";
import { withHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** The working-context band atop the main pane: *where am I working*. Leads
 * with the focused checkout name, with the repo, branch and git facts on a
 * quieter line below it. One glance answers which checkout the terminals below
 * belong to; *what you set out to do there* is the Board task's job. The
 * trailing action cluster mirrors the rail's options for this checkout — new
 * session, new task, and the shared "···" RepoMenu — so every repo-rail option
 * stays reachable atop the panes even when the rail is collapsed or the
 * folder's row is scrolled out of view.
 *
 * **Two lines, and the same grammar as a rail row at a larger size**: identity
 * and its links on the left, git's counts right-aligned, controls at the
 * trailing edge. It used to be a `flex-wrap` run of fourteen possible chips
 * that reliably ran to three lines — facts, actions, links and alerts
 * interleaved with nothing separating them, in bordered pills identical to
 * the buttons beside them. The band is the most-repeated ~90px on the screen
 * and it sits directly above the work, so what it costs has to be earned; see
 * the "a box is a control or an alert" rule in the `folder-rail-ui` skill,
 * which this shares with the rail. Labels stay here (`labeled` on the chips) —
 * that part is a width budget, and this surface has the width. */
export function WorkingContext({
  repo,
  folder,
  pr,
  task,
  deleting,
  actions,
  onOpenDiff,
  onOpenFiles,
  onOpenPreview,
  onOpenJarvis,
  onNewSession,
  onNewTask,
  onRemoveRepo,
  onDeleteWorktree,
}: {
  repo: RepoData;
  folder: FolderData;
  pr?: PrItem;
  /** The board task bound to this checkout's worktree, when one exists —
   * source of the linked-issue chips, the "Attach issue…" target, and (for a
   * worktree) the human-authored title shown on line 1 — see the rail's
   * `FolderHeader` for the same derivation. */
  task?: TaskItem;
  /** This worktree's `task_delete` is in flight — mirrors the rail's
   * `DeletingBadge` gating. */
  deleting?: boolean;
  /** Session lifecycle dispatch — the dev-servers popover launches/focuses
   * through it. */
  actions: SessionActions;
  /** Opens the folder's diff pane in its focused window. */
  onOpenDiff: (dir: string) => void;
  /** Opens the folder's files pane in its focused window. */
  onOpenFiles: (dir: string) => void;
  /** Opens the folder's live-preview pane in its focused window. */
  onOpenPreview: (dir: string) => void;
  /** Opens the folder's rendered-agent pane. */
  /** Opens the folder's native (Bevy) pane — undefined while
   * `agentboard.jarvisPane` is off, which is what hides the entry point
   * entirely rather than offering one that does nothing. */
  onOpenJarvis?: (dir: string) => void;
  /** Starts a new session (shell) in this checkout. */
  onNewSession: (dir: string) => void;
  /** Toggles the inline new-task form open/closed for this repo (worktree
   * hub) — never a blocking modal, see InlineNewTask. The form itself still
   * renders in the rail under the repo's header, so this only opens it when
   * the rail is expanded; the caller is responsible for expanding a
   * collapsed rail first if it wants the form to be visible. */
  onNewTask: (repo: NewTaskRepo) => void;
  /** Untracks this checkout from the rail. */
  onRemoveRepo: (dirs: string[], label: string) => void;
  /** Deletes a worktree from disk (guarded `task_delete`). */
  onDeleteWorktree: (dir: string, label: string) => void;
}) {
  const scope = pathScope(folder.dir);
  // A task/worktree has a distinct checkout name; a lone clone shares the
  // repo's, so we don't repeat it on the line below.
  const repoDistinct = folder.name !== repo.name;
  // Same gating as the rail headers: no session/task actions on a ghost
  // checkout whose directory is gone.
  const missing = folder.dirMissing;
  // Same title derivation as the rail's `FolderHeader` — a worktree task's
  // human-authored title takes line 1, falling back to the folder name read
  // as words. Unlike the rail, this header does *not* drop a branch that
  // merely restates the title: the fallback title is the folder name
  // humanized (prefix stripped, dashes to spaces), so a task whose branch
  // slugged to its folder name would show nothing on screen that is actually
  // the branch — and `vs main` beside it reads like one. This is the header
  // for the checkout you're looking at, so it always names the branch; a long
  // one truncates here like everywhere else, with `BranchLabel`'s tooltip
  // holding the verbatim answer.
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  const displayTitle =
    humanTitle || (folder.isWorktree ? humanizeFolderName(folder.name) : folder.name);
  const newTask = () => onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
  return (
    <div className="flex items-start gap-3 border-b bg-card px-4 py-2">
      <FolderGit2 className="mt-1 size-4 shrink-0 text-violet-500" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Line 1: the checkout, and everything you can do to it — the pane
            openers, then the action cluster mirroring the rail's. `text-lg`,
            not the `text-2xl` this used to be: the title is the most static
            thing on the screen (you just clicked it in the rail) and the
            panes below are the work, so it anchors without shouting, and the
            band costs ~64px instead of ~90px. */}
        <div className="flex items-center gap-2">
          <span
            title={humanTitle ? folder.name : undefined}
            className="min-w-0 flex-1 truncate text-lg font-semibold leading-tight"
          >
            {displayTitle}
          </span>
          {missing && <GhostBadge />}
          {!missing && (
            <span className="flex shrink-0 items-center gap-1.5">
              <FilesButton onOpen={() => onOpenFiles(folder.dir)} labeled />
              {folder.hasLaunchConfig && (
                <PreviewButton onOpen={() => onOpenPreview(folder.dir)} labeled />
              )}
              {onOpenJarvis && <JarvisButton onOpen={() => onOpenJarvis(folder.dir)} labeled />}
            </span>
          )}
          {/* Always mounted (dimmed sans launch.json) so the dev-servers
              feature is discoverable; the dense rail stays gated. */}
          {!missing && <DevServersButton folder={folder} actions={actions} />}
          {!missing && (
            <IconBtn
              title={withHint("New session", "ab-new-session")}
              onClick={() => {
                mouseAction("ab-new-session", "agentboard");
                onNewSession(folder.dir);
              }}
              className="hover:text-violet-500"
            >
              <Plus className="size-3.5" />
            </IconBtn>
          )}
          {!missing && (
            <IconBtn
              title={withHint("New task — goal, issues, branch", "ab-new-task")}
              onClick={() => {
                mouseAction("ab-new-task", "agentboard");
                newTask();
              }}
              className="hover:text-violet-500"
            >
              <FolderPlus className="size-3.5" />
            </IconBtn>
          )}
          <RepoMenu
            path={folder.dir}
            dir={folder.dir}
            isWorktree={folder.isWorktree}
            quiet={folder.quiet}
            onNewTask={!missing ? newTask : undefined}
            onDeleteWorktree={
              !missing && folder.isWorktree
                ? () => onDeleteWorktree(folder.dir, folder.name)
                : undefined
            }
            onRemove={() => onRemoveRepo([folder.dir], folder.name)}
            taskId={!missing ? task?.id : undefined}
          />
        </div>
        {/* Line 2: what this checkout *is* on the left, what git says it holds
            on the right — the same split the rail row uses, so the two
            surfaces read as one grammar at two sizes. `vs <base>` and the
            base-moved chip sit together because they are one sentence
            ("measured against main, which is 3 ahead"), and the counts are
            right-aligned so their column is stable while the numbers change.
            Port drift and safe-to-delete are deliberately *not* here: they get
            a full callout below, and a chip that duplicates its own callout
            three lines later is noise standing where a fact should be. */}
        <div className="flex min-w-0 items-center gap-x-2 text-sm text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-x-1.5 overflow-hidden">
            {scope && <span className="shrink-0 font-mono text-muted-foreground/60">{scope}</span>}
            {repoDistinct && <span className="shrink-0 font-medium">{repo.name}</span>}
            {folder.branch && <BranchLabel branch={folder.branch} isWorktree={folder.isWorktree} />}
            {deleting && <DeletingBadge />}
            <ComparedBaseBadge folder={folder} />
            <BaseMovedChip stats={folder} />
            {pr && <PrChip pr={pr} stats={folder} />}
            {task?.issues.map((issue) => (
              <IssueChip key={`${issue.repo}#${issue.number}`} taskId={task.id} issue={issue} />
            ))}
            <FolderLandedBadge folder={folder} pr={pr} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <UncommittedChip stats={folder} onOpen={() => onOpenDiff(folder.dir)} labeled />
            <CommittedChip stats={folder} onOpen={() => onOpenDiff(folder.dir)} labeled />
          </div>
        </div>
        {!missing && (
          <ActionableCallouts
            items={folderActionableItems(folder, pr)}
            folderDir={folder.dir}
            folderLabel={folder.name}
            onDeleteWorktree={onDeleteWorktree}
          />
        )}
      </div>
    </div>
  );
}

const ACTIONABLE_META: Record<
  ActionableKind,
  { heading: string; glyph: string; textClass: string; borderClass: string }
> = {
  "safe-to-delete": {
    heading: "Safe to delete",
    glyph: "✓",
    textClass: "text-emerald-600 dark:text-emerald-400",
    borderClass: "border-emerald-500/40",
  },
  "needs-you": {
    heading: "Needs you",
    glyph: "⚑",
    textClass: "text-amber-500",
    borderClass: "border-amber-500/40",
  },
  "port-drift": {
    heading: "Port drift",
    glyph: "⚡",
    textClass: "text-amber-500",
    borderClass: "border-amber-500/40",
  },
};

/** The working-context band's actionable section: a full-detail callout per
 * `ActionableItem` (usually at most one or two at once), replacing the rail
 * row's cramped badge with the room to say *why*. Only rendered for the
 * focused checkout — the rail keeps its own badges for scanning every other
 * folder at a glance. */
function ActionableCallouts({
  items,
  folderDir,
  folderLabel,
  onDeleteWorktree,
}: {
  items: ActionableItem[];
  folderDir: string;
  folderLabel: string;
  onDeleteWorktree: (dir: string, label: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {items.map((item) => {
        const meta = ACTIONABLE_META[item.kind];
        return (
          <div
            key={item.kind}
            className={cn(
              "flex items-center gap-2 rounded-md border border-l-2 bg-card px-2.5 py-1.5 text-xs",
              meta.borderClass,
            )}
          >
            <span className={cn("shrink-0 font-mono text-sm", meta.textClass)}>{meta.glyph}</span>
            <span className={cn("shrink-0 font-medium", meta.textClass)}>{meta.heading}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.subtitle}</span>
            {item.pr && (
              <button
                type="button"
                onClick={() => void openExternalUrl(item.pr!.url)}
                title={`Open PR #${item.pr.number} on GitHub`}
                className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <GitPullRequest className="size-3" />#{item.pr.number}
              </button>
            )}
            {item.kind === "safe-to-delete" && (
              <button
                type="button"
                onClick={() => onDeleteWorktree(folderDir, folderLabel)}
                title="Delete this worktree — nothing here would be lost"
                className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 font-mono text-[10.5px] text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
              >
                <Trash2 className="size-3" /> delete
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
