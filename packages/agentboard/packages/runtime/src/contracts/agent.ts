export type AgentStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "waiting"
  | "question"
  | "interrupted";

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
