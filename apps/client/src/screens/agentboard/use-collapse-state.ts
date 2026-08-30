import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import type { StatePayload } from "@/lib/agentboard";
import type { CollapseChange } from "@/lib/rail-collapse";
import { RAIL_COLLAPSE_KEY } from "./helpers";

export type CollapseState = {
  collapsed: Record<string, boolean>;
  toggleCollapsed: (key: string) => void;
  /** Set several keys outright — the keyboard's collapse/expand chords. */
  applyCollapse: (changes: CollapseChange[]) => void;
  railCollapsed: boolean;
  toggleRail: () => void;
};

// Hydrated once from `ab_get_state`, then locally owned like `wins` — except
// each toggle saves one key rather than a debounced blob, since a collapse
// entry is never ambiguous between "not yet toggled" and "explicitly reset".
export function useCollapseState(state: StatePayload): CollapseState {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const hydratedCollapsed = useRef(false);
  useEffect(() => {
    if (!hydratedCollapsed.current && state.ts > 0) {
      hydratedCollapsed.current = true;
      setCollapsed(state.collapsed);
    }
  }, [state.ts, state.collapsed]);

  function toggleCollapsed(key: string) {
    setCollapsed((c) => {
      const next = !c[key];
      void invoke("ab_save_collapsed", { key, collapsed: next });
      return { ...c, [key]: next };
    });
  }

  function applyCollapse(changes: CollapseChange[]) {
    if (changes.length === 0) return;
    for (const c of changes)
      void invoke("ab_save_collapsed", { key: c.key, collapsed: c.collapsed });
    setCollapsed((c) => ({
      ...c,
      ...Object.fromEntries(changes.map((n) => [n.key, n.collapsed])),
    }));
  }

  // Whole-rail icon collapse (issue #70): same persisted map, sentinel key.
  const railCollapsed = !!collapsed[RAIL_COLLAPSE_KEY];
  const toggleRail = () => {
    uiAction("agentboard.rail_toggle", "agentboard", railCollapsed ? "expand" : "collapse");
    toggleCollapsed(RAIL_COLLAPSE_KEY);
  };

  return { collapsed, toggleCollapsed, applyCollapse, railCollapsed, toggleRail };
}
