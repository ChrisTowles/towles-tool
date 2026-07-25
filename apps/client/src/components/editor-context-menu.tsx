import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { editorTargetFromNode, type EditorTarget } from "@/lib/editor-target";
import { openInExternalEditor } from "@/lib/external-editor";

/**
 * Right-click inside a Monaco surface → open that file in the configured
 * external editor, at the line the click landed on. Wraps the file viewer and
 * the diff pane's multi-diff alike: the target is resolved off the DOM
 * (`lib/editor-target`), so one menu serves however many editors the surface
 * happens to host.
 *
 * It also *replaces* what a right-click did here before, which was WebKit's
 * own Back/Forward/Reload menu — the browser chrome of a page that is not a
 * page. Monaco renders no menu of its own in either surface (the viewer sets
 * `contextmenu: false`, and the multi-diff's editors have no context-menu
 * service wired), so nothing is displaced.
 *
 * Two details are forced by Monaco and are why this isn't the plain
 * `ContextMenu` primitive the diff tree rail uses:
 * - **Capture phase.** Monaco's mouse handling calls `stopPropagation` on
 *   `contextmenu`, so a bubble-phase handler — which is all Radix's
 *   `ContextMenuTrigger` has — never runs inside an editor.
 * - **A positioned virtual trigger.** Radix's context menu is uncontrolled and
 *   opens from its own trigger's event, so the menu is a `DropdownMenu`
 *   anchored to a zero-size element parked at the click instead.
 */
export function EditorContextMenu({ where, children }: { where: string; children: ReactNode }) {
  // Sampled on the right-click: which editor (and line) was under the pointer,
  // and where to hang the menu. Null target = clicked past the editors (the
  // multi-diff's background), which opens no menu at all.
  const [at, setAt] = useState<{ x: number; y: number; target: EditorTarget } | null>(null);
  return (
    <div
      className="relative h-full w-full"
      onContextMenuCapture={(e) => {
        const target = editorTargetFromNode(e.target as Element);
        if (!target) return;
        // Ours now — without this WebKit shows its own menu over the top.
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
        {/* `w-auto` overrides the default "as wide as the trigger" — this
            trigger is a zero-width point. */}
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
