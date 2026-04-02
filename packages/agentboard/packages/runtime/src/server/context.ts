import type { Server } from "bun";
import type { MuxProvider, FullSidebarCapable, SidebarPane } from "../contracts/mux";
import type { AgentTracker } from "../agents/tracker";
import type { SessionOrder } from "./session-order";
import type { SessionMetadataStore } from "./metadata-store";
import type { SidebarResizeContext, SidebarResizeSuppression } from "./sidebar-width-sync";
import type { ServerState } from "../shared";
import type { AgentStatus } from "../contracts/agent";

export interface PaneAgentPresence {
  agent: string;
  session: string;
  paneId: string;
  threadId?: string;
  threadName?: string;
  status?: AgentStatus;
  lastSeenTs: number;
}

/**
 * Shared mutable state for all server modules.
 * Created once in startServer(), passed to all sub-modules.
 */
export interface ServerContext {
  // Core dependencies
  mux: MuxProvider;
  allProviders: MuxProvider[];
  tracker: AgentTracker;
  sessionOrder: SessionOrder;
  metadataStore: SessionMetadataStore;

  // Config
  currentTheme: string | undefined;
  sidebarWidth: number;
  sidebarPosition: "left" | "right";
  sidebarVisible: boolean;
  home: string;

  // Session/focus state
  focusedSession: string | null;
  lastState: ServerState | null;
  clientCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  clientTtys: WeakMap<object, string>;
  clientSessionNames: WeakMap<object, string>;
  sessionProviders: Map<string, MuxProvider>;
  clientTtyBySession: Map<string, string>;

  // Current session cache
  cachedCurrentSession: string | null;
  cachedCurrentSessionTs: number;

  // Sidebar state
  pendingSidebarSpawns: Set<string>;
  suppressedSidebarResizeAcks: Map<string, SidebarResizeSuppression>;
  sidebarSnapshots: Map<string, { width?: number; windowWidth?: number }>;
  pendingSidebarResize: ReturnType<typeof setTimeout> | null;
  sidebarPaneCache: { provider: FullSidebarCapable; panes: SidebarPane[] }[] | null;
  sidebarPaneCacheTs: number;
  ensureSidebarTimer: ReturnType<typeof setTimeout> | null;
  ensureSidebarPendingCtx: { session: string; windowId: string } | undefined;

  // Pane agent scanning
  paneAgentsBySession: Map<string, Map<string, PaneAgentPresence>>;
  paneScanTimer: ReturnType<typeof setInterval> | null;

  // Port polling
  portPollTimer: ReturnType<typeof setInterval> | null;

  // Highlight tracking
  pendingHighlightResets: Map<string, ReturnType<typeof setTimeout>>;

  // Server ref (set after Bun.serve)
  server: Server;

  // Wired functions
  broadcastState: () => void;
  broadcastFocusOnly: (sender?: any) => void;
  getCurrentSession: () => string | null;
  getCachedCurrentSession: () => string | null;
  invalidateCurrentSessionCache: () => void;
  getProvidersWithSidebar: () => FullSidebarCapable[];
  listSidebarPanesByProvider: () => { provider: FullSidebarCapable; panes: SidebarPane[] }[];
  invalidateSidebarPaneCache: () => void;
  handleFocus: (name: string) => void;
  moveFocus: (delta: -1 | 1, sender?: any) => void;
  setFocus: (name: string, sender?: any) => void;
  refreshPaneAgents: () => void;
  cleanup: () => void;
  toggleSidebar: (ctx?: { session: string; windowId: string }) => void;
  ensureSidebarInWindow: (
    provider?: FullSidebarCapable,
    ctx?: { session: string; windowId: string },
  ) => void;
  debouncedEnsureSidebar: (ctx?: { session: string; windowId: string }) => void;
  scheduleSidebarResize: (ctx?: SidebarResizeContext) => void;
  resizeSidebars: (ctx?: SidebarResizeContext) => void;
  quitAll: () => void;
  switchToVisibleIndex: (index: number, clientTty?: string) => void;
  focusAgentPane: (
    sessionName: string,
    agentName: string,
    threadId?: string,
    threadName?: string,
  ) => void;
  killAgentPane: (
    sessionName: string,
    agentName: string,
    threadId?: string,
    threadName?: string,
  ) => void;
}
