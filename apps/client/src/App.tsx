import { useAtomValue } from "@/lib/atoms/react";
import { useEffect } from "react";
import { toastManager } from "@/lib/toast";
import "@/lib/app-bridges";
import { read } from "@/lib/atoms/registry";
import { AppHeader } from "@/components/app-header";
import { AppSidebar, AppSidebarIcons } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { DmDrawer } from "@/components/dm-drawer";
import { ErrorBoundary } from "@/components/error-boundary";
import { QuickLog } from "@/components/quick-log";
import { StatusBar } from "@/components/status-bar";
import { ResumePicker } from "@/components/resume-picker";
import { UpdateBanner } from "@/components/update-banner";
import { ZenIndicator } from "@/components/zen-indicator";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider, Toasty } from "@cloudflare/kumo";
import { DiffView } from "@/components/diff-view";
import { NoteDialog } from "@/components/note-dialog";
import { QueueNextShortcut } from "@/components/queue-rail";
import { NAV_ORDER, SCREENS } from "@/lib/screens";
import { ShortcutHelpHost, useShortcuts, type ShortcutScope } from "@/lib/shortcuts";
import {
  activeTabAtom,
  closeTab,
  openSettingsTab,
  openTab,
  openTabsAtom,
  paletteOpenAtom,
  railViewAtom,
  setPaletteOpen,
  setZen,
  stepTab,
  sidebarCollapsedAtom,
  toggleSidebar,
  toggleZen,
  zenAtom,
} from "@/lib/workspace";
import { SCREEN_COMPONENTS } from "@/screens";

/** Global (always-active) bindings + the `?` help overlay. Screen-scoped
 * bindings live with their screens (e.g. Agentboard), gated on their tab.
 * Handlers read atoms at call time, so the map never goes stale. */
const GLOBAL_HANDLERS: Partial<Record<string, () => void>> = {
  palette: () => setPaletteOpen(!read(paletteOpenAtom)),
  settings: () => openSettingsTab(),
  sidebar: toggleSidebar,
  zen: toggleZen,
  quicklog: () => window.dispatchEvent(new Event("quicklog:open")),
  "close-tab": () => closeTab(read(activeTabAtom)),
  "next-tab": () => stepTab(1),
  "prev-tab": () => stepTab(-1),
  ...Object.fromEntries(NAV_ORDER.slice(0, 9).map((id, i) => [`tab-${i + 1}`, () => openTab(id)])),
};

function Shortcuts() {
  const activeTab = useAtomValue(activeTabAtom);
  const railView = useAtomValue(railViewAtom);
  useShortcuts(GLOBAL_HANDLERS, activeTab);

  // No per-screen branching: a scope nothing registers against is inert.
  const activeScopes: ShortcutScope[] = [
    "global",
    activeTab,
    ...(activeTab === "agentboard" ? [railView] : []),
  ];
  return <ShortcutHelpHost activeScopes={activeScopes} screen={activeTab} />;
}

function Workspace() {
  const openTabs = useAtomValue(openTabsAtom);
  const activeTab = useAtomValue(activeTabAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const zen = useAtomValue(zenAtom);
  const paletteOpen = useAtomValue(paletteOpenAtom);

  // Escape exits zen — but only when nothing else is claiming Escape. An open
  // dialog/palette (Base UI's `role="dialog"` with `data-open`, plus the
  // paletteOpen flag) handles its own Escape to close first; we don't steal it.
  useEffect(() => {
    if (!zen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (paletteOpen) return;
      if (document.querySelector('[role="dialog"][data-open]')) return;
      e.preventDefault();
      setZen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zen, paletteOpen]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {!zen && <AppHeader />}
      <UpdateBanner />

      <div className="relative flex min-h-0 flex-1">
        {/* Icon-collapsed nav: a fixed-width strip outside the panel group, not
            a ResizablePanel — its width is locked, so react-resizable-panels'
            drag machinery would be pure dead weight (mirrors the Agentboard
            rail's RailIconStrip). */}
        {!zen && sidebarCollapsed && (
          <div className="w-12 shrink-0 border-r bg-background">
            <AppSidebarIcons />
          </div>
        )}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {!zen && !sidebarCollapsed && (
            <>
              <ResizablePanel defaultSize="190px" minSize="160px" maxSize="240px">
                <AppSidebar />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel key="main">
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                {openTabs.map((id) => {
                  const Screen = SCREEN_COMPONENTS[id];
                  const hidden = id !== activeTab;
                  // Keep visited screens mounted so their local state survives switching.
                  // Full-bleed screens (e.g. terminals) skip the centered, scrolling
                  // content wrapper and own the whole content area.
                  return SCREENS[id].fullBleed ? (
                    <div key={id} hidden={hidden} className="h-full">
                      <ErrorBoundary label={SCREENS[id].title}>
                        <Screen />
                      </ErrorBoundary>
                    </div>
                  ) : (
                    <ScrollArea key={id} hidden={hidden} className="h-full">
                      <div className="mx-auto max-w-3xl p-6">
                        <ErrorBoundary label={SCREENS[id].title}>
                          <Screen />
                        </ErrorBoundary>
                      </div>
                    </ScrollArea>
                  );
                })}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        <DmDrawer />
      </div>

      {!zen && <StatusBar />}

      {zen && <ZenIndicator onExit={() => setZen(false)} />}
      <Shortcuts />
      <QueueNextShortcut />
      <CommandPalette />
      <QuickLog />
      <ResumePicker />
      <NoteDialog />
      <DiffView />
    </div>
  );
}

export function App() {
  return (
    <TooltipProvider>
      <Toasty toastManager={toastManager}>
        <Workspace />
      </Toasty>
    </TooltipProvider>
  );
}
