import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ScreenId } from "@/lib/screens";
import { focusTargetStore, type FocusTarget } from "@/lib/focus-target";
import { settingsTargetStore, type SettingsTarget } from "@/lib/settings-target";
import { ACTIVE_TAB_KEY, loadWorkspaceTabs, OPEN_TABS_KEY } from "@/lib/workspace-persistence";

type WorkspaceState = {
  openTabs: ScreenId[];
  /** Most-recently-opened order, for the palette's "Recent" section;
   * `openTabs` is first-visit order. */
  recent: ScreenId[];
  activeTab: ScreenId;
  sidebarCollapsed: boolean;
  /** Chrome hidden so the active screen owns the window. Not persisted. */
  zen: boolean;
  paletteOpen: boolean;
  openTab: (id: ScreenId) => void;
  openTabWithFocus: (target: FocusTarget) => void;
  openSettingsTab: (target?: SettingsTarget) => void;
  /** The last remaining tab can't be closed; closing the active one moves
   * focus to the neighbor that slides into its place. */
  closeTab: (id: ScreenId) => void;
  toggleSidebar: () => void;
  toggleZen: () => void;
  setZen: (on: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const SIDEBAR_COLLAPSED_KEY = "tt-sidebar-collapsed";

const restored = loadWorkspaceTabs(
  localStorage.getItem(ACTIVE_TAB_KEY),
  localStorage.getItem(OPEN_TABS_KEY),
);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  // Screens are mounted once on first visit and kept mounted (hidden via CSS)
  // so their local state — e.g. Agentboard's terminals — survives switching.
  const [openTabs, setOpenTabs] = useState<ScreenId[]>(restored.openTabs);
  const [recent, setRecent] = useState<ScreenId[]>(() => [
    restored.activeTab,
    ...restored.openTabs.filter((id) => id !== restored.activeTab),
  ]);
  const [activeTab, setActiveTab] = useState<ScreenId>(restored.activeTab);
  // Icon-only is the default; expanding is the remembered opt-in.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== "false",
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [zen, setZen] = useState(false);

  // Persisting `openTabs` keeps a closed tab from resurrecting on reload.
  useEffect(() => {
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs));
  }, [activeTab, openTabs]);

  const openTab = useCallback((id: ScreenId) => {
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setRecent((prev) => [id, ...prev.filter((x) => x !== id)]);
    setActiveTab(id);
  }, []);

  const openTabWithFocus = useCallback(
    (target: FocusTarget) => {
      openTab(target.screen);
      focusTargetStore.set(target);
    },
    [openTab],
  );

  const openSettingsTab = useCallback(
    (target?: SettingsTarget) => {
      openTab("settings");
      if (target) settingsTargetStore.set(target);
    },
    [openTab],
  );

  const closeTab = useCallback(
    (id: ScreenId) => {
      if (openTabs.length <= 1 || !openTabs.includes(id)) return;
      const idx = openTabs.indexOf(id);
      const next = openTabs.filter((s) => s !== id);
      setOpenTabs(next);
      if (activeTab === id) {
        setActiveTab(next[Math.min(idx, next.length - 1)]);
      }
    },
    [openTabs, activeTab],
  );

  const toggleSidebar = useCallback(
    () =>
      setSidebarCollapsed((v) => {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!v));
        return !v;
      }),
    [],
  );

  const toggleZen = useCallback(() => setZen((v) => !v), []);

  const value = useMemo(
    () => ({
      openTabs,
      recent,
      activeTab,
      sidebarCollapsed,
      zen,
      paletteOpen,
      openTab,
      openTabWithFocus,
      openSettingsTab,
      closeTab,
      toggleSidebar,
      toggleZen,
      setZen,
      setPaletteOpen,
    }),
    [
      openTabs,
      recent,
      activeTab,
      sidebarCollapsed,
      zen,
      paletteOpen,
      openTab,
      openTabWithFocus,
      openSettingsTab,
      closeTab,
      toggleSidebar,
      toggleZen,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
