import { useCallback, useEffect, useState } from "react";
import { SETTINGS_SAVED_EVENT, loadUserSettings, saveUserSettings } from "./settings";
import { invoke } from "./tauri";

/** Built-in default for `agentboard.hideInactiveRepos` — off, showing everything. */
export const DEFAULT_HIDE_INACTIVE_REPOS = false;

/**
 * Track the Agentboard rail's "hide inactive repos" eye-icon filter
 * (`agentboard.hideInactiveRepos`) as state, plus a setter that updates state
 * and persists back to the shared settings file. Like `useBoardGroupByRepo`
 * (`lib/board-prefs.ts`), re-reads on `SETTINGS_SAVED_EVENT` and on window
 * focus so a change made elsewhere flows back into this hook.
 */
export function useHideInactiveRepos(): [boolean, (on: boolean) => void] {
  const [hideInactive, setHideInactive] = useState(DEFAULT_HIDE_INACTIVE_REPOS);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void loadUserSettings().then((s) => {
        if (alive && s)
          setHideInactive(s.agentboard?.hideInactiveRepos ?? DEFAULT_HIDE_INACTIVE_REPOS);
      });
    load();
    window.addEventListener("focus", load);
    window.addEventListener(SETTINGS_SAVED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener(SETTINGS_SAVED_EVENT, load);
    };
  }, []);

  // Read-modify-write the whole settings object so unknown keys survive the
  // save. Best-effort: a failed persist leaves this session's view correct.
  const persist = useCallback((on: boolean) => {
    setHideInactive(on);
    void loadUserSettings().then((s) => {
      if (!s) return;
      void saveUserSettings({
        ...s,
        agentboard: { ...s.agentboard, hideInactiveRepos: on },
      });
    });
  }, []);

  return [hideInactive, persist];
}

/** Built-in default for `agentboard.showUnmanagedWorktrees` — off, so only the
 * main checkout and `tt task` worktrees appear as rail folders. Mirrors
 * `tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES`. */
export const DEFAULT_SHOW_UNMANAGED_WORKTREES = false;

/**
 * Track the Agentboard rail's "show worktrees `tt task` didn't create" filter
 * (`agentboard.showUnmanagedWorktrees`) as state, plus a setter.
 *
 * Unlike {@link useHideInactiveRepos} this is not a view filter the client can
 * apply itself: the setting decides which checkouts the *engine* discovers at
 * all, so the setter goes through `ab_set_show_unmanaged_worktrees` and Rust
 * owns the write (it re-emits `agentboard://state`, which is what repopulates
 * the rail). Reads still come off the settings file, so a change made from
 * another window flows back on focus / `SETTINGS_SAVED_EVENT`.
 */
export function useShowUnmanagedWorktrees(): [boolean, (on: boolean) => void] {
  const [show, setShow] = useState(DEFAULT_SHOW_UNMANAGED_WORKTREES);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void loadUserSettings().then((s) => {
        if (alive && s)
          setShow(s.agentboard?.showUnmanagedWorktrees ?? DEFAULT_SHOW_UNMANAGED_WORKTREES);
      });
    load();
    window.addEventListener("focus", load);
    window.addEventListener(SETTINGS_SAVED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener(SETTINGS_SAVED_EVENT, load);
    };
  }, []);

  const persist = useCallback((on: boolean) => {
    setShow(on);
    void invoke("ab_set_show_unmanaged_worktrees", { show: on });
  }, []);

  return [show, persist];
}
