import { hasRenderedView, type PreviewKind } from "@/lib/preview-kind";

/** How the files pane splits the Monaco editor and the rendered preview. Both
 * halves stay *mounted* in every mode; a mode only collapses one, because
 * `CodeViewer`'s unmount disposes the Monaco model and its remount re-reads
 * from disk — dropping undo stack, scroll position and unflushed edits. */
export type EditorViewMode = "code" | "split" | "preview";

/** The mode a newly opened file starts in. Markdown and HTML open *rendered*,
 * that being how they're read; an anchored open wants the editor's lines. */
export function initialViewMode(kind: PreviewKind | null, anchored: boolean): EditorViewMode {
  return hasRenderedView(kind) && !anchored ? "preview" : "code";
}

/** Which panels a mode wants open. */
export function panelsFor(mode: EditorViewMode): { editor: boolean; preview: boolean } {
  return { editor: mode !== "preview", preview: mode !== "code" };
}

/** The inverse. Dragging the split handle far enough collapses a panel
 * directly, so the toolbar must read its state back out of the panels. */
export function modeForPanels(editor: boolean, preview: boolean): EditorViewMode {
  if (!preview) return "code";
  if (!editor) return "preview";
  return "split";
}
