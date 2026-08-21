import { X } from "lucide-react";
import { ClaudeBadge, IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { CodeServerPane } from "@/components/code-server-pane";
import { useIdeConnected } from "@/lib/ide";
import { cn } from "@/lib/utils";
import type { FolderData } from "@/lib/agentboard";

/** Put one file on screen — Claude's openFile, the MCP `file_open` tool, a terminal link.
 * `path` is checkout-relative; a fresh nonce per request so the same file re-fires. */
export type FilesOpenRequest = { path: string; line: number | null; nonce: number };

/** A folder's checkout as a *pane* in the Agentboard tiling — `DiffPane`'s sibling, a VS Code
 * workbench (code-server) inside. Open requests arrive as `openRequest`, the screen opening the
 * pane first if none existed. */
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
