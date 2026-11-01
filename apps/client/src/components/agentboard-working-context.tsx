/** The task header above the panes: what the rail's checkout line leaves out
 * (branch, PR, base, spend) as labeled facts under the task's goal
 * (`agentboard-checkout-line.tsx`, the `visual-design` skill). Pane *chrome*
 * is `agentboard-pane.tsx`. */
import { FolderPlusIcon, GitPullRequestIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Hint } from "@/components/hint";
import { BranchDriftBadge, DeletingBadge, GhostBadge } from "@/components/agentboard-bits/badges";
import {
  BaseMovedChip,
  ComparedBaseBadge,
  CommittedChip,
  CostChip,
  UncommittedChip,
} from "@/components/agentboard-bits/diff-chips";
import { FolderLandedBadge } from "@/components/agentboard-bits/landed-badges";
import {
  FilesButton,
  BrowserButton,
  PreviewButton,
} from "@/components/agentboard-bits/pane-buttons";
import { IssueChip, PrChip } from "@/components/agentboard-bits/pr-issue-chips";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { RepoMenu } from "@/components/agentboard-bits/repo-menu";
import { syncBranch } from "@/components/agentboard-bits/sync-branch";
import { DevServersButton } from "@/components/dev-servers";
import type { NewTaskRepo } from "@/components/inline-new-task";
import type { SessionActions } from "@/lib/agentboard/actions";
import { useDirCost } from "@/lib/agentboard/cost";
import { folderBranchDrift, folderIsHome, pathScope } from "@/lib/agentboard/folder";
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
  const band = repoBandStyle(repo, "var(--card)");
  const newTask = () => onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
  const drift = folderBranchDrift(folder);
  const onSync = syncBranch(folder);
  const cost = useDirCost(folder.dir);
  const clean =
    folder.uncommittedFiles === 0 && folder.committedFiles === 0 && folder.commitsBehind === 0;
  return (
    // The repo's color the way the rail's repo column wears it: solid edge and
    // a faint wash; only the repo name takes its ink.
    <div
      style={band?.band}
      className="flex flex-col gap-3 border-b border-l-[3px] border-l-transparent bg-card px-5 pt-3 pb-3"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-mini text-kumo-subtle">
            <span style={band?.ink} className="shrink-0 font-semibold">
              {scope}
              {home ? "~" : repo.name}
            </span>
            {!home && folder.branch && (
              <>
                <span aria-hidden>/</span>
                <span className="truncate">{folder.branch}</span>
              </>
            )}
          </span>
          <Hint label={humanTitle ? folder.name : undefined}>
            <span className="min-w-0 truncate text-lg font-semibold leading-tight">
              {home ? "Home" : displayTitle}
            </span>
          </Hint>
        </div>
        {missing && <GhostBadge />}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!missing && (
            <>
              <FilesButton onOpen={() => onOpenFiles(folder.dir)} labeled />
              {folder.hasLaunchConfig && (
                <PreviewButton onOpen={() => onOpenPreview(folder.dir)} labeled />
              )}
              {onOpenBrowser && <BrowserButton onOpen={() => onOpenBrowser(folder.dir)} labeled />}
              {/* Always mounted (dimmed sans launch.json) so it stays
                discoverable; the rail's line gates it. */}
              <DevServersButton folder={folder} actions={actions} />
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
            </>
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
      {/* The facts the rail leaves out, each under its own label so they read
        as columns. Port drift and safe-to-delete get a callout below instead. */}
      {!home && !missing && (
        <div className="flex flex-wrap gap-x-10 gap-y-2">
          {(pr || (task?.issues.length ?? 0) > 0) && (
            <Fact label="Pull request">
              {pr && <PrChip pr={pr} stats={folder} />}
              {task?.issues.map((issue) => (
                <IssueChip key={`${issue.repo}#${issue.number}`} taskId={task.id} issue={issue} />
              ))}
              <FolderLandedBadge folder={folder} pr={pr} />
            </Fact>
          )}
          <Fact label="Changes">
            {clean ? (
              <span className="font-mono text-mini text-kumo-subtle">clean</span>
            ) : (
              <>
                <UncommittedChip stats={folder} onOpen={() => onOpenFiles(folder.dir)} labeled />
                <CommittedChip stats={folder} onOpen={() => onOpenFiles(folder.dir)} labeled />
              </>
            )}
          </Fact>
          <Fact label="Base">
            <ComparedBaseBadge folder={folder} />
            <BaseMovedChip stats={folder} />
            {drift && onSync && (
              <BranchDriftBadge recorded={drift.recorded} live={drift.live} onSync={onSync} />
            )}
            {deleting && <DeletingBadge />}
          </Fact>
          {cost && cost.costUsd >= 0.01 && (
            <Fact label="Spend, 30 days">
              <CostChip dir={folder.dir} />
            </Fact>
          )}
        </div>
      )}
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

/** One labeled column of the header's fact row. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-mini text-kumo-subtle">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
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
