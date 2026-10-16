const FILES_PANE_PREFIX = "~files:";

const PREVIEW_PANE_PREFIX = "~preview:";

const JARVIS_PANE_PREFIX = "~jarvis:";

const BROWSER_PANE_PREFIX = "~browser:";

export function filesPaneId(folderDir: string): string {
  return `${FILES_PANE_PREFIX}${folderDir}`;
}

export function isFilesPane(paneId: string): boolean {
  return paneId.startsWith(FILES_PANE_PREFIX);
}

export function filesPaneDir(paneId: string): string | null {
  return isFilesPane(paneId) ? paneId.slice(FILES_PANE_PREFIX.length) : null;
}

/** What the files pane rooted at `folderDir` opens for `path`: checkout-relative
 * when the file is inside it, absolute when it isn't — the workbench opens a
 * file from anywhere, so an out-of-tree click is no reason to leave the app.
 * Null only for a path nothing here can anchor: a `~` the backend didn't expand,
 * or a relative one that escapes. */
export function filesPaneTarget(folderDir: string, path: string): string | null {
  if (path.startsWith(`${folderDir}/`)) return path.slice(folderDir.length + 1);
  if (path.startsWith("/")) return path;
  if (path.startsWith("~")) return null;
  let rel = path;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (rel === "" || rel.startsWith("../")) return null;
  return rel;
}

export function previewPaneId(folderDir: string): string {
  return `${PREVIEW_PANE_PREFIX}${folderDir}`;
}

export function isPreviewPane(paneId: string): boolean {
  return paneId.startsWith(PREVIEW_PANE_PREFIX);
}

export function previewPaneDir(paneId: string): string | null {
  return isPreviewPane(paneId) ? paneId.slice(PREVIEW_PANE_PREFIX.length) : null;
}

/** A rectangle of the window handed to `tt-jarvis`'s Bevy renderer as a real
 * compositor surface, tiled beside the folder's terminals. */
export function jarvisPaneId(folderDir: string): string {
  return `${JARVIS_PANE_PREFIX}${folderDir}`;
}

export function isJarvisPane(paneId: string): boolean {
  return paneId.startsWith(JARVIS_PANE_PREFIX);
}

export function jarvisPaneDir(paneId: string): string | null {
  return isJarvisPane(paneId) ? paneId.slice(JARVIS_PANE_PREFIX.length) : null;
}

/** A real Chrome on the app-owned profile, streamed onto a canvas. */
export function browserPaneId(folderDir: string): string {
  return `${BROWSER_PANE_PREFIX}${folderDir}`;
}

export function isBrowserPane(paneId: string): boolean {
  return paneId.startsWith(BROWSER_PANE_PREFIX);
}

export function browserPaneDir(paneId: string): string | null {
  return isBrowserPane(paneId) ? paneId.slice(BROWSER_PANE_PREFIX.length) : null;
}

export function folderPaneDir(paneId: string): string | null {
  return (
    filesPaneDir(paneId) ??
    previewPaneDir(paneId) ??
    jarvisPaneDir(paneId) ??
    browserPaneDir(paneId)
  );
}

/** A session pane is its own id; folder panes have none. */
export function paneSession(paneId: string): string | null {
  return folderPaneDir(paneId) === null ? paneId : null;
}
