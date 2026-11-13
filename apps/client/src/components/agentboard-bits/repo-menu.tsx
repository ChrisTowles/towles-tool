import { Result } from "effect";
import { useState } from "react";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  DotsThreeVerticalIcon,
  FolderPlusIcon,
  HourglassIcon,
  PauseCircleIcon,
  ProhibitIcon,
  LinkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { Button, DropdownMenu } from "@cloudflare/kumo";
import { Hint } from "@/components/hint";
import { toast } from "@/lib/toast";
import { abSyncRepo } from "@/lib/agentboard/ipc";
import { openInExternalEditor } from "@/lib/external-editor";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { PARK_LABEL, savePark, saveUnpark } from "@/lib/agentboard/park";
import type { QueuePark } from "@/lib/schemas/queue";
import { uiAction } from "@/lib/ui-action";
import { ParkDialog } from "./park-dialog";
import { AttachIssueDialog } from "./pr-issue-chips";

/** The one place every secondary action for a checkout lives, shared verbatim by
 * the rail's headers and the working-context band so the two can't diverge. */
export function RepoMenu({
  path,
  onRemove,
  onArchive,
  dir,
  isWorktree,
  park,
  taskTitle,
  onNewTask,
  onDeleteWorktree,
  deleteLabel,
  taskId,
  dirMissing,
  ghost = false,
}: {
  path?: string;
  onRemove: () => void;
  /** Set only on a repo header: archive covers the whole repo, never one checkout. */
  onArchive?: () => void;
  dir: string;
  /** No "Remove from rail": auto-discovered, they reappear next poll. */
  isWorktree?: boolean;
  /** The task's park, when `taskId` is set; null when it is in the list. */
  park?: QueuePark | null;
  /** Names the task in "Park…". */
  taskTitle?: string;
  /** Set only on a task-convention repo. */
  onNewTask?: () => void;
  /** Set only on worktree checkouts. */
  onDeleteWorktree?: () => void;
  /** A detached row's directory is gone, so "Delete worktree…" would lie. */
  deleteLabel?: string;
  /** Enables "Attach issue…" — an issue can only be linked to a task. */
  taskId?: number;
  /** A gone directory can't be opened in an editor, so the item hides. */
  dirMissing?: boolean;
  /** See [`IconBtn`]'s `ghost`. */
  ghost?: boolean;
}) {
  const [attachOpen, setAttachOpen] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);

  async function syncNow() {
    Result.match(await abSyncRepo(dir), {
      onSuccess: (result) => {
        // Already in flight elsewhere — ignore rather than double-toast.
        if (!result.started) return;
        if (result.ok) toast.success("Synced with GitHub");
        else toast.error(result.message ?? "Sync failed");
      },
      onFailure: (e) => toast.error(e.message),
    });
  }

  return (
    <>
      <DropdownMenu>
        <Hint label="More actions">
          <DropdownMenu.Trigger
            render={
              <Button
                variant={ghost ? "ghost" : "outline"}
                size="xs"
                shape="square"
                aria-label="More actions"
                className="text-kumo-subtle"
                icon={<DotsThreeVerticalIcon className="size-3.5" />}
              />
            }
          />
        </Hint>
        <DropdownMenu.Content align="end" className="w-auto min-w-56">
          {path && (
            <>
              <DropdownMenu.Group>
                <DropdownMenu.Label className="font-mono text-mini font-normal whitespace-nowrap text-kumo-subtle">
                  {path}
                </DropdownMenu.Label>
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
            </>
          )}
          {!dirMissing && (
            <DropdownMenu.Item
              onClick={() => void openInExternalEditor(dir, { where: "rail.menu" })}
              className="whitespace-nowrap"
              icon={<ArrowSquareOutIcon className="size-3.5" />}
            >
              Open in external editor
            </DropdownMenu.Item>
          )}
          {onNewTask && (
            <DropdownMenu.Item
              onClick={() => {
                mouseAction("ab-new-task", "agentboard");
                onNewTask();
              }}
              className="whitespace-nowrap"
              icon={<FolderPlusIcon className="size-3.5" />}
            >
              New task…
              <span className="ml-auto text-xs text-kumo-subtle">
                {shortcutHint("ab-new-task")}
              </span>
            </DropdownMenu.Item>
          )}
          {onDeleteWorktree && (
            <DropdownMenu.Item
              variant="danger"
              onClick={() => {
                mouseAction("ab-remove-task", "agentboard");
                onDeleteWorktree();
              }}
              className="whitespace-nowrap"
              icon={<TrashIcon className="size-3.5" />}
            >
              {deleteLabel ?? "Delete worktree…"}
              <span className="ml-auto text-xs text-kumo-subtle">
                {shortcutHint("ab-remove-task")}
              </span>
            </DropdownMenu.Item>
          )}
          {(!dirMissing || onNewTask || onDeleteWorktree) && <DropdownMenu.Separator />}
          <DropdownMenu.Item
            onClick={() => void syncNow()}
            className="whitespace-nowrap"
            icon={<ArrowClockwiseIcon className="size-3.5" />}
          >
            Sync now
          </DropdownMenu.Item>
          {taskId != null && (
            <DropdownMenu.Item
              onClick={() => setAttachOpen(true)}
              className="whitespace-nowrap"
              icon={<LinkIcon className="size-3.5" />}
            >
              Attach issue…
            </DropdownMenu.Item>
          )}
          {taskId != null && park && (
            <DropdownMenu.Item
              onClick={() => {
                mouseAction("ab-park-task", "agentboard");
                void saveUnpark(taskId);
              }}
              className="whitespace-nowrap"
              icon={<ArrowUUpLeftIcon className="size-3.5" />}
            >
              Unpark
              <span className="ml-auto text-xs text-kumo-subtle">
                {shortcutHint("ab-park-task")}
              </span>
            </DropdownMenu.Item>
          )}
          {taskId != null && !park && (
            <>
              <DropdownMenu.Item
                onClick={() => {
                  mouseAction("ab-park-task", "agentboard");
                  void savePark(taskId, "later");
                }}
                className="whitespace-nowrap"
                icon={<HourglassIcon className="size-3.5" />}
              >
                {PARK_LABEL.later.verb}
                <span className="ml-auto text-xs text-kumo-subtle">
                  {shortcutHint("ab-park-task")}
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onClick={() => {
                  uiAction("task.park_menu", "agentboard", "blocked");
                  void savePark(taskId, "blocked");
                }}
                className="whitespace-nowrap"
                icon={<ProhibitIcon className="size-3.5" />}
              >
                {PARK_LABEL.blocked.verb}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onClick={() => {
                  uiAction("task.park_menu", "agentboard", "dialog");
                  setParkOpen(true);
                }}
                className="whitespace-nowrap"
                icon={<PauseCircleIcon className="size-3.5" />}
              >
                Park…
              </DropdownMenu.Item>
            </>
          )}
          {/* Same glyph the rail's Archived list wears, so "where did it go"
              and "bring it back" read as one feature. */}
          {onArchive && (
            <DropdownMenu.Item
              onClick={onArchive}
              className="whitespace-nowrap"
              icon={<ArchiveIcon className="size-3.5" />}
            >
              Archive repo
            </DropdownMenu.Item>
          )}
          {!isWorktree && (
            <DropdownMenu.Item
              variant="danger"
              onClick={onRemove}
              className="whitespace-nowrap"
              icon={<TrashIcon className="size-3.5" />}
            >
              Remove from rail
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu>
      {taskId != null && (
        <ParkDialog
          open={parkOpen}
          onOpenChange={setParkOpen}
          taskId={taskId}
          title={taskTitle ?? ""}
        />
      )}
      {taskId != null && (
        <AttachIssueDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          dir={dir}
          taskId={taskId}
        />
      )}
    </>
  );
}
