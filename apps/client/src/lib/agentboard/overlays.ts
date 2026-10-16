import type { AgentStatus, StatePayload } from "./types";

/** Painted over the snapshot for a fixed window; needs-you clears, since the
 * user just acted on this session. */
export type Overlay = { status: AgentStatus; working: boolean };

export const OVERLAY_STARTED: Overlay = { status: "busy", working: true };

export const OVERLAY_STOPPED: Overlay = { status: "interrupted", working: false };

/** `state` itself when nothing is overlaid, so consumers' memos hold. */
export function applyOverlays(
  state: StatePayload,
  overlays: Record<string, Overlay & { at: number }>,
): StatePayload {
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
