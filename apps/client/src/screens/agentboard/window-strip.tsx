import { useState } from "react";
import { Plus } from "lucide-react";
import { windowColor, type AgWindow, type WindowsPayload } from "@/lib/agentboard";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** Shared chrome for the three add-actions, so they can't drift apart: no
 * resting box (they are controls, but repeated ones, and the tabs beside them
 * are what this strip is *about*), muted word, violet glyph. */
const ADD_CLASS =
  "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * The main area's window strip: one chip per window of the active folder,
 * plus "+ window" / "+ session" / "✦ chat" and the selected session's Close.
 *
 * A window may only ever hold panes from the one folder it belongs to, so
 * switching folders switches the whole strip, not just which panes show.
 *
 * **Two zones, split by a hairline: tabs, then the things that add one.**
 * Everything here used to be the same 11px pill, so a window (identity, and
 * switchable) looked exactly like "+ session" (an action) — five equivalent
 * buttons in a row. And all three add-actions were violet at rest, which in
 * this app means agent-ness or focus (see the `folder-rail-ui` skill): three
 * of them side by side is decoration, and it spends the hue that has to still
 * mean something on the ✦ next to it. So the glyph keeps the violet and the
 * word goes muted — the group reads as one run of "add something here"
 * without any of it shouting.
 */
export function WindowStrip(props: {
  windows: AgWindow[];
  activeWinId: string | undefined;
  hasSelection: boolean;
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
  onFocusWindow: (windowId: string) => void;
  onNewWindow: () => void;
  onNewSession: () => void;
  /** Opens the folder's rendered-agent (`chat`) pane in the active window. */
  onNewChat: () => void;
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
    onNewChat,
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
              "group/tab flex shrink-0 items-center gap-1.5 rounded-md border-b-2 border-transparent px-2 py-1 text-[11px]",
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
              //
              // Full strength on the tab you're on, faded until you point at
              // any other — the browser-tab convention, and the reason it
              // holds its width either way is that a tab whose size changed
              // under the pointer would be a tab you can miss.
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
                className={cn(
                  "text-muted-foreground/50 transition-opacity hover:text-red-500 focus-visible:opacity-100",
                  w.id === activeWinId
                    ? "opacity-100"
                    : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
                )}
              >
                ✕
              </span>
            )}
          </button>
        ),
      )}
      {/* Hairline, not a gap: the eye needs one cue that the run to its right
          adds things rather than switching to them. */}
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <button
        type="button"
        onClick={onNewWindow}
        title="New window around a fresh session"
        className={ADD_CLASS}
      >
        <Plus className="size-3 text-violet-500" /> window
      </button>
      <button
        type="button"
        onClick={() => {
          mouseAction("ab-new-session", "agentboard");
          onNewSession();
        }}
        className={ADD_CLASS}
        title={`New session in the focused folder (${shortcutHint("ab-new-session")} or ${shortcutHint("ab-new-terminal-right")})`}
      >
        <Plus className="size-3 text-violet-500" /> session
      </button>
      {/* Sits beside "+ session" because both answer "add something to this
          window" — the rail's folder-header chip is the same action, but
          hover-gated and easy to miss. `✦` rather than `+` since this opens
          the one pane kind that is an agent, matching the lens chip — and it
          is the one glyph here that keeps the violet, because on this surface
          ✦ *means* agent rather than decorating a verb. */}
      <button
        type="button"
        onClick={onNewChat}
        className={ADD_CLASS}
        title="New Claude chat in the focused folder — a session rendered as structured turns"
      >
        <span aria-hidden="true" className="font-mono text-violet-500">
          ✦
        </span>{" "}
        chat
      </button>
      {hasSelection && (
        <button
          type="button"
          onClick={() => {
            mouseAction("ab-close-session", "agentboard");
            onCloseSession();
          }}
          className="ml-auto shrink-0 rounded-md px-2 py-1 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={`Close the selected session (${shortcutHint("ab-close-session")})`}
          aria-label="Close the selected session"
        >
          {/* "Close session", not "Close": this strip holds two different
              close actions — a tab's ✕ ends a *window* — and the one word
              that tells them apart is worth its ~45px. */}
          Close session {shortcutHint("ab-close-session")}
        </button>
      )}
    </div>
  );
}
