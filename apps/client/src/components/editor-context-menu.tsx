import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { editorTargetFromNode, type EditorTarget } from "@/lib/editor-target";
import { openInExternalEditor } from "@/lib/external-editor";

/** Not Radix's `ContextMenu`: Monaco `stopPropagation`s `contextmenu`, so the
 * handler must run in the capture phase, and Radix opens only from its own
 * trigger's event — hence a `DropdownMenu` on a zero-size node at the click. */
export function EditorContextMenu({ where, children }: { where: string; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number; target: EditorTarget } | null>(null);
  return (
    <div
      className="relative h-full w-full"
      onContextMenuCapture={(e) => {
        const target = editorTargetFromNode(e.target as Element);
        if (!target) return;
        // Without this WebKit shows its own Back/Forward menu over the top.
        e.preventDefault();
        setAt({ x: e.clientX, y: e.clientY, target });
      }}
    >
      {children}
      <DropdownMenu open={at != null} onOpenChange={(open) => !open && setAt(null)}>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed"
            style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        {/* `w-auto`: the default is trigger-width, and the trigger is a point. */}
        <DropdownMenuContent align="start" sideOffset={0} className="w-auto">
          <DropdownMenuItem
            onSelect={() => {
              if (!at) return;
              void openInExternalEditor(at.target.path, { line: at.target.line, where });
            }}
          >
            Open in external editor
            {at?.target.line != null && (
              <span className="ml-1 text-muted-foreground">line {at.target.line}</span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
