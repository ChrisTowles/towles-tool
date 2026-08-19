import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "./tauri";
import type { StatePayload, WindowsPayload } from "./agentboard";

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

export function AgentboardStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StatePayload>(EMPTY);

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
    <AgentboardStateContext.Provider value={state}>{children}</AgentboardStateContext.Provider>
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
