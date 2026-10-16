import { Hint } from "@/components/hint";
import {
  ctxPct,
  isCacheExpiring,
  isCold,
  modelContextLabel,
  modelLetter,
  needsCompact,
} from "@/lib/agentboard/context";
import type { SessionData } from "@/lib/agentboard/types";
import { cn } from "@/lib/utils";

/** Weight per model family. Never amber (needs-you), never animated. */
const MODEL_TONE: Record<string, string> = {
  O: "border-agent/50 bg-agent/10 text-agent",
  F: "border-transparent bg-gradient-to-br from-spark to-agent font-semibold text-white",
  M: "border-transparent bg-gradient-to-br from-spark to-agent font-semibold text-white",
};

/** Nothing when the family is unrecognized. */
export function ModelBadge({ session, className }: { session: SessionData; className?: string }) {
  const d = session.agentState?.details;
  const letter = modelLetter(d?.model);
  if (!session.live || !letter) return null;
  return (
    <Hint label={modelContextLabel(d) ?? undefined}>
      <span
        className={cn(
          "flex h-4 shrink-0 items-center rounded-md border px-1 font-mono text-micro font-medium",
          MODEL_TONE[letter] ?? "border-kumo-hairline bg-muted/30 text-kumo-subtle",
          className,
        )}
      >
        {letter}
      </span>
    </Hint>
  );
}

/** Quiet mono text: `41% ◔4m` while warm (⧗ for a 1h cache), `41% ❄` when cold,
 * and an ice-washed `❄ 63% compact` pill when cold at/over the threshold. */
export function CacheBadge({
  session,
  now,
  compactPct,
  onCompact,
  long = false,
}: {
  session: SessionData;
  now: number;
  compactPct: number;
  /** When set, the ❄ compact pill is clickable and runs /compact directly. */
  onCompact?: () => void;
  /** Long form spells out "compact"; the rail uses the short `❄ N%`. */
  long?: boolean;
}) {
  const d = session.agentState?.details;
  if (!session.live || !d?.contextUsed || !d.contextMax) return null;
  const pct = ctxPct(d);
  const cold = isCold(d, now);
  const what = modelContextLabel(d);
  const lead = what ? `${what} — ` : "";

  if (needsCompact(d, now, compactPct)) {
    // Pulses like the busy dot: a live nudge, not a passive fact.
    const pill =
      "shrink-0 animate-pulse rounded-md border border-info/50 bg-info/10 px-1.5 font-mono text-mini text-info";
    const hint = `${lead}${pct}% of context used and the prompt cache expired, so resuming re-reads everything.`;
    return onCompact ? (
      <Hint label={`${hint} Click to /compact.`}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCompact();
          }}
          className={cn(pill, "hover:bg-info/20")}
        >
          ❄ {pct}%{long && " compact"}
        </button>
      </Hint>
    ) : (
      <Hint label={`${hint} Consider /compact or a fresh session.`}>
        <span className={pill}>
          ❄ {pct}%{long && " compact"}
        </span>
      </Hint>
    );
  }

  const expiring = isCacheExpiring(d, now);
  const warmth = cold
    ? "❄"
    : `${d.cacheTtlMs === 3_600_000 ? "⧗" : "◔"}${fmtMins(d.cacheExpiresAt! - now)}`;
  return (
    <Hint
      label={
        cold
          ? `${lead}prompt cache expired`
          : expiring
            ? `${lead}prompt cache expires soon; any message re-warms it, a cold resume re-reads everything at full price`
            : `${lead}prompt cache warm, time left`
      }
    >
      <span
        className={cn(
          "shrink-0 font-mono text-mini",
          expiring ? "text-warn" : cold ? "font-medium text-info" : "text-kumo-subtle",
        )}
      >
        {/* Fixed 4ch slot: the percent is 1–3 digits, and without a reserved
            width the rail's meta columns never line up vertically. */}
        <span className="inline-block w-[4ch] text-right">{pct}%</span>{" "}
        <span className="inline-block min-w-[4ch]">{warmth}</span>
      </span>
    </Hint>
  );
}

/** Millis → whole minutes for the cache countdown, floored at 1 ("<1m" ≈ 1m). */
export function fmtMins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
