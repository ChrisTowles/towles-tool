import { type ReactNode } from "react";
import {
  AppWindowIcon,
  EyeIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { Kbd } from "@/components/ui/kbd";
import type { FolderData } from "@/lib/agentboard/types";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** The selected checkout's verbs, worded, with their keys: the one place a
 * line's actions live, so hover never has to reveal one. */
export function LineActionBar({
  folder,
  onOpenFiles,
  onOpenPreview,
  onOpenBrowser,
  onNewSession,
  onRename,
  onDeleteWorktree,
}: {
  folder: FolderData;
  onOpenFiles: () => void;
  onOpenPreview: () => void;
  onOpenBrowser?: () => void;
  onNewSession: () => void;
  /** Set only when the line has a task title to rename. */
  onRename?: () => void;
  onDeleteWorktree?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 pb-1.5 pl-4">
      <BarButton
        icon={<PlusIcon className="size-3" />}
        label="Session"
        hud="Start a new shell session in this checkout"
        shortcut="ab-new-session"
        onClick={onNewSession}
      />
      <BarButton
        icon={<TreeStructureIcon className="size-3" />}
        label="Files"
        hud="Browse every file in this checkout"
        shortcut="ab-toggle-files"
        quietKey
        onClick={onOpenFiles}
      />
      {folder.hasLaunchConfig && (
        <BarButton
          icon={<EyeIcon className="size-3" />}
          label="Preview"
          hud="Preview this checkout's dev server"
          action="agentboard.line_bar_preview"
          onClick={onOpenPreview}
        />
      )}
      {onOpenBrowser && (
        <BarButton
          icon={<AppWindowIcon className="size-3" />}
          label="Chrome"
          hud="Open a real Chrome in this window — sign-ins stick"
          onClick={onOpenBrowser}
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
  quietKey = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hud: string;
  shortcut?: string;
  action?: string;
  danger?: boolean;
  /** Name the key in the HUD only, to keep the bar on one row. */
  quietKey?: boolean;
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
      {shortcut && !quietKey && <Kbd className="h-4 text-micro">{shortcutHint(shortcut)}</Kbd>}
    </button>
  );
}
