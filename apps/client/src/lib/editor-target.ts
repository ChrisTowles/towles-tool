/** Which file and line a right-click landed on, read off the DOM Monaco already
 * renders — we hold no reference to the multi-diff's per-file editors, and the
 * widget's *active* control needn't be the one that was clicked. */

export type EditorTarget = { path: string; line: number | null };

export function pathFromModelUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const colon = uri.indexOf(":");
  if (colon < 0) return null;
  const scheme = uri.slice(0, colon);
  if (scheme !== "file" && scheme !== "tt-diff-base" && scheme !== "tt-diff-work") return null;
  // `file:` arrives fully formed; the diff schemes are minted with a bare path.
  const path = uri.slice(colon + 1).replace(/^\/\/[^/]*/, "");
  return path.startsWith("/") ? decodeURIComponent(path) : null;
}

export function editorTargetFromNode(node: Element | null): EditorTarget | null {
  const editor = node?.closest<HTMLElement>(".monaco-editor[data-uri]");
  const uri = editor?.dataset.uri;
  const path = pathFromModelUri(uri);
  if (!editor || !path) return null;
  // Base-side numbers are the base revision's, not the working tree's.
  const baseSide = uri?.startsWith("tt-diff-base:") ?? false;
  return { path, line: baseSide ? null : lineAtNode(editor, node) };
}

/** Matched to the margin overlay by the `top` offset both are positioned with. */
function lineAtNode(editor: HTMLElement, node: Element | null): number | null {
  const top = node?.closest<HTMLElement>(".view-line")?.style.top;
  if (!top) return null;
  const overlays = editor.querySelectorAll<HTMLElement>(".margin-view-overlays > div");
  for (const overlay of overlays) {
    if (overlay.style.top !== top) continue;
    const text = overlay.querySelector(".line-numbers")?.textContent?.trim();
    const line = Number(text);
    return Number.isInteger(line) && line > 0 ? line : null;
  }
  return null;
}
