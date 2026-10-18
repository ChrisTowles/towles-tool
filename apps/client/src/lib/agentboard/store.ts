import { createStore, type Store } from "@/lib/external-store";
import { replaceEqualDeep } from "@/lib/replace-equal-deep";
import {
  applyOverlays,
  settleOverlays,
  type Overlay,
  type Overlays,
} from "@/lib/agentboard/overlays";
import type { StatePayload, WindowsPayload } from "@/lib/agentboard/types";

const EMPTY_WINDOWS: WindowsPayload = { windows: [], activeWindows: {} };

export const EMPTY_STATE: StatePayload = {
  repos: [],
  compactRecommendPercent: 30,
  windows: EMPTY_WINDOWS,
  collapsed: {},
  agentScanOk: true,
  ts: 0,
};

export type AgentboardStore = {
  /** The snapshot with overlays painted, structurally shared with the last one:
   * a subtree no payload touched keeps its identity. `ts` is the stamp of the
   * last payload that changed anything, so an identical re-send is no event. */
  state: Store<StatePayload>;
  accept: (payload: StatePayload, now: number) => void;
  setOverlay: (id: string, overlay: Overlay, now: number) => void;
  /** Drop overlays that are confirmed or past their backstop. */
  settle: (now: number) => void;
};

export function createAgentboardStore(initial: StatePayload = EMPTY_STATE): AgentboardStore {
  const state = createStore(initial);
  let base = initial;
  // Newest payload seen, changed or not: the guard against a stale initial fetch.
  let latestTs = initial.ts;
  let overlays: Overlays = {};

  const publish = () => state.set(replaceEqualDeep(state.get(), applyOverlays(base, overlays)));

  return {
    state,
    accept(payload, now) {
      if (payload.ts < latestTs) return;
      latestTs = payload.ts;
      const shared = replaceEqualDeep(base, { ...payload, ts: base.ts });
      if (shared !== base || base.ts === 0) base = { ...shared, ts: payload.ts };
      overlays = settleOverlays(overlays, base, latestTs, now);
      publish();
    },
    setOverlay(id, overlay, now) {
      overlays = { ...overlays, [id]: { ...overlay, at: now } };
      publish();
    },
    settle(now) {
      const next = settleOverlays(overlays, base, latestTs, now);
      if (next === overlays) return;
      overlays = next;
      publish();
    },
  };
}
