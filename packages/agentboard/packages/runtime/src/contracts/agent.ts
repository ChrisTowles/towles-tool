export type AgentStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "waiting"
  | "question"
  | "interrupted";

/** State of a self-paced `/loop` — the session scheduled its own next wake-up via ScheduleWakeup. */
export interface LoopInfo {
  /** Epoch ms when the loop is scheduled to fire next. In the past once the loop has ended. */
  nextWakeAt: number;
  /** Short reason the session gave for the scheduled wake-up. */
  reason?: string;
}

/** A sub-agent spawned by the parent session — workflow fan-out or a background Task/Agent. */
export interface SubagentInfo {
  /** Sub-agent type, e.g. "Explore", "general-purpose", or a workflow agent label. */
  agentType?: string;
  /** Short human description of the sub-agent's task (from its meta.json). */
  description?: string;
}

export interface AgentEventDetails {
  /** Model name from most recent assistant turn (e.g. "claude-opus-4-6") */
  model?: string;
  /** Total tokens consumed in the most recent turn (input + output + cache) */
  contextUsed?: number;
  /** Inferred context window size for the model (200K or 1M) */
  contextMax?: number;
  /** Epoch ms when the prompt cache expires; undefined = no cache active */
  cacheExpiresAt?: number;
  /** Cache TTL type: 300_000 (5m) or 3_600_000 (1h) */
  cacheTtlMs?: number;
  /** Epoch ms of the most recent assistant entry in the journal */
  lastActivityAt?: number;
  /** Name of the most recent tool invoked by the agent (e.g. "Read", "Bash", "Edit"). Populated only by the claude-code watcher. */
  lastTool?: string;
  /**
   * Currently-active sub-agents (workflow fan-out / background Tasks), judged by recent
   * journal mtime. Empty/undefined when the session has no live sub-agents.
   * Populated only by the claude-code watcher.
   */
  subagents?: SubagentInfo[];
  /**
   * Set when the session is running a self-paced `/loop` (scheduled its next wake via
   * ScheduleWakeup). `nextWakeAt` in the future = sleeping between iterations.
   * Populated only by the claude-code watcher.
   */
  loop?: LoopInfo;
}

export interface AgentEvent {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadId?: string;
  threadName?: string;
  /** Set by tracker when serializing for the TUI — true if user hasn't seen this terminal state */
  unseen?: boolean;
  /** Set by pane scanner — the tmux pane ID where this agent was detected */
  paneId?: string;
  /** Optional per-agent live details. Currently populated only by the claude-code watcher. */
  details?: AgentEventDetails;
}

export const TERMINAL_STATUSES = new Set<AgentStatus>(["done", "error", "interrupted"]);
