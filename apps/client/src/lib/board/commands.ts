// Agent Board's commands: a transition on the UI record plus, where the change
// is saved, the IPC that saves it. Components call these; nothing else writes.
// Contract: docs/CLIENT-STATE.md.
import { read } from "@/lib/atoms/registry";
import type { WindowsPayload } from "@/lib/agentboard/types";
import { dropPane, nextWindowId, normalizeWins, placePane } from "@/lib/agentboard/windows";
import type { CollapseChange } from "@/lib/rail-collapse";
import type { ScreenId } from "@/lib/screens";
import { fire, invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { dispatchBoard } from "./atoms";
import { collapsedAtom, winsAtom } from "./derive";
import { setField } from "./model";

/** Sentinel key in the persisted collapse map for "the whole rail is collapsed
 * to icons" — rides the same `ab_save_collapsed` store as the per-row keys
 * (`repo:<name>` / `<repoKey>::<dir>`), which it can never collide with. */
export const RAIL_COLLAPSE_KEY = "__rail__";

// ── Folds: each toggle applies at once and saves its one key.

/** Set several keys outright — the keyboard's collapse/expand chords. */
export function applyCollapse(changes: readonly CollapseChange[]): void {
  if (changes.length === 0) return;
  for (const c of changes)
    fire(invoke("ab_save_collapsed", { key: c.key, collapsed: c.collapsed }));
  dispatchBoard(
    setField("collapsedEdits", (e) => ({
      ...e,
      ...Object.fromEntries(changes.map((c) => [c.key, c.collapsed])),
    })),
  );
}

export function toggleCollapsed(key: string): void {
  applyCollapse([{ key, collapsed: !read(collapsedAtom)[key] }]);
}

export function toggleRail(screen: ScreenId = "agentboard"): void {
  const collapsed = !!read(collapsedAtom)[RAIL_COLLAPSE_KEY];
  uiAction("agentboard.rail_toggle", screen, collapsed ? "expand" : "collapse");
  toggleCollapsed(RAIL_COLLAPSE_KEY);
}

// ── Windows: edited here, saved back debounced.

const EMPTY_WINS: WindowsPayload = { windows: [], activeWindows: {} };
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// The backend merges by folder dir on save, so it needs the ones touched:
// never-hydrated and explicitly-emptied are identical in the blob alone.
let touched = new Set<string>();

function scheduleSave(folderDirs: readonly string[]): void {
  for (const dir of folderDirs) touched.add(dir);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const touchedFolders = [...touched];
    touched = new Set();
    const payload = read(winsAtom);
    if (payload) fire(invoke("ab_save_windows", { payload, touchedFolders }));
  }, SAVE_DEBOUNCE_MS);
}

/** Edit the layout as shown now (pruned, hydrated) and save the folders named. */
export function updateWins(
  folderDirs: readonly string[],
  fn: (w: WindowsPayload) => WindowsPayload,
): void {
  const next = normalizeWins(fn(read(winsAtom) ?? EMPTY_WINS));
  dispatchBoard(setField("layout", next));
  scheduleSave(folderDirs);
}

export function addPaneToActive(folderDir: string, paneId: string): void {
  updateWins([folderDir], (w) => placePane(w, folderDir, paneId, nextWindowId));
}

export function removePane(paneId: string): void {
  const folderDir = read(winsAtom)?.windows.find((w) => w.panes.includes(paneId))?.folderDir;
  updateWins(folderDir ? [folderDir] : [], (w) => dropPane(w, paneId));
}
