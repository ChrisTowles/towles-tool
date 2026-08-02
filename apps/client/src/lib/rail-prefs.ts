import { useCallback } from "react";
import { persistAgentboardSetting, useLiveSetting, type RailFilter } from "./settings";
import { invoke } from "./tauri";

/** Built-in default for `agentboard.railFilter` — everything, so a fresh
 * install never wonders where a checkout went. Mirrors Rust's
 * `tt_config::DEFAULT_RAIL_FILTER`. */
export const DEFAULT_RAIL_FILTER: RailFilter = "all";

/** Built-in default for `agentboard.railRecentHours` — mirrors Rust's
 * `tt_config::DEFAULT_RAIL_RECENT_HOURS`. */
export const DEFAULT_RAIL_RECENT_HOURS = 4;

/** The hour spans the rail's filter menu offers for `"recent"`. */
export const RAIL_RECENT_HOUR_CHOICES = [2, 4, 8, 24, 48, 96, 24 * 7];

/**
 * Track the Agentboard rail's filter (`agentboard.railFilter`) and the window
 * `"recent"` measures (`agentboard.railRecentHours`) as state, plus setters
 * that update state and persist back to the shared settings file.
 * `useLiveSetting` carries the re-read-on-save/focus policy every preference
 * hook shares.
 *
 * One hook for both keys because they're one control: the mode is meaningless
 * to the user without the span it measures, so the rail's menu shows and sets
 * them together.
 */
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

/** Built-in default for `agentboard.showUnmanagedWorktrees` — off, so only the
 * main checkout and worktrees the user asked for appear as rail folders. Mirrors
 * `tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES`. */
export const DEFAULT_SHOW_UNMANAGED_WORKTREES = false;

/**
 * Track the Agentboard rail's "show worktrees no board task is bound to" filter
 * (`agentboard.showUnmanagedWorktrees`) as state, plus a setter.
 *
 * Unlike {@link useRailFilter} this is not a view filter the client can
 * apply itself: the setting decides which checkouts the *engine* discovers at
 * all, so the setter goes through `ab_set_show_unmanaged_worktrees` and Rust
 * owns the write (it re-emits `agentboard://state`, which is what repopulates
 * the rail). Reads still come off the settings file, so a change made from
 * another window flows back on focus / `SETTINGS_SAVED_EVENT`.
 */
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

/** Built-in default for `agentboard.jarvisPane` — off, so the proof-of-concept
 * native Bevy pane costs nothing until it's asked for. Unlike
 * {@link DEFAULT_SHOW_UNMANAGED_WORKTREES} this has no Rust counterpart to
 * mirror: nothing in Rust interprets the setting, since mounting `NativePane`
 * is what starts the render thread. This is the only default. */
export const DEFAULT_BROWSER_PANE = false;

/** `agentboard.browserPane` — whether checkouts offer the Chrome pane
 * (`components/browser-pane.tsx`). Frontend-only, like {@link useJarvisPane}:
 * Rust never reads the key; off means no entry point rather than a disabled
 * one. */
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

/**
 * Track whether the native Bevy surface is enabled at all
 * (`agentboard.jarvisPane`), plus a setter that persists back to the shared
 * settings file. One switch covers both surfaces: the strip at the bottom of
 * the rail, and whether a checkout offers the `jarvis` pane that tiles one
 * beside its terminals (`components/jarvis-pane.tsx`).
 *
 * Frontend-only like {@link useRailFilter} — Rust never reads the key.
 * Off, no `NativePane` is rendered, so a checkout that never turns this on
 * never creates a surface or a renderer. It is not a way to reclaim one after
 * the fact: a shown pane's renderer is parked, never dropped, for the app's
 * life (`crates-tauri/tt-pane`).
 */
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
