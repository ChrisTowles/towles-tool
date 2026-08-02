import { X } from "lucide-react";
import { IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { NativePane } from "@/components/native-pane";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { jarvisPaneId, type FolderData } from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/** A folder's native pane: a window rect handed to `tt-jarvis`'s Bevy renderer, the one pane
 * whose *body* is not DOM (docs/NATIVE-PANE.md). The surface composites above the webview, so
 * getting out of its way means `visible={false}`, never z-index; closing merely parks the
 * renderer, which is what makes a pane this expensive safe to render conditionally. */
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
            shortcut={focused ? "ab-close-pane" : undefined}
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
