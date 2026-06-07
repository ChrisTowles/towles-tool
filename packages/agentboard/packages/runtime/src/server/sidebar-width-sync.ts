import type { SidebarPane } from "../contracts/mux";

export interface SidebarResizeContext {
  paneId?: string;
  sessionName?: string;
  windowId?: string;
  width?: number;
  windowWidth?: number;
}

export interface SidebarWindowSnapshot {
  width?: number;
  windowWidth?: number;
}

export interface SidebarResizeSuppression {
  width: number;
  expiresAt: number;
}

// After the terminal window changes size, tmux proportionally rescales every
// pane and emits a burst of follow-up resize events at the already-settled
// window width. Treat pane-width changes within this window as proportional
// echoes (enforce, don't adopt) so they aren't mistaken for a deliberate drag
// of the sidebar divider — which is what caused the sidebar to ratchet smaller
// on every terminal resize.
export const WINDOW_RESIZE_COOLDOWN_MS = 750;

export function snapshotSidebarWindows(panes: SidebarPane[]): Map<string, SidebarWindowSnapshot> {
  const snapshots = new Map<string, SidebarWindowSnapshot>();
  for (const pane of panes) {
    snapshots.set(pane.windowId, {
      width: pane.width,
      windowWidth: pane.windowWidth,
    });
  }
  return snapshots;
}

export function resolveSidebarWidthFromResizeContext(params: {
  ctx?: SidebarResizeContext;
  panes: SidebarPane[];
  previousByWindow: Map<string, SidebarWindowSnapshot>;
  suppressedByPane: Map<string, SidebarResizeSuppression>;
  windowResizeCooldown: Map<string, number>;
  now?: number;
}): number | null {
  const {
    ctx,
    panes,
    previousByWindow,
    suppressedByPane,
    windowResizeCooldown,
    now = Date.now(),
  } = params;
  if (!ctx?.paneId) return null;

  const pane = panes.find((candidate) => candidate.paneId === ctx.paneId);
  if (!pane) return null;

  const width = ctx.width ?? pane.width;
  const windowWidth = ctx.windowWidth ?? pane.windowWidth;
  if (width == null || windowWidth == null) return null;

  const suppressed = suppressedByPane.get(pane.paneId);
  if (suppressed) {
    if (suppressed.width === width && suppressed.expiresAt >= now) {
      suppressedByPane.delete(pane.paneId);
      return null;
    }
    if (suppressed.expiresAt < now || suppressed.width !== width) {
      suppressedByPane.delete(pane.paneId);
    }
  }

  const previous = previousByWindow.get(pane.windowId);
  if (!previous || previous.width == null || previous.windowWidth == null) return null;

  // The terminal window itself changed size. tmux's resulting pane widths are
  // proportional rescales, not a user dragging the divider — never adopt them,
  // and open a cooldown so the proportional echo events that follow are ignored
  // too.
  if (previous.windowWidth !== windowWidth) {
    windowResizeCooldown.set(pane.windowId, now + WINDOW_RESIZE_COOLDOWN_MS);
    return null;
  }

  if (previous.width === width) return null;

  // Same window width but a different pane width. This is a deliberate divider
  // drag only when no terminal resize happened recently; otherwise it's a
  // leftover proportional echo and must not be adopted.
  const cooldownUntil = windowResizeCooldown.get(pane.windowId);
  if (cooldownUntil != null) {
    if (cooldownUntil >= now) return null;
    windowResizeCooldown.delete(pane.windowId);
  }

  return width;
}
