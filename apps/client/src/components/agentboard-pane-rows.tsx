/**
 * The rail rows that aren't a PTY session: the view panes (diff, files,
 * preview, jarvis), plus the colored spine that brackets a multi-pane window's
 * rows.
 *
 * They live together because they share one shape — a pane, not a process —
 * and one rule: a view pane is a *view of* the folder, so it carries no status
 * and closes without asking.
 */
import { useState } from "react";
import { Box, Eye, FolderTree, GitCompare } from "lucide-react";
import { Hint } from "@/components/hint";
import { IconBtn } from "@/components/agentboard-bits";
import { cn } from "@/lib/utils";
import {
  isDiffPane,
  isFilesPane,
  isJarvisPane,
  isPreviewPane,
  windowColor,
  type AgWindow,
} from "@/lib/agentboard";

/** Vertical color spine beside a multi-pane window's rows in the rail: the
 * window's group color as a thin bar bracketing its sessions, clicking
 * focuses that window in the pane area. Replaces the old text label — window
 * names carry no signal in the rail; the color + tooltip is enough. */
export function WindowSpine({
  win,
  folderWins,
  count,
  onFocus,
}: {
  win: AgWindow;
  folderWins: AgWindow[];
  count: number;
  onFocus: () => void;
}) {
  return (
    <Hint label={`window “${win.name}” — ${count} panes, click to focus`}>
      <button
        type="button"
        onClick={onFocus}
        aria-label={`Focus window ${win.name}`}
        className="absolute inset-y-1 left-4 z-10 flex w-2 justify-center"
      >
        <span className={cn("h-full w-[3px] rounded-full", windowColor(folderWins, win.id))} />
      </button>
    </Hint>
  );
}

/** The pane kinds that are a *view of* the folder rather than something
 * running in it — each still gets a rail row, so what's open in a folder is
 * answerable from the rail alone. */
export type ViewPaneKind = "diff" | "files" | "preview" | "jarvis";

export function viewPaneKind(paneId: string): ViewPaneKind | null {
  if (isDiffPane(paneId)) return "diff";
  if (isFilesPane(paneId)) return "files";
  if (isPreviewPane(paneId)) return "preview";
  if (isJarvisPane(paneId)) return "jarvis";
  return null;
}

const VIEW_PANE_META: Record<
  ViewPaneKind,
  { Icon: typeof GitCompare; label: string; title: string }
> = {
  diff: { Icon: GitCompare, label: "diff", title: "This checkout's changed files, side by side" },
  files: { Icon: FolderTree, label: "files", title: "This checkout's file tree and editor" },
  preview: { Icon: Eye, label: "preview", title: "This checkout's live dev server" },
  jarvis: { Icon: Box, label: "jarvis", title: "A native Bevy surface tiled in this window" },
};

/**
 * A folder's diff / files / preview pane as a rail row.
 *
 * Quieter than a session row — no status dot, since there is nothing
 * running to have a status — but present, because "what is open in this folder"
 * is a question the rail should answer. Clicking focuses the pane (the same
 * call the folder header's chip makes, which is a no-op placement when the pane
 * already exists); ✕ closes it.
 */
export function ViewPaneRow({
  kind,
  active,
  onSelect,
  onClose,
}: {
  kind: ViewPaneKind;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { Icon, label, title } = VIEW_PANE_META[kind];
  const [hovered, setHovered] = useState(false);
  return (
    <Hint label={title} side="right">
      <div
        role="button"
        tabIndex={0}
        aria-current={active || undefined}
        aria-label={title}
        onClick={onSelect}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "relative ml-1.5 flex cursor-pointer items-center gap-2.5 border-l-2 border-transparent py-1 pr-3 pl-9",
          hovered && "bg-accent",
          active && "border-l-violet-500 bg-accent",
        )}
      >
        <Icon className="w-4 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {label}
        </span>
        {hovered && (
          <span className="absolute inset-y-0 right-2 z-10 flex items-center gap-1 bg-accent pl-1.5">
            <IconBtn title={`close ${label} pane`} onClick={onClose} className="hover:text-red-500">
              ✕
            </IconBtn>
          </span>
        )}
      </div>
    </Hint>
  );
}
