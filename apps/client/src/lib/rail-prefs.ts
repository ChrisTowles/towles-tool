import { useCallback } from "react";
import { persistAgentboardSetting, useLiveSetting, type RailFilter } from "./settings";
import { invoke } from "./tauri";

/** Everything, so a fresh install never wonders where a checkout went.
 * Mirrors `tt_config::DEFAULT_RAIL_FILTER`. */
export const DEFAULT_RAIL_FILTER: RailFilter = "all";

/** Mirrors `tt_config::DEFAULT_RAIL_RECENT_HOURS`. */
export const DEFAULT_RAIL_RECENT_HOURS = 4;

/** The hour spans the rail's filter menu offers for `"recent"`. */
export const RAIL_RECENT_HOUR_CHOICES = [2, 4, 8, 24, 48, 96, 24 * 7];

/** The rail's filter and the span `"recent"` measures. One hook for both
 * keys because they are one control: the mode is meaningless without the
 * span, so the rail's menu shows and sets them together. */
export function useRailFilter(): {
  filter: RailFilter;
  recentHours: number;
  setFilter: (next: RailFilter) => void;
  setRecentHours: (next: number) => void;
} {
  const [filter, setFilterState] = useLiveSetting(
    (s) => s.agentboard?.railFilter,
    DEFAULT_RAIL_FILTER,
  );
  const [recentHours, setRecentHoursState] = useLiveSetting(
    (s) => s.agentboard?.railRecentHours,
    DEFAULT_RAIL_RECENT_HOURS,
  );
  const setFilter = useCallback(
    (next: RailFilter) => {
      setFilterState(next);
      void persistAgentboardSetting("railFilter", next);
    },
    [setFilterState],
  );
  const setRecentHours = useCallback(
    (next: number) => {
      setRecentHoursState(next);
      void persistAgentboardSetting("railRecentHours", next);
    },
    [setRecentHoursState],
  );
  return { filter, recentHours, setFilter, setRecentHours };
}

/** Off: a hand-marked quiet checkout is hidden until you say otherwise. */
export const DEFAULT_SHOW_QUIET = false;

/** The one switch that brings quiet checkouts back — hence the rail header,
 * where it is found without knowing to look. Rust never reads it. */
export function useShowQuiet(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useLiveSetting((s) => s.agentboard?.showQuiet, DEFAULT_SHOW_QUIET);
  const persist = useCallback(
    (next: boolean) => {
      setOn(next);
      void persistAgentboardSetting("showQuiet", next);
    },
    [setOn],
  );
  return [on, persist];
}

/** Off, so only the main checkout and worktrees you asked for become rail
 * folders. Mirrors `tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES`. */
export const DEFAULT_SHOW_UNMANAGED_WORKTREES = false;

/** Not a view filter the client can apply: it decides which checkouts the
 * *engine* discovers, so the setter goes through
 * `ab_set_show_unmanaged_worktrees` and Rust owns the write. Reads still come
 * off the settings file, so another window's change flows back on focus. */
export function useShowUnmanagedWorktrees(): [boolean, (on: boolean) => void] {
  const [show, setShow] = useLiveSetting(
    (s) => s.agentboard?.showUnmanagedWorktrees,
    DEFAULT_SHOW_UNMANAGED_WORKTREES,
  );
  // Rust owns this write (see above) — not `persistAgentboardSetting`.
  const persist = useCallback(
    (on: boolean) => {
      setShow(on);
      void invoke("ab_set_show_unmanaged_worktrees", { show: on });
    },
    [setShow],
  );
  return [show, persist];
}

/** Off, so the pane costs nothing until asked for: mounting `NativePane` is
 * what starts the render thread. */
export const DEFAULT_BROWSER_PANE = false;

/** Whether checkouts offer the Chrome pane. Off means no entry point rather
 * than a disabled one. */
export function useBrowserPane(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useLiveSetting((s) => s.agentboard?.browserPane, DEFAULT_BROWSER_PANE);
  const persist = useCallback(
    (next: boolean) => {
      setOn(next);
      void persistAgentboardSetting("browserPane", next);
    },
    [setOn],
  );
  return [on, persist];
}

export const DEFAULT_JARVIS_PANE = false;

/** One switch for both Bevy surfaces: the rail strip and the `jarvis` pane.
 * Off, no `NativePane` renders at all — but it is not a way to reclaim one
 * after the fact: a shown pane's renderer is parked for the app's life. */
export function useJarvisPane(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useLiveSetting((s) => s.agentboard?.jarvisPane, DEFAULT_JARVIS_PANE);
  const persist = useCallback(
    (next: boolean) => {
      setOn(next);
      void persistAgentboardSetting("jarvisPane", next);
    },
    [setOn],
  );
  return [on, persist];
}
