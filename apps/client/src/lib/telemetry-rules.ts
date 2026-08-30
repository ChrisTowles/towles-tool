import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { telemetryRulesFailing, type RuleKind, type RuleScore } from "@/lib/telemetry";

/** Presentation logic for the Rules tab and its status-bar pill, kept out of the
 * components so the state ramp and number formats are unit-testable. */

/** `near` is within {@link NEAR_MARGIN} of the threshold on the passing side:
 * still green by the rule, but one bad day from red. A perfect score (100%,
 * or a count of 0) is passing however tight the threshold — there is no
 * closer to the edge it could have been. */
export type RuleState = "failing" | "near" | "passing" | "empty";

const NEAR_MARGIN = 5;

export function ruleState(
  score: Pick<RuleScore, "kind" | "threshold" | "today" | "failing">,
): RuleState {
  if (score.today === null) return "empty";
  if (score.failing) return "failing";
  const perfect = score.kind === "share" ? score.today >= 100 : score.today <= 0;
  if (perfect) return "passing";
  const margin =
    score.kind === "share" ? score.today - score.threshold : score.threshold - score.today;
  return margin < NEAR_MARGIN ? "near" : "passing";
}

/** `46%` / `100%` for a share, the plain count otherwise; `—` with no evidence. */
export function fmtRuleValue(kind: RuleKind, value: number | null): string {
  if (value === null) return "—";
  return kind === "share" ? `${Math.round(value)}%` : String(Math.round(value));
}

/** `threshold ≥ 95%` / `threshold ≤ 30`: the sign says which way failing lies. */
export function fmtThreshold(kind: RuleKind, threshold: number): string {
  return kind === "share" ? `threshold ≥ ${threshold}%` : `threshold ≤ ${threshold}`;
}

/** `Aug 19` from a `YYYY-MM-DD` day, local-independent since the day is UTC. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The card's one-line status under the number. */
export function ruleDetail(score: RuleScore): string {
  if (score.today === null) return "n = 0 — no data";
  const parts = [fmtThreshold(score.kind, score.threshold)];
  if (score.failingSince) parts.push(`failing since ${shortDay(score.failingSince)}`);
  else parts.push(`n = ${score.population}`);
  return parts.join(" · ");
}

/** The share's sparkline is 0–100; a count's runs to whatever is larger, the
 * worst day or the threshold, so the dashed line always fits in frame. */
export function sparklineMax(score: RuleScore): number {
  if (score.kind === "share") return 100;
  const worst = Math.max(0, ...score.series.map((d) => d.score ?? 0));
  return Math.max(1, worst, score.threshold);
}

/** Matches the keyboard habit beside it: today's file is re-parsed per call. */
const POLL_MS = 60_000;

export function useRulesFailing(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const tick = async () => {
      const r = await telemetryRulesFailing();
      if (cancelled || r.isErr()) return;
      setCount(r.value);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return count;
}
