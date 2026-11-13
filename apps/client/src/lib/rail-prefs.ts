import {
  patchSettingsLocal,
  persistAgentboardSetting,
  reloadSettings,
  useSetting,
  type AgentboardBlock,
  type RailFilter,
  type RailSort,
} from "./settings";
import { invoke, runIpc } from "./tauri";

/** Everything, so a fresh install never wonders where a checkout went.
 * Mirrors `tt_config::DEFAULT_RAIL_FILTER`. */
export const DEFAULT_RAIL_FILTER: RailFilter = "all";

/** Mirrors `tt_config::DEFAULT_RAIL_RECENT_HOURS`. */
export const DEFAULT_RAIL_RECENT_HOURS = 4;

/** The hour spans the rail's filter menu offers for `"recent"`. */
export const RAIL_RECENT_HOUR_CHOICES = [2, 4, 8, 24, 48, 96, 24 * 7];

/** The rail's filter and the span `"recent"` measures: one control, so one hook. */
export function useRailFilter(): {
  filter: RailFilter;
  recentHours: number;
  setFilter: (next: RailFilter) => void;
  setRecentHours: (next: number) => void;
} {
  const filter = useSetting((s) => s.agentboard?.railFilter, DEFAULT_RAIL_FILTER);
  const recentHours = useSetting((s) => s.agentboard?.railRecentHours, DEFAULT_RAIL_RECENT_HOURS);
  return { filter, recentHours, setFilter: setRailFilter, setRecentHours: setRailRecentHours };
}

const setRailFilter = (next: RailFilter) => persistAgentboardSetting("railFilter", next);
const setRailRecentHours = (next: number) => persistAgentboardSetting("railRecentHours", next);

/** A key Rust writes: shown at once, written by `cmd`, then read back. */
function rustOwned<K extends keyof AgentboardBlock>(
  key: K,
  value: AgentboardBlock[K],
  cmd: string,
  args: Record<string, unknown>,
): void {
  patchSettingsLocal((s) => ({ ...s, agentboard: { ...s.agentboard, [key]: value } }));
  void runIpc(invoke(cmd, args)).then(reloadSettings);
}

/** Mirrors `tt_config::DEFAULT_RAIL_SORT`. */
const DEFAULT_RAIL_SORT: RailSort = "manual";

/** How the rail orders its repos, or the tasks inside each. Rust sorts the
 * payload, so the setter goes through `ab_set_rail_sort` (which leaves the
 * other key alone) and Rust owns the write. */
export function useRailSort(which: "repos" | "tasks"): [RailSort, (next: RailSort) => void] {
  const sort = useSetting(
    (s) => (which === "repos" ? s.agentboard?.railRepoSort : s.agentboard?.railTaskSort),
    DEFAULT_RAIL_SORT,
  );
  const setSort = (next: RailSort) =>
    rustOwned(which === "repos" ? "railRepoSort" : "railTaskSort", next, "ab_set_rail_sort", {
      [which]: next,
    });
  return [sort, setSort];
}

/** Off, so only the main checkout and worktrees you asked for become rail
 * folders. Mirrors `tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES`. */
const DEFAULT_SHOW_UNMANAGED_WORKTREES = false;

/** It decides which checkouts the *engine* discovers, so Rust owns the write
 * (`ab_set_show_unmanaged_worktrees`). */
export function useShowUnmanagedWorktrees(): [boolean, (on: boolean) => void] {
  const show = useSetting(
    (s) => s.agentboard?.showUnmanagedWorktrees,
    DEFAULT_SHOW_UNMANAGED_WORKTREES,
  );
  return [show, setShowUnmanagedWorktrees];
}

export const DEFAULT_BROWSER_PANE = false;

/** Whether checkouts offer the Chrome pane. Off means no entry point rather
 * than a disabled one. */
export function useBrowserPane(): [boolean, (on: boolean) => void] {
  const on = useSetting((s) => s.agentboard?.browserPane, DEFAULT_BROWSER_PANE);
  return [on, setBrowserPane];
}

const setBrowserPane = (next: boolean) => persistAgentboardSetting("browserPane", next);
const setShowUnmanagedWorktrees = (show: boolean) =>
  rustOwned("showUnmanagedWorktrees", show, "ab_set_show_unmanaged_worktrees", { show });
