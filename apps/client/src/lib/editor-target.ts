/**
 * "Which file, and which line, did this right-click land on?" for the Monaco
 * surfaces — the file viewer and the multi-diff, which both host editors we
 * hold no per-editor reference to (the multi-diff builds its own, one per
 * changed file).
 *
 * Both answers come off the DOM Monaco already renders: every editor root
 * carries its model's `data-uri`, and a rendered line's `style.top` is the
 * same key the margin overlay uses for that line's number. Reading them beats
 * asking the widget for its *active* control, which a right-click needn't have
 * changed.
 */

/** The file a right-click resolved to, plus the line under it when the click
 * landed on rendered text (a diff's filler rows have no number). */
export type EditorTarget = { path: string; line: number | null };

/**
 * The absolute file path a Monaco model URI points at, or `null` for models
 * that aren't files on disk (`inmemory:`, `walkThrough:`, …).
 *
 * Three schemes reach here: `file:` from the viewer, and the diff pane's
 * `tt-diff-base:`/`tt-diff-work:` — the two sides of one changed file, both
 * naming the same working-tree path, which is the one an editor can open.
 */
export function pathFromModelUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const colon = uri.indexOf(":");
  if (colon < 0) return null;
  const scheme = uri.slice(0, colon);
  if (scheme !== "file" && scheme !== "tt-diff-base" && scheme !== "tt-diff-work") return null;
  // `file:` arrives fully formed (`file:///a/b`); the diff schemes are minted
  // with a bare path (`tt-diff-work:/a/b`).
  const path = uri.slice(colon + 1).replace(/^\/\/[^/]*/, "");
  return path.startsWith("/") ? decodeURIComponent(path) : null;
}

/**
 * Walk up from a right-clicked node to the Monaco editor that owns it and
 * report the file + line. `null` when the click missed an editor or landed on
 * one with no file behind it.
 */
export function editorTargetFromNode(node: Element | null): EditorTarget | null {
  const editor = node?.closest<HTMLElement>(".monaco-editor[data-uri]");
  const uri = editor?.dataset.uri;
  const path = pathFromModelUri(uri);
  if (!editor || !path) return null;
  // A diff's left side numbers the *base* revision, and the file being opened
  // is the working tree — those line numbers agree only by coincidence, so
  // that side opens the file plainly rather than landing somewhere wrong.
  const baseSide = uri?.startsWith("tt-diff-base:") ?? false;
  return { path, line: baseSide ? null : lineAtNode(editor, node) };
}

/** The 1-based line number of the rendered row `node` sits in, matched to the
 * margin overlay by the `top` offset both are positioned with. */
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
