import { X } from "lucide-react";
import { IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { NativePane } from "@/components/native-pane";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { jarvisPaneId, type FolderData } from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/**
 * A folder's native pane: a rectangle of the window handed to `tt-jarvis`'s
 * Bevy renderer, tiled beside that folder's terminals.
 *
 * The one pane kind whose body is not DOM. Two consequences the tiling has to
 * respect, both inherited from `NativePane` (see `lib/native-pane.ts`):
 *
 * 1. **The surface composites above the webview.** It covers whatever the DOM
 *    would draw in its rect, so anything that should appear over the pane area
 *    — the command palette, a dialog, another screen — has to come through as
 *    `visible={false}` rather than relying on z-index.
 * 2. **Closing it retires it, it does not free it.** `pane_detach` parks the
 *    surface and stops its renderer but keeps the Bevy app alive, because
 *    dropping one mid-session ends the process (`crates-tauri/tt-pane`). So
 *    this pane can be rendered conditionally like diff/files/preview — closing
 *    and reopening is cheap and lossless — but a folder that has ever shown one
 *    keeps a parked renderer until the app exits.
 *
 * Only the *body* is native. The header stays DOM, which is what keeps the ✕
 * clickable — a surface covering the whole tile would swallow it.
 */
export function JarvisPane({
  folder,
  focused,
  visible,
  onClose,
}: {
  folder: FolderData | undefined;
  focused: boolean;
  /** False whenever something must appear over the pane area — the Agentboard
   * screen isn't the active tab, say. The surface obeys the compositor, not
   * CSS, so this is the only way to get out of the way. */
  visible: boolean;
  onClose: () => void;
}) {
  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="jarvis" />}
        subject={<span className="text-muted-foreground">bevy · native surface</span>}
        actions={
          <IconBtn
            title="close pane (parks the surface and stops the renderer)"
            onClick={onClose}
            className="hover:text-sky-500"
          >
            <X className="size-3" />
          </IconBtn>
        }
      />
      <NativePane
        paneId={jarvisPaneId(folder.dir)}
        visible={visible}
        className="min-h-0 flex-1"
        fallback="Jarvis needs Linux/Wayland"
      />
    </div>
  );
}
