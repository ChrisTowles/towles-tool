import { SCREENS, type ScreenId } from "@/lib/screens";

/** localStorage keys for the persisted tab state. Mirrors SIDEBAR_COLLAPSED_KEY
 * in workspace.tsx. */
export const ACTIVE_TAB_KEY = "tt-active-tab";
export const OPEN_TABS_KEY = "tt-open-tabs";

/** The screen shown on a cold start (no valid persisted state). */
export const COLD_START_TAB: ScreenId = "agentboard";

function isScreenId(value: unknown): value is ScreenId {
  return typeof value === "string" && value in SCREENS;
}

/** Restore persisted tab state from raw localStorage strings. Missing,
 * malformed, or stale-screen-id input degrades to the cold-start default
 * rather than throwing — a removed screen id can never break boot. */
export function loadWorkspaceTabs(
  rawActive: string | null,
  rawOpenTabs: string | null,
): { openTabs: ScreenId[]; activeTab: ScreenId } {
  const openTabs = parseOpenTabs(rawOpenTabs);
  const activeTab = isScreenId(rawActive) ? rawActive : COLD_START_TAB;
  if (!openTabs.includes(activeTab)) openTabs.push(activeTab);
  return { openTabs, activeTab };
}

function parseOpenTabs(rawOpenTabs: string | null): ScreenId[] {
  if (rawOpenTabs === null) return [COLD_START_TAB];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOpenTabs);
  } catch {
    return [COLD_START_TAB];
  }
  if (!Array.isArray(parsed)) return [COLD_START_TAB];
  // Keep only ids that still exist, de-duplicated in stored order.
  const seen = new Set<ScreenId>();
  for (const id of parsed) {
    if (isScreenId(id)) seen.add(id);
  }
  const openTabs = [...seen];
  return openTabs.length > 0 ? openTabs : [COLD_START_TAB];
}

export type Tabs = Readonly<{
  openTabs: ScreenId[];
  activeTab: ScreenId;
  /** Most-recently-opened order; `openTabs` is first-visit order. */
  recent: ScreenId[];
}>;

export type TabsMsg =
  | { kind: "Open"; id: ScreenId }
  | { kind: "Close"; id: ScreenId }
  | { kind: "Step"; step: 1 | -1 };

/** Pure: the only way the open tabs change. Returns `t` itself on a no-op. */
export function updateTabs(t: Tabs, msg: TabsMsg): Tabs {
  switch (msg.kind) {
    case "Open": {
      if (t.activeTab === msg.id && t.recent[0] === msg.id) return t;
      return {
        openTabs: t.openTabs.includes(msg.id) ? t.openTabs : [...t.openTabs, msg.id],
        activeTab: msg.id,
        recent: [msg.id, ...t.recent.filter((x) => x !== msg.id)],
      };
    }
    case "Close": {
      if (t.openTabs.length <= 1 || !t.openTabs.includes(msg.id)) return t;
      const idx = t.openTabs.indexOf(msg.id);
      const openTabs = t.openTabs.filter((s) => s !== msg.id);
      const activeTab =
        t.activeTab === msg.id ? openTabs[Math.min(idx, openTabs.length - 1)]! : t.activeTab;
      return { ...t, openTabs, activeTab };
    }
    case "Step": {
      const idx = t.openTabs.indexOf(t.activeTab);
      if (idx === -1) return t;
      const n = t.openTabs.length;
      return updateTabs(t, { kind: "Open", id: t.openTabs[(idx + msg.step + n) % n]! });
    }
  }
}
