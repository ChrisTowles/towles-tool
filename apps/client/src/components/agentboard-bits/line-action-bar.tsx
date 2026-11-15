import { type ReactNode } from "react";
import { ArrowUUpLeftIcon, EyeIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { Kbd } from "@/components/ui/kbd";
import type { FolderData } from "@/lib/agentboard/types";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** The selected checkout's line-only verbs, worded: hover never has to reveal
 * one. Session, Files and Chrome live in the working-context header, not here. */
export function LineActionBar({
  folder,
  onOpenPreview,
  onRename,
  onUnpark,
  onDeleteWorktree,
}: {
  folder: FolderData;
  onOpenPreview: () => void;
  /** Set only when the line has a task title to rename. */
  onRename?: () => void;
  /** Set only on a parked task's line. */
  onUnpark?: () => void;
  onDeleteWorktree?: () => void;
}) {
  if (!folder.hasLaunchConfig && !onRename && !onUnpark && !onDeleteWorktree) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 pb-1.5 pl-4">
      {folder.hasLaunchConfig && (
        <BarButton
          icon={<EyeIcon className="size-3" />}
          label="Preview"
          hud="Preview this checkout's dev server"
          action="agentboard.line_bar_preview"
          onClick={onOpenPreview}
        />
      )}
      {onRename && (
        <BarButton
          icon={<PencilSimpleIcon className="size-3" />}
          label="Rename"
          hud="Rename this task (double-clicking the name works too)"
          action="agentboard.line_bar_rename"
          onClick={onRename}
        />
      )}
      {onUnpark && (
        <BarButton
          icon={<ArrowUUpLeftIcon className="size-3" />}
          label="Unpark"
          hud="Put this task back in the list"
          shortcut="ab-park-task"
          onClick={onUnpark}
        />
      )}
      {onDeleteWorktree && (
        <BarButton
          icon={<TrashIcon className="size-3" />}
          label="Delete"
          hud="Delete this worktree — a dialog shows what would be lost first"
          shortcut="ab-remove-task"
          danger
          onClick={onDeleteWorktree}
        />
      )}
    </div>
  );
}

/** `shortcut` names the binding this button is an exact twin of (the bar sits
 * on the active checkout, which is what those bindings act on); `action` is
 * the plain event for a button whose handler records none of its own. */
function BarButton({
  icon,
  label,
  hud,
  shortcut,
  action,
  danger = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hud: string;
  shortcut?: string;
  action?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-hud={shortcut ? `${hud} · ${shortcutHint(shortcut)}` : hud}
      onClick={(e) => {
        e.stopPropagation();
        if (shortcut) mouseAction(shortcut, "agentboard");
        else if (action) uiAction(action, "agentboard");
        onClick();
      }}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-md border border-kumo-hairline px-1.5 text-mini text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default",
        danger && "ml-auto hover:border-danger/50 hover:bg-danger/10 hover:text-danger",
      )}
    >
      {icon}
      {label}
      {shortcut && <Kbd className="h-4 text-micro">{shortcutHint(shortcut)}</Kbd>}
    </button>
  );
}
