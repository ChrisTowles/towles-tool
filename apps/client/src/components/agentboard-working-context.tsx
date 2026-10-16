/** The working-context band above the panes — deliberately the rail's folder
 * row at a larger size, sharing its grammar (`agentboard-folder-header.tsx`,
 * the `visual-design` skill). Pane *chrome* is `agentboard-pane.tsx`. */
import { FolderPlusIcon, GitPullRequestIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { Hint } from "@/components/hint";
import { DeletingBadge, GhostBadge, BranchLabel } from "@/components/agentboard-bits/badges";
import {
  BaseMovedChip,
  ComparedBaseBadge,
  CommittedChip,
  UncommittedChip,
} from "@/components/agentboard-bits/diff-chips";
import { FolderLandedBadge } from "@/components/agentboard-bits/landed-badges";
import {
  FilesButton,
  BrowserButton,
  JarvisButton,
  PreviewButton,
} from "@/components/agentboard-bits/pane-buttons";
import { IssueChip, PrChip } from "@/components/agentboard-bits/pr-issue-chips";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { RepoMenu } from "@/components/agentboard-bits/repo-menu";
import { DevServersButton } from "@/components/dev-servers";
import type { NewTaskRepo } from "@/components/inline-new-task";
import type { SessionActions } from "@/lib/agentboard/actions";
import { folderIsHome, pathScope } from "@/lib/agentboard/folder";
import { humanizeFolderName } from "@/lib/agentboard/folder-name";
import {
  folderActionableItems,
  type ActionableItem,
  type ActionableKind,
} from "@/lib/agentboard/landing";
import type { FolderData, RepoData } from "@/lib/agentboard/types";
import type { PrItem, TaskItem } from "@/lib/data";
import { repoBandStyle } from "@/lib/repo-identity";
import { openExternalUrl } from "@/lib/open-url";
import { cn } from "@/lib/utils";

export function WorkingContext({
  repo,
  folder,
  pr,
  task,
  deleting,
  actions,
  onOpenFiles,
  onOpenPreview,
  onOpenJarvis,
  onOpenBrowser,
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
  onOpenFiles: (dir: string) => void;
  onOpenPreview: (dir: string) => void;
  /** Undefined while `agentboard.jarvisPane` is off. */
  onOpenJarvis?: (dir: string) => void;
  onOpenBrowser?: (dir: string) => void;
  onNewSession: (dir: string) => void;
  /** The form renders in the rail, so the caller must expand a collapsed rail
   * itself for this to be visible. */
  onNewTask: (repo: NewTaskRepo) => void;
  onRemoveRepo: (dirs: string[], label: string) => void;
  onDeleteWorktree: (dir: string, label: string) => void;
}) {
  const scope = pathScope(folder.dir);
  // No session/task actions on a ghost checkout whose directory is gone.
  const missing = folder.dirMissing;
  // `~` is no repo: no tasks, no repo menu, and no git line to read.
  const home = folderIsHome(folder);
  // Unlike the rail, this never drops a branch that restates the title: the
  // fallback title *is* the humanized folder name, so a branch slugged from it
  // would leave no actual branch on screen.
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  const displayTitle =
    humanTitle || (folder.isWorktree ? humanizeFolderName(folder.name) : folder.name);
  // A lone clone's folder name *is* the repo name: let the plate be the title
  // rather than printing the same word twice.
  const titled = !home && displayTitle !== repo.name;
  const band = repoBandStyle(repo, "var(--card)");
  const newTask = () => onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
  return (
    // The repo's color the way the rail's repo header wears it: solid edge,
    // faint wash, and the plate's name in it — nothing else on top is tinted.
    <div
      style={band?.band}
      className="flex flex-col gap-1.5 border-b border-l-[3px] border-l-transparent bg-card px-4 py-2"
    >
      <div className="flex items-stretch gap-3">
        <RepoPlate name={home ? "~" : repo.name} scope={scope} inkStyle={band?.ink} />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          {/* Two clusters, not one run of icons: pane openers beside the title,
            checkout-level actions at the right edge, where a destructive-ish
            menu isn't a slip away from what you clicked to read. */}
          <div className="flex items-center gap-2">
            {titled && (
              <Hint label={humanTitle ? folder.name : undefined}>
                <span className="min-w-0 max-w-[28rem] truncate text-lg font-semibold leading-tight">
                  {displayTitle}
                </span>
              </Hint>
            )}
            {missing && <GhostBadge />}
            {!missing && (
              <span className="flex shrink-0 items-center gap-1.5">
                <FilesButton onOpen={() => onOpenFiles(folder.dir)} labeled />
                {folder.hasLaunchConfig && (
                  <PreviewButton onOpen={() => onOpenPreview(folder.dir)} labeled />
                )}
                {onOpenBrowser && (
                  <BrowserButton onOpen={() => onOpenBrowser(folder.dir)} labeled />
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
                  className="hover:text-agent"
                >
                  <PlusIcon className="size-3.5" />
                </IconBtn>
              )}
              {!missing && !home && (
                <IconBtn
                  title="New task — goal, issues, branch"
                  shortcut="ab-new-task"
                  onClick={() => {
                    newTask();
                  }}
                  className="hover:text-agent"
                >
                  <FolderPlusIcon className="size-3.5" />
                </IconBtn>
              )}
              {!home && (
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
              )}
            </div>
          </div>
          {/* Port drift and safe-to-delete get a callout below, not a chip
            here — a chip duplicating its own callout is noise. */}
          {!home && (
            <div className="flex min-w-0 items-center gap-x-2 text-sm text-muted-foreground">
              <div className="flex min-w-0 items-center gap-x-1.5 overflow-hidden">
                {folder.branch && (
                  <BranchLabel branch={folder.branch} isWorktree={folder.isWorktree} />
                )}
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
                <UncommittedChip stats={folder} onOpen={() => onOpenFiles(folder.dir)} labeled />
                <CommittedChip stats={folder} onOpen={() => onOpenFiles(folder.dir)} labeled />
              </div>
            </div>
          )}
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
  );
}

/** Mono at display size, so a repo name reads as the directory name it is, not
 * a headline competing with the title. Never the repo's own hue: the band is
 * already washed in it, and hue-on-hue costs the legibility size bought. */
function RepoPlate({
  name,
  scope,
  inkStyle,
}: {
  name: string;
  scope: string | null;
  inkStyle: CSSProperties | undefined;
}) {
  return (
    <div className="flex shrink-0 flex-col justify-center gap-0.5 border-r border-border/60 pr-3">
      {scope && (
        <span className="font-mono text-micro leading-none tracking-widest text-muted-foreground/70">
          {scope}
        </span>
      )}
      <Hint label={`${scope ?? ""}${name}`}>
        <span
          style={inkStyle}
          className="max-w-[13rem] truncate font-mono text-xl font-semibold leading-none text-foreground"
        >
          {name}
        </span>
      </Hint>
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
    textClass: "text-ok",
    borderClass: "border-ok/40",
  },
  "needs-you": {
    heading: "Needs you",
    glyph: "⚑",
    textClass: "text-warn",
    borderClass: "border-warn/40",
  },
  "port-drift": {
    heading: "Port drift",
    glyph: "⚡",
    textClass: "text-warn",
    borderClass: "border-warn/40",
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
    <div className="flex flex-col gap-1.5">
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
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-mini text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <GitPullRequestIcon className="size-3" />#{item.pr.number}
                </button>
              </Hint>
            )}
            {item.kind === "safe-to-delete" && (
              <Hint label="Delete this worktree — nothing here would be lost">
                <button
                  type="button"
                  onClick={() => onDeleteWorktree(folderDir, folderLabel)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ok/50 bg-ok/10 px-1.5 font-mono text-mini text-ok hover:bg-ok/20"
                >
                  <TrashIcon className="size-3" /> delete
                </button>
              </Hint>
            )}
          </div>
        );
      })}
    </div>
  );
}
