import { useState } from "react";
import { Plus } from "lucide-react";
import { windowColor, type AgWindow, type WindowsPayload } from "@/lib/agentboard";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";

/** Shared chrome for the three add-actions, so they can't drift apart: no
 * resting box (they are controls, but repeated ones, and the tabs beside them
 * are what this strip is *about*), muted word, violet glyph. */
const ADD_CLASS =
  "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** One chip per window of the active folder, plus add-actions and the selected
 * session's Close, split by a hairline. Only the add glyphs keep violet, so the
 * hue still means agent-ness or focus (the `visual-design` skill). */
export function WindowStrip(props: {
  windows: AgWindow[];
  activeWinId: string | undefined;
  /** True while the Ctrl+Shift arrow cursor sits on the strip — rings the active tab. */
  keyboardFocused: boolean;
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
    keyboardFocused,
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
          <Hint key={w.id} label="double-click to rename">
            <button
              type="button"
              onClick={() => onFocusWindow(w.id)}
              onDoubleClick={() => setRenamingWin(w.id)}
              aria-pressed={w.id === activeWinId}
              className={cn(
                // border-b-2 mirrors the rail's border-l-2 active edge, rotated
                // horizontal — transparent at rest so activation never resizes.
                "group/tab flex shrink-0 items-center gap-1.5 rounded-md border-b-2 border-transparent px-2 py-1 text-[11px]",
                w.id === activeWinId
                  ? "border-b-violet-500 bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
                keyboardFocused && w.id === activeWinId && "ring-2 ring-violet-500/60",
              )}
            >
              <span className={cn("size-2 rounded-[3px]", windowColor(windows, w.id))} />
              {w.name}
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {w.panes.length}⊞
              </span>
              {windows.length > 1 && (
                // span-with-role: it nests inside the chip's real <button>, so
                // keyboard support is hand-rolled. Holds its width faded or not
                // — a tab that resizes under the pointer is one you can miss.
                <span
                  role="button"
                  tabIndex={0}
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
          </Hint>
        ),
      )}
      {/* Hairline, not a gap: the eye needs one cue that the run to its right
          adds things rather than switching to them. */}
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <Hint label="New window around a fresh session">
        <button type="button" onClick={onNewWindow} className={ADD_CLASS}>
          <Plus className="size-3 text-violet-500" /> window
        </button>
      </Hint>
      <Hint
        label={`New session in the focused folder (${shortcutHint("ab-new-session")} or ${shortcutHint("ab-new-terminal-right")})`}
      >
        <button
          type="button"
          onClick={() => {
            mouseAction("ab-new-session", "agentboard");
            onNewSession();
          }}
          className={ADD_CLASS}
        >
          <Plus className="size-3 text-violet-500" /> session
        </button>
      </Hint>
      {hasSelection && (
        <Hint label="Close the selected session" shortcut="ab-close-session">
          <button
            type="button"
            onClick={() => {
              mouseAction("ab-close-session", "agentboard");
              onCloseSession();
            }}
            className="ml-auto shrink-0 rounded-md px-2 py-1 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close the selected session"
          >
            {/* "Close session", not "Close": this strip holds two different
              close actions — a tab's ✕ ends a *window* — and the one word
              that tells them apart is worth its ~45px. */}
            Close session {shortcutHint("ab-close-session")}
          </button>
        </Hint>
      )}
    </div>
  );
}
