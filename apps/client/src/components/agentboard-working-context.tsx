/**
 * The working-context band above the panes — deliberately the rail's folder row
 * at a larger size, sharing its grammar (`agentboard-folder-header.tsx`, the
 * `folder-rail-ui` skill). Pane *chrome* is `agentboard-pane.tsx`.
 */
import { FolderGit2, FolderPlus, GitPullRequest, Plus, Trash2 } from "lucide-react";
import { Hint } from "@/components/hint";
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
import { cn } from "@/lib/utils";

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
  task?: TaskItem;
  deleting?: boolean;
  actions: SessionActions;
  onOpenDiff: (dir: string) => void;
  onOpenFiles: (dir: string) => void;
  onOpenPreview: (dir: string) => void;
  /** Undefined while `agentboard.jarvisPane` is off. */
  onOpenJarvis?: (dir: string) => void;
  onNewSession: (dir: string) => void;
  /** The form renders in the rail, so the caller must expand a collapsed rail
   * itself for this to be visible. */
  onNewTask: (repo: NewTaskRepo) => void;
  onRemoveRepo: (dirs: string[], label: string) => void;
  onDeleteWorktree: (dir: string, label: string) => void;
}) {
  const scope = pathScope(folder.dir);
  // A lone clone shares the repo's name; don't repeat it on the line below.
  const repoDistinct = folder.name !== repo.name;
  // No session/task actions on a ghost checkout whose directory is gone.
  const missing = folder.dirMissing;
  // Unlike the rail, this never drops a branch that restates the title: the
  // fallback title *is* the humanized folder name, so a branch slugged from it
  // would leave no actual branch on screen.
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  const displayTitle =
    humanTitle || (folder.isWorktree ? humanizeFolderName(folder.name) : folder.name);
  const newTask = () => onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
  return (
    <div className="flex items-start gap-3 border-b bg-card px-4 py-2">
      <FolderGit2 className="mt-1 size-4 shrink-0 text-violet-500" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Two clusters, not one run of icons: pane openers beside the title,
            checkout-level actions at the right edge, where a destructive-ish
            menu isn't a slip away from what you clicked to read. */}
        <div className="flex items-center gap-2">
          <Hint label={humanTitle ? folder.name : undefined}>
            <span className="min-w-0 max-w-[28rem] truncate text-lg font-semibold leading-tight">
              {displayTitle}
            </span>
          </Hint>
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
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Always mounted (dimmed sans launch.json) so it stays
                discoverable; the dense rail stays gated. */}
            {!missing && <DevServersButton folder={folder} actions={actions} />}
            {!missing && (
              <IconBtn
                title="New session"
                shortcut="ab-new-session"
                onClick={() => {
                  onNewSession(folder.dir);
                }}
                className="hover:text-violet-500"
              >
                <Plus className="size-3.5" />
              </IconBtn>
            )}
            {!missing && (
              <IconBtn
                title="New task — goal, issues, branch"
                shortcut="ab-new-task"
                onClick={() => {
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
              dirMissing={missing}
            />
          </div>
        </div>
        {/* Port drift and safe-to-delete get a callout below, not a chip
            here — a chip duplicating its own callout is noise. */}
        <div className="flex min-w-0 items-center gap-x-2 text-sm text-muted-foreground">
          <div className="flex min-w-0 items-center gap-x-1.5 overflow-hidden">
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

/** One full-detail callout per `ActionableItem` — the room to say *why* that
 * the rail's cramped badge doesn't have. Focused checkout only. */
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
              <Hint label={`Open PR #${item.pr.number} on GitHub`}>
                <button
                  type="button"
                  onClick={() => void openExternalUrl(item.pr!.url)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <GitPullRequest className="size-3" />#{item.pr.number}
                </button>
              </Hint>
            )}
            {item.kind === "safe-to-delete" && (
              <Hint label="Delete this worktree — nothing here would be lost">
                <button
                  type="button"
                  onClick={() => onDeleteWorktree(folderDir, folderLabel)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 font-mono text-[10.5px] text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
                >
                  <Trash2 className="size-3" /> delete
                </button>
              </Hint>
            )}
          </div>
        );
      })}
    </div>
  );
}
