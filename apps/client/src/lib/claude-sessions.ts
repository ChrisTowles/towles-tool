import { invoke } from "@/lib/tauri";

/** Client-side bridge to the Claude Sessions screen (`tt-claude-sessions`). The
 * backend caches the scan, so search stays in-memory. Every `costUsd` is an
 * estimate priced per model. */

export type ProjectBar = {
  project: string;
  totalTokens: number;
  costUsd: number;
};

export type ModelBar = {
  model: string;
  totalTokens: number;
  costUsd: number;
};

export type LedgerDay = {
  date: string;
  projects: ProjectBar[];
  costUsd: number;
};

export type LedgerTotals = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

export type ClaudeSession = {
  sessionId: string;
  path: string;
  title: string | null;
  project: string;
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Real launch directory; null for transcripts that predate the field. */
  cwd: string | null;
  /** Prompt-text context; only present on search hits. */
  snippet?: string;
};

export type ClaudeSessionsSummary = {
  totals: LedgerTotals;
  days: LedgerDay[];
  byProject: ProjectBar[];
  byModel: ModelBar[];
  topSessions: ClaudeSession[];
};

export const claudeSessionsSummary = (days: number) =>
  invoke<ClaudeSessionsSummary>("claude_sessions_summary", { days });

export type UsageLimitBar = {
  /** `"Session"`, `"Week (all models)"`, `"Week (Fable)"`, etc. */
  label: string;
  percent: number;
  resetsAt: string | null;
  isActive: boolean;
};

export type UsageLimits = {
  fetchedAtMs: number;
  bars: UsageLimitBar[];
};

/** The CLI's own cached rate-limit percentages from `~/.claude.json` — no live
 * call, and `null` until the CLI populates the cache. */
export const claudeUsageLimits = () => invoke<UsageLimits | null>("claude_usage_limits");

export const claudeSessionsSearch = (days: number, query: string) =>
  invoke<ClaudeSession[]>("claude_sessions_search", { days, query });

export type InsightKind = "tokenOutlier" | "rereadLoop" | "cacheChurn" | "marathon";

/** One ranked waste finding with its session attached. */
export type ClaudeSessionInsight = {
  kind: InsightKind;
  /** Headline number, e.g. "6.2× median" or "38 re-reads". */
  metric: string;
  detail: string;
  session: ClaudeSession;
};

export const claudeSessionsInsights = (days: number) =>
  invoke<ClaudeSessionInsight[]>("claude_sessions_insights", { days });

export type ToolTotal = {
  name: string;
  /** Call count as "Nx". */
  detail?: string;
  inputTokens: number;
  outputTokens: number;
};

export type TurnBreakdown = {
  name: string;
  inputTokens: number;
  outputTokens: number;
  /** Dominant tool for color-coding; null for user prompts. */
  toolName: string | null;
  model: string;
};

export type SessionBreakdown = {
  /** Tools ranked by attributed tokens. */
  tools: ToolTotal[];
  /** Session steps in transcript order. */
  turns: TurnBreakdown[];
};

/** Parses that session on demand, rather than riding the cached scan. */
export const claudeSessionsBreakdown = (sessionId: string) =>
  invoke<SessionBreakdown>("claude_sessions_breakdown", { sessionId });

export type DayBucket = {
  /** `YYYY-MM-DD`, local. */
  date: string;
  count: number;
};

export type DayHourCell = {
  date: string;
  /** Local hour of day, 0-23. */
  hour: number;
  count: number;
};

export type CadenceSummary = {
  /** Ascending by date; only days with at least one prompt. */
  byDay: DayBucket[];
  /** Nonzero cells only, sorted by date then hour. */
  byDayHour: DayHourCell[];
  totalPrompts: number;
};

export const claudeSessionsCadence = (days: number) =>
  invoke<CadenceSummary>("claude_sessions_cadence", { days });
