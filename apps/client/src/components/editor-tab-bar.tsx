import { X } from "lucide-react";
import { tabLabels } from "@/lib/editor-tabs";
import { cn } from "@/lib/utils";

/** One row of open-file tabs above a files pane's editor. Selection state lives
 * in the pane (`active` is `currentPath` of its history); this only renders and
 * reports gestures. The close X is a *sibling* of the identity button — a
 * `<button>` may not contain one (apps/client/CLAUDE.md). */
export function EditorTabBar({
  tabs,
  active,
  dirty,
  onSelect,
  onClose,
}: {
  tabs: readonly string[];
  active: string | null;
  /** The active file's unsaved-edits flag; inactive tabs are flushed clean on
   * switch-away by the viewer's unmount save, so only the active one can show. */
  dirty: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const labels = tabLabels(tabs);
  return (
    <div role="tablist" className="flex shrink-0 items-stretch overflow-x-auto border-b bg-card">
      {tabs.map((path) => {
        const isActive = path === active;
        return (
          <div
            key={path}
            className={cn(
              "group flex max-w-48 shrink-0 items-center border-b-2 border-r",
              isActive
                ? "border-b-violet-500 bg-background text-foreground"
                : "border-b-transparent text-muted-foreground hover:bg-accent/50",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              title={path}
              onClick={() => onSelect(path)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(path);
              }}
              className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 font-mono text-[11px]"
            >
              <span className="truncate">{labels.get(path) ?? path}</span>
              {isActive && dirty && (
                <span
                  title="Unsaved changes — autosaves after a pause"
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                />
              )}
            </button>
            <button
              type="button"
              title={`Close ${labels.get(path) ?? path}`}
              onClick={() => onClose(path)}
              className={cn(
                "shrink-0 rounded-sm p-0.5 pr-1 hover:text-foreground",
                isActive ? "" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
