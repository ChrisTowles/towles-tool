import { STATUS } from "./status";
import type { FolderData, PortDrift, RepoData, SessionData } from "./types";

export function isAgent(s: SessionData): boolean {
  return s.agentState != null;
}

/** Needs you now, or reached a terminal state you haven't acknowledged. */
export function sessionCatchesEye(s: SessionData): boolean {
  return s.needsReason != null || s.unseen;
}

/** The session in its own words: the thread title Claude gave itself, falling
 * back to the launch prompt. `null` when it never spoke. */
export function sessionSaid(s: SessionData): string | null {
  const thread = s.agentState?.threadName?.trim();
  if (thread && thread !== "Claude Code") return thread;
  const purpose = s.purpose?.trim();
  return purpose && purpose.length > 0 ? purpose : null;
}

export function fmtWaitingAge(sinceMs: number | null | undefined, now: number): string | null {
  if (sinceMs == null) return null;
  const diff = now - sinceMs;
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "waiting <1m";
  if (mins < 60) return `waiting ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `waiting ${hrs}h`;
  return `waiting ${Math.floor(hrs / 24)}d`;
}

/** Free to pick up: an agent that isn't working, or a flagged session. A plain
 * shell stays out — it was never an agent to be idle. */
export function sessionNotBusy(s: SessionData): boolean {
  if (s.working) return false;
  return isAgent(s) || sessionCatchesEye(s);
}

export function cycleNotBusy(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): SessionData | null {
  return cycleWhere(repos, fromSessionId, direction, sessionNotBusy);
}

function cycleWhere(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
  match: (s: SessionData) => boolean,
): SessionData | null {
  const all: SessionData[] = [];
  for (const r of repos) for (const f of r.folders) for (const s of f.sessions) all.push(s);

  const targetIndexes = all.map((s, i) => (match(s) ? i : -1)).filter((i) => i !== -1);
  if (targetIndexes.length === 0) return null;

  const fromIndex = fromSessionId ? all.findIndex((s) => s.id === fromSessionId) : -1;

  const chosen =
    direction === "next"
      ? (targetIndexes.find((i) => i > fromIndex) ?? targetIndexes[0])
      : ([...targetIndexes].toReversed().find((i) => i < fromIndex) ??
        targetIndexes[targetIndexes.length - 1]);

  return all[chosen];
}

export function liveSessions(folder: FolderData): SessionData[] {
  return folder.sessions.filter((s) => s.live);
}

/** Deduped by key + spawned/current pair: panes spawned at different times can
 * carry the same drift, or different ones if a port rotated twice. */
export function folderPortDrift(folder: Pick<FolderData, "sessions">): PortDrift[] {
  const seen = new Map<string, PortDrift>();
  for (const s of folder.sessions) {
    for (const d of s.portDrift ?? []) {
      seen.set(`${d.key}:${d.spawnedPort}:${d.currentPort}`, d);
    }
  }
  return [...seen.values()];
}

/** An agent's thread name when it has one, so the row reads as *the agent*. */
export function sessionLabel(s: SessionData): string {
  const thread = s.agentState?.threadName?.trim();
  return thread && thread.length > 0 ? thread : s.name;
}

export function claudeTitleName(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\s*✳\s*(.+?)\s*$/u);
  if (!m || m[1] === "Claude Code") return null;
  return m[1];
}

/** A one-word status label for a session row. */
export function sessionStatusText(s: SessionData): string {
  if (!s.live) return "Starting";
  return STATUS[s.agentState?.status ?? "idle"].label;
}
