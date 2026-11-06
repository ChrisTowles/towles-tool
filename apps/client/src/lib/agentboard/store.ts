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

/** The agentboard feed as one immutable value. `base` is the newest snapshot
 * that changed anything (structurally shared with the one before); `latestTs`
 * is the newest stamp seen at all, the guard against a stale initial fetch. */
export type AgentboardModel = Readonly<{
  base: StatePayload;
  latestTs: number;
  overlays: Overlays;
  /** `base` with overlays painted, shared with the previous view. */
  view: StatePayload;
}>;

export const INITIAL_AGENTBOARD: AgentboardModel = {
  base: EMPTY_STATE,
  latestTs: 0,
  overlays: {},
  view: EMPTY_STATE,
};

export type AgentboardMsg =
  | { kind: "Accept"; payload: StatePayload; now: number }
  | { kind: "SetOverlay"; id: string; overlay: Overlay; now: number }
  | { kind: "Settle"; now: number };

const repaint = (m: Omit<AgentboardModel, "view">, prev: StatePayload): AgentboardModel => ({
  ...m,
  view: replaceEqualDeep(prev, applyOverlays(m.base, m.overlays)),
});

/** Pure: the only way the agentboard feed changes. Returns `m` itself when a
 * message changes nothing, so no reader wakes. */
export function updateAgentboard(m: AgentboardModel, msg: AgentboardMsg): AgentboardModel {
  switch (msg.kind) {
    case "Accept": {
      if (msg.payload.ts < m.latestTs) return m;
      const shared = replaceEqualDeep(m.base, { ...msg.payload, ts: m.base.ts });
      const base =
        shared !== m.base || m.base.ts === 0 ? { ...shared, ts: msg.payload.ts } : m.base;
      const overlays = settleOverlays(m.overlays, base, msg.payload.ts, msg.now);
      if (base === m.base && overlays === m.overlays) return { ...m, latestTs: msg.payload.ts };
      return repaint({ base, latestTs: msg.payload.ts, overlays }, m.view);
    }
    case "SetOverlay":
      return repaint(
        { ...m, overlays: { ...m.overlays, [msg.id]: { ...msg.overlay, at: msg.now } } },
        m.view,
      );
    case "Settle": {
      const overlays = settleOverlays(m.overlays, m.base, m.latestTs, msg.now);
      return overlays === m.overlays ? m : repaint({ ...m, overlays }, m.view);
    }
  }
}
