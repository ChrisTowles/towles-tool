import { useState } from "react";
import { Plus } from "lucide-react";
import { windowColor, type AgWindow, type WindowsPayload } from "@/lib/agentboard";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * The main area's window strip: one chip per window of the active folder,
 * plus "+ window" / "+ session" and the selected session's Close.
 *
 * A window may only ever hold panes from the one folder it belongs to, so
 * switching folders switches the whole strip, not just which panes show.
 */
export function WindowStrip(props: {
  windows: AgWindow[];
  activeWinId: string | undefined;
  hasSelection: boolean;
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
  onFocusWindow: (windowId: string) => void;
  onNewWindow: () => void;
  onNewSession: () => void;
  onCloseSession: () => void;
}) {
  const {
    windows,
    activeWinId,
    hasSelection,
    updateWins,
    onFocusWindow,
    onNewWindow,
    onNewSession,
    onCloseSession,
  } = props;
  const [renamingWin, setRenamingWin] = useState<string | null>(null);

  const closeWindow = (w: AgWindow) =>
    updateWins([w.folderDir], (cur) => ({
      ...cur,
      windows: cur.windows.filter((x) => x.id !== w.id),
    }));

  return (
    <div className="flex items-center gap-1 border-b bg-card px-2 py-1">
      {windows.map((w) =>
        // Swap the chip for the input rather than nesting one inside it:
        // buttons may not contain interactive descendants. See
        // apps/client/CLAUDE.md.
        renamingWin === w.id ? (
          <input
            key={w.id}
            autoFocus
            defaultValue={w.name}
            aria-label={`rename window ${w.name}`}
            onBlur={(e) => {
              const name = e.target.value.trim() || w.name;
              setRenamingWin(null);
              updateWins([w.folderDir], (cur) => ({
                ...cur,
                windows: cur.windows.map((x) => (x.id === w.id ? { ...x, name } : x)),
              }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenamingWin(null);
            }}
            className="w-24 shrink-0 rounded-md border border-input bg-background px-2 py-1 text-[11px] outline-none"
          />
        ) : (
          <button
            key={w.id}
            type="button"
            onClick={() => onFocusWindow(w.id)}
            onDoubleClick={() => setRenamingWin(w.id)}
            title="double-click to rename"
            aria-pressed={w.id === activeWinId}
            className={cn(
              // border-b-2 mirrors the rail's border-l-2 active edge,
              // rotated to match this strip's horizontal layout — kept
              // transparent at rest so the violet edge never shifts
              // the tab's size when it becomes active.
              "flex shrink-0 items-center gap-1.5 rounded-md border-b-2 border-transparent px-2 py-1 text-[11px]",
              w.id === activeWinId
                ? "border-b-violet-500 bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <span className={cn("size-2 rounded-[3px]", windowColor(windows, w.id))} />
            {w.name}
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {w.panes.length}⊞
            </span>
            {windows.length > 1 && (
              // span-with-role, not <button>: it nests inside the window
              // chip's real <button>, and interactive elements may not nest.
              // Keyboard support added by hand instead.
              <span
                role="button"
                tabIndex={0}
                title="close window (panes ungroup; sessions stay in the rail)"
                aria-label={`close window ${w.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeWindow(w);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  closeWindow(w);
                }}
                className="text-muted-foreground/50 hover:text-red-500"
              >
                ✕
              </span>
            )}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={onNewWindow}
        title="New window around a fresh session"
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-violet-500 hover:bg-accent/50"
      >
        <Plus className="size-3" /> window
      </button>
      <button
        type="button"
        onClick={() => {
          mouseAction("ab-new-session", "agentboard");
          onNewSession();
        }}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-violet-500 hover:bg-accent/50"
        title={`New session in the focused folder (${shortcutHint("ab-new-session")} or ${shortcutHint("ab-new-terminal-right")})`}
      >
        <Plus className="size-3" /> session
      </button>
      {hasSelection && (
        <button
          type="button"
          onClick={() => {
            mouseAction("ab-close-session", "agentboard");
            onCloseSession();
          }}
          className="ml-auto shrink-0 rounded-md px-2 py-1 font-mono text-[10.5px] text-muted-foreground hover:bg-accent/50"
          title={`Close session (${shortcutHint("ab-close-session")})`}
          aria-label="Close the selected session"
        >
          Close {shortcutHint("ab-close-session")}
        </button>
      )}
    </div>
  );
}
