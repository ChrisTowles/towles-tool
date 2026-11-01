import { Result } from "effect";
// A checkout as one line under its repo: name, its sessions inline, then what
// needs saying about it. Branch, PR, base and spend live in the task header.
import { useState, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import { TrashIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import {
  CreatingBadge,
  DeletingBadge,
  DetachedActions,
  DetachedBadge,
  GhostBadge,
  NoTaskBadge,
  PortDriftBadge,
  QuietBadge,
  SettingUpBadge,
} from "@/components/agentboard-bits/badges";
import { CommittedChip, UncommittedChip } from "@/components/agentboard-bits/diff-chips";
import { FolderLandedBadge, SafeToDeleteBadge } from "@/components/agentboard-bits/landed-badges";
import {
  BrowserButton,
  FilesButton,
  PreviewButton,
} from "@/components/agentboard-bits/pane-buttons";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { RepoMenu } from "@/components/agentboard-bits/repo-menu";
import { DevServersButton } from "@/components/dev-servers";
import { Input } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { SessionActions } from "@/lib/agentboard/actions";
import {
  comparedBaseLabel,
  folderCreating,
  folderDetached,
  folderIsUnclaimed,
  folderRemoving,
} from "@/lib/agentboard/folder";
import { humanizeFolderName } from "@/lib/agentboard/folder-name";
import { folderSafeToDelete } from "@/lib/agentboard/landing";
import { folderPortDrift } from "@/lib/agentboard/session";
import { collapsedLiveColor } from "@/lib/agentboard/status";
import type { FolderData } from "@/lib/agentboard/types";
import { storeUpdateTask, type PrItem, type TaskItem } from "@/lib/data";

export function CheckoutLine({
  title,
  folder,
  quiet,
  needs,
  pr,
  task,
  active,
  cursor,
  now,
  deleting,
  deletingLabel,
  onAdoptWorktree,
  settingUpSince,
  actions,
  onSelect,
  onNewSession,
  onRemoveRepo,
  onDeleteWorktree,
  onRecreateWorktree,
  onOpenFiles,
  onOpenPreview,
  onOpenBrowser,
  children,
}: {
  title: string;
  folder: FolderData;
  /** Marked quiet *and* on screen anyway — peeked, or the active checkout. */
  quiet?: boolean;
  needs: number;
  pr?: PrItem;
  task?: TaskItem;
  active: boolean;
  /** Under the rail cursor — the line the arrows are steering. */
  cursor: boolean;
  now: number;
  /** The caller already dims and disables the whole line. */
  deleting?: boolean;
  deletingLabel?: string;
  /** Absent when the line isn't a detected one. */
  onAdoptWorktree?: () => void;
  /** Epoch ms; absent means nothing is installing. */
  settingUpSince?: number;
  actions: SessionActions;
  onSelect: () => void;
  onNewSession: () => void;
  onRemoveRepo?: () => void;
  /** Set only on worktree checkouts: untracking one makes no sense. */
  onDeleteWorktree?: () => void;
  /** Set only on a `no worktree` task row. */
  onRecreateWorktree?: () => void;
  onOpenFiles: () => void;
  onOpenPreview: () => void;
  onOpenBrowser?: () => void;
  /** The session and view-pane chips. */
  children: ReactNode;
}) {
  const missing = folder.dirMissing;
  // A task's title names worktree lines only; on the primary it would misname
  // the repo itself (see `taskForFolder`).
  const humanTitle = folder.isWorktree ? task?.text?.trim() : undefined;
  const displayTitle =
    humanTitle || (folder.isWorktree ? humanizeFolderName(title) : folder.branch || "Root");
  const liveColor = collapsedLiveColor(folder.sessions);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  function startRename() {
    if (!task || missing) return;
    setRenameValue(task.text);
    setRenaming(true);
  }

  async function commitRename() {
    setRenaming(false);
    const trimmed = renameValue.trim();
    if (!task || !trimmed || trimmed === task.text) return;
    const result = await storeUpdateTask(task.id, trimmed, task.notes);
    if (Result.isFailure(result)) toast.error(`Couldn't rename — ${result.failure.message}`);
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHovered(false);
      }}
      className={cn(
        "@container/line relative border-l-2 border-transparent pr-3 pl-2",
        hovered && "bg-kumo-tint/50",
        active && "border-l-agent bg-kumo-tint/60",
        needs > 0 && "border-l-warn bg-warn/10",
        cursor && "ring-1 ring-inset ring-agent",
      )}
    >
      <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-1 @[24rem]/line:grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)_auto]">
        <div className={cn("flex min-w-0 items-center gap-2", missing && "opacity-60")}>
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", liveColor ?? "bg-muted-foreground/40")}
          />
          {renaming ? (
            <Input
              size="xs"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={() => void commitRename()}
              className="min-w-0 flex-1"
              aria-label="Rename task"
            />
          ) : (
            <Hint label={folder.branch ?? folder.dir} side="right">
              <button
                type="button"
                onClick={onSelect}
                onDoubleClick={startRename}
                className={cn(
                  "min-w-0 truncate text-left text-sm",
                  active ? "font-semibold text-kumo-default" : "text-kumo-default",
                  missing && "line-through decoration-muted-foreground/40",
                )}
              >
                {displayTitle}
              </button>
            </Hint>
          )}
          {missing && <GhostBadge />}
          {quiet && !missing && <QuietBadge />}
        </div>

        <div className="order-last col-span-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 @[24rem]/line:order-none @[24rem]/line:col-span-1">
          {children}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-x-1.5 font-mono text-mini">
          {missing ? (
            <>
              <span className="text-kumo-subtle italic">directory missing</span>
              {folder.record.origin === "checkout"
                ? onRemoveRepo && (
                    <Hint label="Untrack this checkout — remove it from the rail">
                      <button
                        type="button"
                        onClick={onRemoveRepo}
                        className="flex h-5 items-center gap-1 rounded-md border border-border/70 px-1.5 text-kumo-subtle hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                      >
                        <TrashIcon className="size-3" /> Untrack
                      </button>
                    </Hint>
                  )
                : folderDetached(folder) && (
                    <>
                      <DetachedBadge />
                      <DetachedActions onRecreate={onRecreateWorktree} onClose={onDeleteWorktree} />
                    </>
                  )}
            </>
          ) : (
            <>
              {folderRemoving(folder) && <DeletingBadge label={deletingLabel} />}
              {folderCreating(folder) && <CreatingBadge label={deletingLabel} />}
              {folderIsUnclaimed(folder) && <NoTaskBadge onAdopt={onAdoptWorktree} />}
              {settingUpSince !== undefined && !deleting && (
                <SettingUpBadge since={settingUpSince} now={now} />
              )}
              {folder.hasPortDrift && <PortDriftBadge drift={folderPortDrift(folder)} />}
              <FolderLandedBadge folder={folder} pr={pr} />
              {folder.isWorktree && onDeleteWorktree && folderSafeToDelete(folder, pr) && (
                <SafeToDeleteBadge
                  base={comparedBaseLabel(folder)}
                  landed={folder.landed}
                  onDeleteWorktree={onDeleteWorktree}
                />
              )}
              <UncommittedChip stats={folder} onOpen={onOpenFiles} />
              {/* With no commits the chip's word is just a files opener, which
                  the hover toolbar already has. */}
              {folder.commitsAhead > 0 && <CommittedChip stats={folder} onOpen={onOpenFiles} />}
            </>
          )}
        </div>
      </div>

      {/* Actions overlay the facts on hover or focus rather than reserving a
          column, so a resting line spends its width on names. */}
      {hovered && !renaming && (
        <div className="absolute top-1 right-2 z-10 flex items-center gap-1 rounded-md bg-kumo-tint pl-1.5">
          {!missing && (
            <>
              <FilesButton onOpen={onOpenFiles} />
              {folder.hasLaunchConfig && <PreviewButton onOpen={onOpenPreview} />}
              {onOpenBrowser && <BrowserButton onOpen={onOpenBrowser} />}
              {folder.hasLaunchConfig && (
                <DevServersButton folder={folder} actions={actions} ghost />
              )}
              <IconBtn
                ghost
                title="New session"
                shortcut="ab-new-session"
                onClick={onNewSession}
                className="hover:text-agent"
              >
                <PlusIcon className="size-3.5" />
              </IconBtn>
            </>
          )}
          {onRemoveRepo && (
            <RepoMenu
              ghost
              path={folder.dir}
              onRemove={onRemoveRepo}
              dir={folder.dir}
              isWorktree={folder.isWorktree}
              quiet={folder.quiet}
              // Every item needs a directory except closing the task out,
              // which is the one thing a detached line is *for*.
              onDeleteWorktree={!missing || folderDetached(folder) ? onDeleteWorktree : undefined}
              deleteLabel={missing ? "Close task…" : undefined}
              taskId={!missing ? task?.id : undefined}
              dirMissing={missing}
            />
          )}
        </div>
      )}
    </div>
  );
}
