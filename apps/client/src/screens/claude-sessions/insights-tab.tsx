import { Result } from "effect";
import { useEffect, useRef, useState } from "react";
import {
  ChatsCircleIcon,
  CheckCircleIcon,
  CopyIcon,
  FireIcon,
  LightningIcon,
  RepeatIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  claudeSessionsInsights,
  type ClaudeSession,
  type ClaudeSessionInsight,
  type InsightKind,
} from "@/lib/claude-sessions";
import { PALETTE } from "@/lib/colors";
import { uiAction } from "@/lib/ui-action";
import { BreakdownDialog, SessionButtons } from "@/screens/claude-sessions/session-table";
import { ProjectName, reportSessionsError } from "@/screens/claude-sessions/shared";

const INSIGHT_META: Record<InsightKind, { label: string; icon: Icon; color: string }> = {
  tokenOutlier: { label: "Token outlier", icon: FireIcon, color: PALETTE[3] },
  rereadLoop: { label: "Re-read loop", icon: RepeatIcon, color: PALETTE[7] },
  cacheChurn: { label: "Cache churn", icon: LightningIcon, color: PALETTE[6] },
  marathon: { label: "Marathon session", icon: ChatsCircleIcon, color: PALETTE[0] },
};

/** Ranked waste findings — answer-first: each card names one session, one
 * number, and why it matters. Fetches only while this tab is active; a `days`
 * change elsewhere is picked up on the next activation. */
export function InsightsTab({
  days,
  nonce,
  active,
}: {
  days: string;
  nonce: number;
  active: boolean;
}) {
  const [insights, setInsights] = useState<ClaudeSessionInsight[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [breakdownFor, setBreakdownFor] = useState<ClaudeSession | null>(null);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${days}:${nonce}`;
    if (!active || fetchedKey.current === key) return;
    fetchedKey.current = key;
    setLoading(true);
    void claudeSessionsInsights(Number(days)).then((r) => {
      Result.match(r, {
        onSuccess: setInsights,
        onFailure: (e) => {
          setInsights(null);
          reportSessionsError(e);
        },
      });
      setLoading(false);
    });
  }, [active, days, nonce]);

  if (loading && !insights)
    return <p className="p-4 text-sm text-muted-foreground">Scanning for patterns…</p>;
  if (!insights) return null;
  if (insights.length === 0)
    return (
      <div className="flex items-center gap-2.5 p-4 text-sm text-muted-foreground">
        <CheckCircleIcon className="size-4 shrink-0 text-ok" />
        No waste patterns in this window — sessions look healthy.
      </div>
    );

  return (
    <div className="flex flex-col gap-3 p-4">
      {insights.map((insight, i) => {
        const meta = INSIGHT_META[insight.kind];
        const s = insight.session;
        const openBreakdown = () => {
          uiAction("claude_sessions.breakdown_open", "claude-sessions", "insight");
          setBreakdownFor(s);
        };
        return (
          <div
            key={`${insight.kind}-${s.sessionId}-${i}`}
            role="button"
            tabIndex={0}
            onClick={openBreakdown}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openBreakdown();
              }
            }}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3.5 text-left hover:bg-accent/50"
          >
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md"
              style={{ background: `${meta.color}26`, color: meta.color }}
            >
              <meta.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">{meta.label}</span>
                <span className="font-mono text-xs" style={{ color: meta.color }}>
                  {insight.metric}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-sm text-foreground">
                {s.title ?? s.sessionId.slice(0, 8)}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  <ProjectName name={s.project} /> · {s.date}
                </span>
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {insight.detail}
              </span>
            </span>
            <SessionButtons session={s} />
          </div>
        );
      })}
      <p className="text-mini text-muted-foreground">
        Click a finding for its turn/tool breakdown, or{" "}
        <CopyIcon className="inline size-3 align-[-2px]" /> to copy the session ID or file path.
      </p>
      <BreakdownDialog session={breakdownFor} onClose={() => setBreakdownFor(null)} />
    </div>
  );
}
