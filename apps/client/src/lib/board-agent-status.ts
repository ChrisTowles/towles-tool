import { ALERT_ORDER, isAgent, sessionCatchesEye, type SessionData } from "./agentboard";

export type WorktreeFolder = { dir: string; sessions: SessionData[] };

/** What a Board card wears for its worktree: the rail's loudest session there. */
export type BoardAgentStatus = {
  folderDir: string;
  session: SessionData;
  sessionCount: number;
};

/** Needs-you first (longest wait wins), then the rail's own `ALERT_ORDER`, then
 * live over dead, agent over plain shell, newest last. */
function urgencyKey(s: SessionData): number[] {
  const st = s.agentState?.status;
  const alert = st ? (ALERT_ORDER as readonly string[]).indexOf(st) : -1;
  return [
    sessionCatchesEye(s) ? 0 : 1,
    s.needsSinceMs ?? Number.MAX_SAFE_INTEGER,
    alert === -1 ? ALERT_ORDER.length : alert,
    s.live ? 0 : 1,
    isAgent(s) ? 0 : 1,
    -s.createdAt,
  ];
}

export function compareUrgency(a: SessionData, b: SessionData): number {
  const ka = urgencyKey(a);
  const kb = urgencyKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

export function mostUrgentSession(sessions: SessionData[]): SessionData | undefined {
  return sessions.toSorted(compareUrgency)[0];
}

/** `null` when the rail has no folder at `worktreeDir`, or that folder has no session. */
export function boardAgentStatus(
  repos: { folders: WorktreeFolder[] }[],
  worktreeDir: string | undefined,
): BoardAgentStatus | null {
  const dir = worktreeDir?.trim();
  if (!dir) return null;
  for (const repo of repos) {
    for (const folder of repo.folders) {
      if (folder.dir !== dir) continue;
      const session = mostUrgentSession(folder.sessions);
      if (!session) return null;
      return { folderDir: folder.dir, session, sessionCount: folder.sessions.length };
    }
  }
  return null;
}
