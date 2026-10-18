import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@/lib/tauri";
import { useStoreSelector } from "@/lib/external-store";
import { OVERLAY_BACKSTOP_MS, type Overlay } from "@/lib/agentboard/overlays";
import { createAgentboardStore, type AgentboardStore } from "@/lib/agentboard/store";
import type { RepoData, StatePayload } from "@/lib/agentboard/types";

/** One app-wide subscription to the live agentboard state — screens stay
 * mounted, so per-consumer listeners meant ~5 fetches for one payload. The
 * context holds a store, so a payload re-renders only the readers whose slice
 * changed. */
const AgentboardStoreContext = createContext<AgentboardStore | null>(null);
const SetOverlayContext = createContext<((id: string, o: Overlay) => void) | null>(null);

export function AgentboardStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createAgentboardStore());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Applied at the source so every reader agrees with the row that asked. It
  // lasts until a snapshot agrees (see `settleOverlays`), the timer being only
  // the backstop for one that never does.
  const setOverlay = useCallback(
    (id: string, o: Overlay) => {
      store.setOverlay(id, o, Date.now());
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        store.settle(Date.now());
      }, OVERLAY_BACKSTOP_MS);
      timers.current.add(timer);
    },
    [store],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      // Outside Tauri (bare-browser dev), `listen` throws on the missing IPC
      // internals — stay empty rather than leak an unhandled rejection.
      if (!("__TAURI_INTERNALS__" in window)) return;

      const { listen } = await import("@tauri-apps/api/event");

      // The initial fetch resolves *after* the subscription is live, so a
      // newer event can land first — the store's `ts` guard keeps it from
      // being rolled back.
      const accept = (payload: StatePayload) => store.accept(payload, Date.now());

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
  }, [store]);

  return (
    <AgentboardStoreContext.Provider value={store}>
      <SetOverlayContext.Provider value={setOverlay}>{children}</SetOverlayContext.Provider>
    </AgentboardStoreContext.Provider>
  );
}

function useAgentboardStore(): AgentboardStore {
  const ctx = useContext(AgentboardStoreContext);
  if (ctx === null) {
    throw new Error("agentboard state hooks must be used within an AgentboardStateProvider");
  }
  return ctx;
}

/** The live agentboard state, empty until the first snapshot arrives. It
 * changes only when a payload changes something; a reader that needs one slice
 * should use {@link useAgentboardSelector} instead. */
export function useAgentboardState(): StatePayload {
  return useAgentboardSelector((s) => s);
}

/** A slice of the state; re-renders only when it changes. The selector must
 * return a subtree of the state, not a value it builds, since the snapshot's
 * structural sharing is what keeps the reference stable. */
export function useAgentboardSelector<S>(selector: (state: StatePayload) => S): S {
  return useStoreSelector(useAgentboardStore().state, selector);
}

const selectRepos = (s: StatePayload): RepoData[] => s.repos;

/** The tracked repos; unchanged by a payload that only moved other fields. */
export function useRepos(): RepoData[] {
  return useAgentboardSelector(selectRepos);
}

/** The state as of the call, without subscribing: for event handlers that read
 * it at delivery time and must not re-render on every change. */
export function useAgentboardRead(): () => StatePayload {
  return useAgentboardStore().state.get;
}

/** Paint `o` over a session app-wide until a snapshot agrees with it. */
export function useSetAgentOverlay(): (id: string, o: Overlay) => void {
  const ctx = useContext(SetOverlayContext);
  if (ctx === null) {
    throw new Error("useSetAgentOverlay must be used within an AgentboardStateProvider");
  }
  return ctx;
}
