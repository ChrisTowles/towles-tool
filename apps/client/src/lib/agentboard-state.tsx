import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "./tauri";
import { applyOverlays, type Overlay, type StatePayload, type WindowsPayload } from "./agentboard";

const EMPTY_WINDOWS: WindowsPayload = { windows: [], activeWindows: {} };

const EMPTY: StatePayload = {
  repos: [],
  compactRecommendPercent: 30,
  windows: EMPTY_WINDOWS,
  collapsed: {},
  agentScanOk: true,
  ts: 0,
};

/** One app-wide subscription to the live agentboard state — screens stay
 * mounted, so per-consumer listeners meant ~5 fetches for one payload. */
const AgentboardStateContext = createContext<StatePayload | null>(null);
const SetOverlayContext = createContext<((id: string, o: Overlay) => void) | null>(null);

/** Covers the gap until the ~2s scan lands. */
const OVERLAY_MS = 2_500;

export function AgentboardStateProvider({ children }: { children: ReactNode }) {
  const [snapshot, setState] = useState<StatePayload>(EMPTY);
  // Applied at the source so every reader agrees with the row that asked.
  const [overlays, setOverlays] = useState<Record<string, Overlay & { at: number }>>({});
  const setOverlay = useCallback((id: string, o: Overlay) => {
    const at = Date.now();
    setOverlays((m) => ({ ...m, [id]: { ...o, at } }));
    setTimeout(() => {
      setOverlays((m) => {
        if (m[id]?.at !== at) return m;
        const { [id]: _, ...rest } = m;
        return rest;
      });
    }, OVERLAY_MS);
  }, []);
  const state = useMemo(() => applyOverlays(snapshot, overlays), [snapshot, overlays]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      // Outside Tauri (bare-browser dev), `listen` throws on the missing IPC
      // internals — stay empty rather than leak an unhandled rejection.
      if (!("__TAURI_INTERNALS__" in window)) {
        setState(EMPTY);
        return;
      }

      const { listen } = await import("@tauri-apps/api/event");

      // The initial fetch resolves *after* the subscription is live, so a
      // newer event can land first — `ts` keeps it from being rolled back.
      const accept = (payload: StatePayload) =>
        setState((cur) => (payload.ts < cur.ts ? cur : payload));

      const sub = await listen<StatePayload>("agentboard://state", (e) => {
        accept(e.payload);
      });
      if (disposed) {
        sub();
        return;
      }
      unlisten = sub;

      const initial = await invoke<StatePayload>("ab_get_state");
      if (initial.isOk() && !disposed) accept(initial.value);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <AgentboardStateContext.Provider value={state}>
      <SetOverlayContext.Provider value={setOverlay}>{children}</SetOverlayContext.Provider>
    </AgentboardStateContext.Provider>
  );
}

/** The live agentboard state, empty until the first snapshot arrives. */
export function useAgentboardState(): StatePayload {
  const ctx = useContext(AgentboardStateContext);
  if (ctx === null) {
    throw new Error("useAgentboardState must be used within an AgentboardStateProvider");
  }
  return ctx;
}

/** Paint `o` over a session app-wide until the scan confirms or contradicts it. */
export function useSetAgentOverlay(): (id: string, o: Overlay) => void {
  const ctx = useContext(SetOverlayContext);
  if (ctx === null) {
    throw new Error("useSetAgentOverlay must be used within an AgentboardStateProvider");
  }
  return ctx;
}
