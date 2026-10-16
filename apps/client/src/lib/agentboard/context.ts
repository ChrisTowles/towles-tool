import { fmtTokens } from "@/lib/format";
import type { AgentEventDetails, SubagentInfo } from "./types";

/** Percent of the context window used (0 when unknown). */
export function ctxPct(d: AgentEventDetails | null | undefined): number {
  if (!d?.contextUsed || !d.contextMax) return 0;
  return Math.round((d.contextUsed / d.contextMax) * 100);
}

/** `412K / 1M`. Null without a window size — a bare used-count answers nothing. */
export function fmtContext(d: AgentEventDetails | null | undefined): string | null {
  if (!d?.contextMax) return null;
  if (!d.contextUsed) return `${fmtTokens(d.contextMax)} window`;
  return `${fmtTokens(d.contextUsed)} / ${fmtTokens(d.contextMax)}`;
}

/** `claude-opus-4-8 · 412K / 1M` — what a cold resume would cost. */
export function modelContextLabel(d: AgentEventDetails | null | undefined): string | null {
  const parts = [d?.model, fmtContext(d)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function modelLetter(model: string | null | undefined): string | null {
  if (!model) return null;
  const family = ["haiku", "sonnet", "opus", "fable", "mythos"].find((f) =>
    model
      .toLowerCase()
      .split(/[-_./:\s]/)
      .includes(f),
  );
  return family ? family[0].toUpperCase() : null;
}

/** A session is cache-cold when it never had cache activity or the TTL lapsed. */
export function isCold(d: AgentEventDetails | null | undefined, now: number): boolean {
  return !d?.cacheExpiresAt || now >= d.cacheExpiresAt;
}

/** Headroom to nudge the session — any request re-warms the cache — before a
 * resume goes full-price. */
export function cacheWarnMs(ttlMs: number | null | undefined): number {
  return ttlMs === 3_600_000 ? 600_000 : 120_000;
}

/** Still warm, but inside the warn window — one nudge away from going cold. */
export function isCacheExpiring(d: AgentEventDetails | null | undefined, now: number): boolean {
  if (!d?.cacheExpiresAt || isCold(d, now)) return false;
  return d.cacheExpiresAt - now <= cacheWarnMs(d.cacheTtlMs);
}

/** Named, not numeric, so a pane and its tooltip can't disagree about a percent. */
export type ContextBand = "calm" | "noted" | "half" | "heavy" | "critical";

const CONTEXT_BANDS: [number, ContextBand][] = [
  [80, "critical"],
  [60, "heavy"],
  [40, "half"],
  [20, "noted"],
];

export function contextBand(pct: number): ContextBand {
  return CONTEXT_BANDS.find(([floor]) => pct >= floor)?.[1] ?? "calm";
}

export const CONTEXT_BAND_ADVICE: Record<ContextBand, string> = {
  calm: "plenty of room",
  noted: "a fifth of the window is in play",
  half: "the window is filling — cheap to split the work now",
  heavy: "long sessions cost more every turn, cached or not",
  critical: "/compact mid-task, or /clear when switching to new work",
};

/** Its own context plus every sub-agent's — they run their own requests, which
 * the session's `contextUsed` never sees. */
export function sessionTotalTokens(d: AgentEventDetails | null | undefined): number {
  return (d?.contextUsed ?? 0) + (d?.subagentContextUsed ?? 0);
}

export function hasSubagentSpend(d: AgentEventDetails | null | undefined): boolean {
  return (d?.subagentCount ?? 0) > 0 && (d?.subagentContextUsed ?? 0) > 0;
}

/** Sub-agent meta is optional, hence the positional fallback. */
export function subagentLabel(s: SubagentInfo, index: number): string {
  return s.agentType?.trim() || s.description?.trim() || `sub ${index + 1}`;
}

/** Cold AND over threshold: warm-and-huge is fine, the cost bites on resume. */
export function needsCompact(
  d: AgentEventDetails | null | undefined,
  now: number,
  thresholdPct: number,
): boolean {
  return d != null && ctxPct(d) >= thresholdPct && isCold(d, now);
}
