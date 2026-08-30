import { useEffect } from "react";
import { X } from "lucide-react";
import { ClaudeBadge, IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { CodeServerPane } from "@/components/code-server-pane";
import { useIdeConnected } from "@/lib/ide";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { FolderData } from "@/lib/agentboard";

/** Put one file on screen — Claude's openFile, the MCP `file_open` tool, a terminal link.
 * `path` is checkout-relative, or absolute for a file outside the checkout; a fresh nonce
 * per request so the same file re-fires. */
export type FilesOpenRequest = { path: string; line: number | null; nonce: number };

/** A folder's checkout as a *pane* in the Agentboard tiling: a VS Code workbench (code-server)
 * inside. Open requests arrive as `openRequest`, the screen opening the pane first if none
 * existed. */
export function FolderFilesPane({
  folder,
  focused,
  onClose,
  openRequest,
}: {
  /** The checkout this pane opens; undefined when it left the rail. */
  folder: FolderData | undefined;
  focused: boolean;
  onClose: () => void;
  openRequest?: FilesOpenRequest;
}) {
  const ideConnected = useIdeConnected(folder?.dir);

  // 10s git-stats ceiling on this checkout while the pane is up, not the fleet-wide
  // 60s: an edit made in the workbench moves no `.git` file the backend watches, so
  // only a poll ever notices it in the rail's chips.
  const dir = folder?.dir;
  useEffect(() => {
    if (!dir) return;
    void invoke("ab_set_folder_focus", { dir, focused: true });
    return () => void invoke("ab_set_folder_focus", { dir, focused: false });
  }, [dir]);

  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="files" />}
        subject={<span className="text-muted-foreground">VS Code</span>}
        controls={ideConnected ? <ClaudeBadge /> : undefined}
        actions={
          <IconBtn
            title="close pane (files stay a click away on the folder)"
            shortcut={focused ? "ab-close-pane" : undefined}
            onClick={onClose}
            className="hover:text-sky-500"
          >
            <X className="size-3" />
          </IconBtn>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <CodeServerPane dir={folder.dir} openRequest={openRequest} />
      </div>
    </div>
  );
}
