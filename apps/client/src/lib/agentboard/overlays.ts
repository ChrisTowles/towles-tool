import type { AgentStatus, SessionData, StatePayload } from "./types";

/** Painted over the snapshot until one agrees with it; needs-you clears, since
 * the user just acted on this session. */
export type Overlay = { status: AgentStatus; working: boolean };

/** An {@link Overlay} and when it was painted (epoch ms). */
export type StampedOverlay = Overlay & { at: number };

export type Overlays = Record<string, StampedOverlay>;

export const OVERLAY_STARTED: Overlay = { status: "busy", working: true };

export const OVERLAY_STOPPED: Overlay = { status: "interrupted", working: false };

/** Backstop for an overlay no snapshot ever confirms (the agent never started,
 * the session closed), so a wrong paint cannot stick. */
export const OVERLAY_BACKSTOP_MS = 10_000;

/** Whether a snapshot stamped `stateTs` agrees with the overlay on `s`. One
 * stamped before the overlay was painted predates the action, so it cannot. */
export function overlayConfirmed(o: StampedOverlay, s: SessionData, stateTs: number): boolean {
  return stateTs >= o.at && s.working === o.working;
}

/** `overlays` without the ones `base` (a snapshot with no overlays painted,
 * stamped `stateTs`) confirms, that outlived {@link OVERLAY_BACKSTOP_MS}, or
 * whose session the snapshot no longer has. `overlays` itself when none go. */
export function settleOverlays(
  overlays: Overlays,
  base: StatePayload,
  stateTs: number,
  now: number,
): Overlays {
  const ids = Object.keys(overlays);
  if (ids.length === 0) return overlays;
  const sessions = new Map<string, SessionData>();
  for (const repo of base.repos) {
    for (const folder of repo.folders) for (const s of folder.sessions) sessions.set(s.id, s);
  }
  const kept: Overlays = {};
  for (const id of ids) {
    const o = overlays[id]!;
    if (now - o.at >= OVERLAY_BACKSTOP_MS) continue;
    const s = sessions.get(id);
    if (stateTs >= o.at && (!s || overlayConfirmed(o, s, stateTs))) continue;
    kept[id] = o;
  }
  return Object.keys(kept).length === ids.length ? overlays : kept;
}

/** `state` itself when nothing is overlaid, so consumers' memos hold. */
export function applyOverlays(state: StatePayload, overlays: Overlays): StatePayload {
  if (Object.keys(overlays).length === 0) return state;
  const repos = state.repos.map((repo) => {
    const folders = repo.folders.map((folder) => {
      if (!folder.sessions.some((s) => overlays[s.id])) return folder;
      const sessions = folder.sessions.map((s) => {
        const o = overlays[s.id];
        if (!o) return s;
        return {
          ...s,
          live: true,
          working: o.working,
          needsReason: null,
          needsSinceMs: null,
          agentState: {
            agent: "claude-code",
            session: "",
            ts: o.at,
            ...s.agentState,
            status: o.status,
          },
        };
      });
      return { ...folder, sessions, needs: sessions.filter((s) => s.needsReason != null).length };
    });
    if (folders.every((f, i) => f === repo.folders[i])) return repo;
    return { ...repo, folders, needs: folders.reduce((n, f) => n + f.needs, 0) };
  });
  return { ...state, repos };
}
