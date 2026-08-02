// The rail rows that aren't a PTY session. A view pane is a *view of* the
// folder, so it carries no status and closes without asking.
import { useState } from "react";
import { AppWindow, Box, Eye, FolderTree, GitCompare } from "lucide-react";
import { Hint } from "@/components/hint";
import { IconBtn } from "@/components/agentboard-bits";
import { cn } from "@/lib/utils";
import {
  isDiffPane,
  isFilesPane,
  isJarvisPane,
  isBrowserPane,
  isPreviewPane,
  windowColor,
  type AgWindow,
} from "@/lib/agentboard";

/** Color, not a text label: window names carry no signal in the rail. */
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
export type ViewPaneKind = "diff" | "files" | "preview" | "browser" | "jarvis";

export function viewPaneKind(paneId: string): ViewPaneKind | null {
  if (isDiffPane(paneId)) return "diff";
  if (isFilesPane(paneId)) return "files";
  if (isPreviewPane(paneId)) return "preview";
  if (isBrowserPane(paneId)) return "browser";
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
  browser: { Icon: AppWindow, label: "chrome", title: "A real Chrome with persistent sign-ins" },
  jarvis: { Icon: Box, label: "jarvis", title: "A native Bevy surface tiled in this window" },
};

/** A view pane as a rail row: quieter than a session (nothing running to
 * have a status) but present, because "what is open here" is a question the
 * rail should answer. Click focuses, ✕ closes. */
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
