import type { Usage } from "@anthropic-ai/sdk/resources/messages/messages";

type PartialUsage = Partial<Usage> & {
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
};

interface AssistantLikeEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: PartialUsage | null;
  };
}

export interface ClaudeUsageSummary {
  model: string;
  contextUsed: number;
  contextMax: number;
  cacheTtlMs: number | null;
  cacheExpiresAt: number | null;
  lastActivityAt: number;
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function contextMax(model: string): number {
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  return 200_000;
}

export function contextUsed(u: PartialUsage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

export function cacheTtlMs(u: PartialUsage): number | null {
  const c = u.cache_creation ?? null;
  const h = c?.ephemeral_1h_input_tokens ?? 0;
  const m = c?.ephemeral_5m_input_tokens ?? 0;
  const reads = u.cache_read_input_tokens ?? 0;
  if (h > 0) return ONE_HOUR_MS;
  if (m > 0 || reads > 0) return FIVE_MIN_MS;
  return null;
}

export function extractUsageSummary(entries: AssistantLikeEntry[]): ClaudeUsageSummary | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.message?.role !== "assistant") continue;
    const usage = e.message.usage;
    if (!usage) continue;

    const model = e.message.model ?? "";
    const ts = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isNaN(ts)) continue;

    const ttl = cacheTtlMs(usage);
    return {
      model,
      contextUsed: contextUsed(usage),
      contextMax: contextMax(model),
      cacheTtlMs: ttl,
      cacheExpiresAt: ttl === null ? null : ts + ttl,
      lastActivityAt: ts,
    };
  }
  return null;
}
