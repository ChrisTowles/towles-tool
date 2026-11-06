// Open-screens bookkeeping as atoms. Components read the atoms; anything —
// a component, a shortcut, an IPC callback — changes them through the action
// functions below, which are the only writers. Contract: docs/CLIENT-STATE.md.
import { Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { persistedAtom } from "@/lib/atoms/persisted";
import { read, write } from "@/lib/atoms/registry";
import type { RailView, ScreenId } from "@/lib/screens";
import { focusTargetAtom, type FocusTarget } from "@/lib/focus-target";
import { settingsTargetAtom, type SettingsTarget } from "@/lib/settings-target";
import {
  ACTIVE_TAB_KEY,
  loadWorkspaceTabs,
  OPEN_TABS_KEY,
  updateTabs,
  type Tabs,
  type TabsMsg,
} from "@/lib/workspace-persistence";

const readKey = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const restored = loadWorkspaceTabs(readKey(ACTIVE_TAB_KEY), readKey(OPEN_TABS_KEY));

const tabsState = Atom.make<Tabs>({
  ...restored,
  recent: [restored.activeTab, ...restored.openTabs.filter((id) => id !== restored.activeTab)],
}).pipe(Atom.keepAlive);

/** Screens are mounted once on first visit and kept mounted (hidden via CSS),
 * so their state — e.g. Agentboard's terminals — survives switching. Persisting
 * `openTabs` keeps a closed tab from resurrecting on reload. */
const tabsAtom = Atom.writable(
  (get) => get(tabsState),
  (ctx, msg: TabsMsg) => {
    const prev = ctx.get(tabsState);
    const next = updateTabs(prev, msg);
    if (next === prev) return;
    ctx.set(tabsState, next);
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, next.activeTab);
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(next.openTabs));
    } catch {
      // Unremembered, the tabs still apply for this session.
    }
  },
).pipe(Atom.keepAlive);

export const openTabsAtom = Atom.make((get) => get(tabsAtom).openTabs);
/** Most-recently-opened order, for the palette's "Recent" section. */
export const recentTabsAtom = Atom.make((get) => get(tabsAtom).recent);
export const activeTabAtom = Atom.make((get) => get(tabsAtom).activeTab).pipe(Atom.keepAlive);

/** Icon-only is the default; expanding is the remembered opt-in. */
export const sidebarCollapsedAtom = persistedAtom("tt-sidebar-collapsed", Schema.Boolean, true);

/** Agent Board's rail: the task queue or the checkout tree, over the same panes.
 * Remembered: whichever rail you left is the one you work from. */
export const railViewAtom = persistedAtom<RailView, RailView>(
  "tt-rail-view",
  Schema.Literals(["tree", "queue"]),
  "tree",
);

/** Chrome hidden so the active screen owns the window. Not persisted. */
export const zenAtom = Atom.make(false).pipe(Atom.keepAlive);
export const paletteOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const openTab = (id: ScreenId): void => write(tabsAtom, { kind: "Open", id });
/** The last remaining tab can't be closed; closing the active one moves focus
 * to the neighbor that slides into its place. */
export const closeTab = (id: ScreenId): void => write(tabsAtom, { kind: "Close", id });
export const stepTab = (step: 1 | -1): void => write(tabsAtom, { kind: "Step", step });

export function openTabWithFocus(target: FocusTarget): void {
  openTab(target.screen);
  write(focusTargetAtom, target);
}

export function openSettingsTab(target?: SettingsTarget): void {
  openTab("settings");
  if (target) write(settingsTargetAtom, target);
}

export const setRailView = (view: RailView): void => write(railViewAtom, view);
export const toggleSidebar = (): void => write(sidebarCollapsedAtom, !read(sidebarCollapsedAtom));
export const setZen = (on: boolean): void => write(zenAtom, on);
export const toggleZen = (): void => write(zenAtom, !read(zenAtom));
export const setPaletteOpen = (open: boolean): void => write(paletteOpenAtom, open);
