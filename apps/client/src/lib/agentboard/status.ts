import { isCacheExpiring, needsCompact } from "./context";
import type { AgentStatus, RepoData, SessionData } from "./types";

export type AgentRollup = {
  total: number;
  busy: number;
  background: number;
  waiting: number;
  error: number;
  compact: number;
  expiring: number;
};

export function agentRollup(
  repos: RepoData[],
  now: number,
  compactThresholdPct: number,
): AgentRollup {
  const r: AgentRollup = {
    total: 0,
    busy: 0,
    background: 0,
    waiting: 0,
    error: 0,
    compact: 0,
    expiring: 0,
  };
  for (const repo of repos)
    for (const f of repo.folders)
      for (const s of f.sessions) {
        if (!s.agentState) continue;
        r.total += 1;
        const alert = alertStatus(s);
        if (alert) r[alert] += 1;
        if (needsCompact(s.agentState?.details, now, compactThresholdPct)) r.compact += 1;
        if (isCacheExpiring(s.agentState?.details, now)) r.expiring += 1;
      }
  return r;
}

/** The buckets that tint a rollup or a collapsed row, loudest first. `background`
 * is not a status: a session working at its prompt has background agents out. */
export const ALERT_ORDER = ["error", "waiting", "busy", "background"] as const;

export type AlertStatus = (typeof ALERT_ORDER)[number];

const BACKGROUND_COLOR = "bg-busy-deep";

export function alertColor(alert: AlertStatus): string {
  return alert === "background" ? BACKGROUND_COLOR : statusColor(alert);
}

export function sessionBackgroundAgents(s: Pick<SessionData, "agentState">): number {
  return s.agentState?.details?.backgroundAgents ?? 0;
}

/** The backend's flags decide whether a session tints; its status only picks the color. */
function alertStatus(s: SessionData): AlertStatus | null {
  const st = s.agentState?.status;
  if (!st || !(s.working || s.needsReason != null)) return null;
  if (st === "error" || st === "waiting" || st === "busy") return st;
  return s.working ? "background" : null;
}

/** Same precedence as a collapsed rail row, so the two never disagree. */
export function rollupAlertColor(r: AgentRollup): string | null {
  const top = ALERT_ORDER.find((st) => r[st] > 0);
  if (top) return alertColor(top);
  return r.total > 0 ? "bg-ok" : null;
}

/** White reads fine on every fill but the busy one, where it's nearly illegible. */
export function rollupAlertTextColor(bg: string | null): string {
  return bg === "bg-busy" ? "text-busy-ink" : "text-white";
}

/** The live agentboard state, shared across the app from a single subscription. */

export const STATUS: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: "Idle", color: "bg-muted-foreground/40" },
  busy: { label: "Working", color: "bg-busy" },
  waiting: { label: "Waiting", color: "bg-waiting" },
  error: { label: "Error", color: "bg-danger" },
  complete: { label: "Done", color: "bg-ok" },
  interrupted: { label: "Paused", color: "bg-paused" },
};

export function statusColor(status: AgentStatus): string {
  return STATUS[status].color;
}

/** Ambient color for sessions hidden behind a collapse; emerald means live. */
export function collapsedLiveColor(sessions: SessionData[]): string | null {
  const live = sessions.filter((s) => s.live);
  if (live.length === 0) return null;
  const present = new Set(live.map(alertStatus));
  const top = ALERT_ORDER.find((st) => present.has(st));
  return top ? alertColor(top) : "bg-ok";
}
