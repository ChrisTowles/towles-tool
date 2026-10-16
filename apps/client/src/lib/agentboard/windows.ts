import { folderPaneDir, paneSession } from "./pane-ids";
import type { AgWindow, Panes, WindowsPayload, WireWindowsPayload } from "./types";

function toPanes(ids: string[]): Panes | null {
  return ids.length > 0 ? (ids as Panes) : null;
}

/** Window identity colors for the rail group tags + window-strip squares. */
const WINDOW_COLORS = ["bg-window-1", "bg-window-2", "bg-window-3", "bg-window-4", "bg-window-5"];

export function windowColor(wins: AgWindow[], windowId: string): string {
  const i = wins.findIndex((w) => w.id === windowId);
  return i < 0 ? "bg-muted-foreground/40" : WINDOW_COLORS[i % WINDOW_COLORS.length];
}

/** What closing a pane actually means: end the shell behind it, or just drop the tile. */
export type PaneCloseTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "pane"; paneId: string };

/** Null when the ring sits on a pane the visible window doesn't hold: a chord
 * that closes something off-screen loses work. */
export function paneCloseTarget(
  focusedPaneId: string | null,
  panes: readonly string[],
): PaneCloseTarget | null {
  if (!focusedPaneId || !panes.includes(focusedPaneId)) return null;
  const sessionId = paneSession(focusedPaneId);
  return sessionId === null
    ? { kind: "pane", paneId: focusedPaneId }
    : { kind: "session", sessionId };
}

/** Last id handed out, so a same-millisecond mint can't repeat one. */
let lastWindowSeq = 0;

export function nextWindowId(): string {
  const now = Date.now();
  lastWindowSeq = now > lastWindowSeq ? now : lastWindowSeq + 1;
  return `w${lastWindowSeq}`;
}

let openFileNonce = 0;

/** Monotonic re-trigger token for a pane's "open this file" request. */
export function nextOpenFileNonce(): number {
  return ++openFileNonce;
}

let lastDraftScopeSeq = 0;

/** Scope id for a new-task form's image staging dir; same mint as
 * {@link nextWindowId}, so same-millisecond forms can't collide. */
export function nextDraftScopeId(): string {
  const now = Date.now();
  lastDraftScopeSeq = now > lastDraftScopeSeq ? now : lastDraftScopeSeq + 1;
  return `draft-${lastDraftScopeSeq}`;
}

export function placePane(
  w: WindowsPayload,
  folderDir: string,
  paneId: string,
  newWindowId: () => string,
): WindowsPayload {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (host) {
    return w.activeWindows[folderDir] === host.id
      ? w
      : { ...w, activeWindows: { ...w.activeWindows, [folderDir]: host.id } };
  }
  let windowId = w.activeWindows[folderDir];
  if (!w.windows.some((win) => win.id === windowId && win.folderDir === folderDir)) {
    // Reuse the folder's first existing window before minting: a dangling active
    // entry would spawn a duplicate "primary" beside the one the user has.
    const existing = w.windows.find((win) => win.folderDir === folderDir);
    if (!existing) {
      // Windows are born around their first pane — never empty.
      const id = newWindowId();
      return {
        windows: [...w.windows, { id, name: "primary", folderDir, panes: [paneId] }],
        activeWindows: { ...w.activeWindows, [folderDir]: id },
      };
    }
    windowId = existing.id;
  }
  return {
    windows: w.windows.map((win) =>
      win.id === windowId ? { ...win, panes: appendPane(win.panes, paneId) } : win,
    ),
    activeWindows: { ...w.activeWindows, [folderDir]: windowId },
  };
}

/** Keeps the non-empty tuple type; a plain spread widens to `string[]`. */
function appendPane(panes: Panes, paneId: string): Panes {
  const [first, ...rest] = panes;
  return [first, ...rest, paneId];
}

export function dropPane(w: WindowsPayload, paneId: string): WindowsPayload {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (!host) return w;
  const remaining = toPanes(host.panes.filter((p) => p !== paneId));
  if (!remaining) {
    const sibling = w.windows.find((win) => win.folderDir === host.folderDir && win.id !== host.id);
    const activeWindows = { ...w.activeWindows };
    if (activeWindows[host.folderDir] === host.id) {
      if (sibling) activeWindows[host.folderDir] = sibling.id;
      else delete activeWindows[host.folderDir];
    }
    return { windows: w.windows.filter((win) => win.id !== host.id), activeWindows };
  }
  return {
    ...w,
    windows: w.windows.map((win) => (win.id === host.id ? { ...win, panes: remaining } : win)),
  };
}

/** The neighbor sliding into the closed slot, else the first pane of the sibling
 * window `dropPane` will activate. Null when nothing is left. */
export function successorPane(w: WindowsPayload, paneId: string): string | null {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (!host) return null;
  const rest = host.panes.filter((p) => p !== paneId);
  if (rest.length > 0) return rest[Math.min(host.panes.indexOf(paneId), rest.length - 1)];
  const sibling = w.windows.find((win) => win.folderDir === host.folderDir && win.id !== host.id);
  return sibling?.panes[0] ?? null;
}

/** Exactly the `touchedFolders` the backend's merge-by-folder save needs. */
export function changedFolderDirs(a: WireWindowsPayload, b: WireWindowsPayload): string[] {
  const dirs = new Set<string>([
    ...a.windows.map((win) => win.folderDir),
    ...b.windows.map((win) => win.folderDir),
    ...Object.keys(a.activeWindows),
    ...Object.keys(b.activeWindows),
  ]);
  return [...dirs].filter((d) => folderSignature(a, d) !== folderSignature(b, d));
}

function folderSignature(p: WireWindowsPayload, dir: string): string {
  return JSON.stringify([
    p.windows.filter((win) => win.folderDir === dir),
    p.activeWindows[dir] ?? null,
  ]);
}

export function hydrateWins(w: WireWindowsPayload): WindowsPayload {
  const windows: AgWindow[] = [];
  for (const win of w.windows) {
    const panes = toPanes(win.panes.filter((p) => folderPaneDir(p) !== null));
    if (panes) windows.push({ ...win, panes });
  }
  return normalizeWins({ windows, activeWindows: w.activeWindows });
}

/** Reconcile the persisted layout against what actually exists. */
export function pruneWins(
  w: WindowsPayload,
  validSessionIds: ReadonlySet<string>,
  validFolderDirs: ReadonlySet<string>,
): WindowsPayload {
  const kept: AgWindow[] = [];
  for (const win of w.windows) {
    if (!validFolderDirs.has(win.folderDir)) continue;
    const panes = toPanes(
      win.panes.filter((p) => {
        const dir = folderPaneDir(p);
        if (dir !== null) return validFolderDirs.has(dir);
        return validSessionIds.has(p);
      }),
    );
    if (!panes) continue;
    kept.push(panes.length === win.panes.length ? win : { ...win, panes });
  }
  const activeWindows: Record<string, string> = {};
  for (const win of kept) {
    if (win.folderDir in activeWindows) continue;
    const cur = w.activeWindows[win.folderDir];
    activeWindows[win.folderDir] =
      cur && kept.some((x) => x.folderDir === win.folderDir && x.id === cur) ? cur : win.id;
  }
  const next = { windows: kept, activeWindows };
  return changedFolderDirs(w, next).length === 0 ? w : next;
}

/** One cursor, three levels — Ctrl+Shift+arrows move whatever is focused. The
 * rail level walks the queue's rows (`railRows`); this covers the rest. */
export type FocusLevel = "rail" | "window" | "pane";

export type FocusMove =
  | { kind: "level"; level: FocusLevel }
  | { kind: "pane"; id: string }
  | { kind: "window"; id: string };

// Right descends the window strip → panes, skipping the window level for a
// single-window folder; Left and Up climb back out, ending on the rail.
export function moveFocus(args: {
  level: FocusLevel;
  direction: "up" | "down" | "left" | "right";
  panes: readonly string[];
  focusedPaneId: string | null;
  windows: readonly string[];
  activeWindowId: string | null;
}): FocusMove | null {
  const { level, direction, panes, focusedPaneId, windows, activeWindowId } = args;
  const multiWin = windows.length > 1;
  const firstPane = (): FocusMove | null =>
    panes.length > 0 ? { kind: "pane", id: panes[0] } : null;

  if (level === "window") {
    const wi = activeWindowId ? windows.indexOf(activeWindowId) : -1;
    if (direction === "up") return { kind: "level", level: "rail" };
    if (direction === "down") return firstPane();
    if (direction === "right") {
      return wi >= 0 && wi < windows.length - 1 ? { kind: "window", id: windows[wi + 1] } : null;
    }
    return wi > 0 ? { kind: "window", id: windows[wi - 1] } : { kind: "level", level: "rail" };
  }

  const idx = focusedPaneId ? panes.indexOf(focusedPaneId) : -1;
  if (direction === "right" || direction === "down") {
    if (idx === -1) return firstPane();
    return idx < panes.length - 1 ? { kind: "pane", id: panes[idx + 1] } : null;
  }
  if (direction === "left" && idx > 0) return { kind: "pane", id: panes[idx - 1] };
  return { kind: "level", level: multiWin ? "window" : "rail" };
}

/** Windows are created lazily per folder, so there is no "at least one" floor
 * to restore — a stale `activeWindows` entry is simply dropped. */
export function normalizeWins(w: WindowsPayload): WindowsPayload {
  const activeWindows: Record<string, string> = {};
  for (const [folderDir, windowId] of Object.entries(w.activeWindows)) {
    if (w.windows.some((win) => win.id === windowId && win.folderDir === folderDir)) {
      activeWindows[folderDir] = windowId;
    }
  }
  return { windows: w.windows, activeWindows };
}
