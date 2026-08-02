import { useState } from "react";
import { X } from "lucide-react";
import { Hint } from "@/components/hint";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Dot, fmtMins, IconBtn } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import {
  CONTEXT_BAND_ADVICE,
  contextBand,
  ctxPct,
  fmtContext,
  fmtElapsed,
  fmtTokens,
  fmtWaitingAge,
  hasSubagentSpend,
  isAgent,
  isCacheExpiring,
  isCold,
  modelContextLabel,
  sessionTotalTokens,
  subagentLabel,
  type ContextBand,
  type SessionActions,
  type SessionData,
} from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/** Warmth only, no context percent, and nothing at all unless Claude is running
 * here right now — `agentState` is pruned when the pid dies. */
function PaneCacheInfo({ session, now }: { session: SessionData; now: number }) {
  const d = session.agentState?.details;
  if (!session.live || !isAgent(session) || !d?.cacheExpiresAt) return null;
  const cold = isCold(d, now);
  const expiring = isCacheExpiring(d, now);
  return (
    <Hint
      label={
        cold
          ? "prompt cache expired"
          : expiring
            ? "prompt cache expires soon — any message re-warms it; a cold resume re-reads everything at full price"
            : "prompt cache warm — time left"
      }
    >
      <span
        className={cn(
          "shrink-0 font-mono text-[10.5px]",
          expiring
            ? "text-amber-500"
            : cold
              ? "font-medium text-sky-500"
              : "text-muted-foreground/70",
        )}
      >
        {cold
          ? "❄ cache cold"
          : `${d.cacheTtlMs === 3_600_000 ? "⧗" : "◔"} ${fmtMins(d.cacheExpiresAt - now)} left`}
      </span>
    </Hint>
  );
}

/** Sky is this app's cost hue (the ❄ compact nudge); amber and red are spoken
 * for by needs-you and error, so escalation here is weight, not a new color. */
const BAND_TEXT: Record<ContextBand, string> = {
  calm: "text-muted-foreground/60",
  noted: "text-muted-foreground/80",
  half: "text-foreground/80",
  heavy: "text-sky-500",
  critical: "font-medium text-sky-500",
};

const BAND_FILL: Record<ContextBand, string> = {
  calm: "bg-muted-foreground/40",
  noted: "bg-muted-foreground/60",
  half: "bg-foreground/60",
  heavy: "bg-sky-500/70",
  critical: "bg-sky-500",
};

/** How full the window is, escalating from a resting fact to a nudge. Nothing
 * unless Claude is running here — `agentState` is pruned when the pid dies. */
function PaneContextMeter({ session }: { session: SessionData }) {
  const d = session.agentState?.details;
  if (!session.live || !isAgent(session) || !d?.contextUsed || !d.contextMax) return null;
  const pct = ctxPct(d);
  const band = contextBand(pct);
  return (
    <Hint label={`${modelContextLabel(d)} — ${CONTEXT_BAND_ADVICE[band]}`}>
      <span
        className={cn("flex shrink-0 items-center gap-1 font-mono text-[10.5px]", BAND_TEXT[band])}
      >
        <span className="inline-block w-[4ch] text-right">{pct}%</span>
        <span className="h-1 w-8 overflow-hidden rounded-full bg-muted-foreground/20">
          <span
            className={cn("block h-full rounded-full", BAND_FILL[band])}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      </span>
    </Hint>
  );
}

/** Everything the session is spending, sub-agent threads included — each runs
 * its own requests, so the context meter above cannot see them. */
function PaneSubagentTotal({ session }: { session: SessionData }) {
  const d = session.agentState?.details;
  if (!session.live || !isAgent(session) || !hasSubagentSpend(d)) return null;
  const active = d!.subagents ?? [];
  const count = d!.subagentCount ?? 0;
  const finished = Math.max(0, count - active.length);
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <span className="shrink-0 cursor-default font-mono text-[10.5px] text-violet-500">
          Σ {fmtTokens(sessionTotalTokens(d))} (+{count})
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="end" className="w-64">
        <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
          This session and every sub-agent it spawned. Each sub-agent runs its own requests.
        </p>
        <ul className="flex flex-col gap-0.5 font-mono text-[10.5px]">
          <li className="flex justify-between gap-3">
            <span className="text-foreground">main</span>
            <span className="text-muted-foreground">{fmtContext(d)}</span>
          </li>
          {active.map((s, i) => (
            <li key={`${subagentLabel(s, i)}-${i}`} className="flex justify-between gap-3">
              <span className="truncate text-violet-500">{subagentLabel(s, i)}</span>
              <span className="text-muted-foreground">{fmtTokens(s.contextUsed ?? 0)}</span>
            </li>
          ))}
          {finished > 0 && (
            <li className="text-muted-foreground/70">
              +{finished} finished sub-agent{finished === 1 ? "" : "s"} in the total
            </li>
          )}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

/** A cold resume silently re-reads the whole transcript at full price, so this
 * earns a click rather than a glance. Re-arms per cold generation, keyed by
 * `cacheExpiresAt` — the board-wide toast dedups on the same key. */
export function ColdCacheOverlay({
  session,
  now,
  onCompact,
}: {
  session: SessionData;
  now: number;
  /** Sends `/compact` to the session in place of acknowledging. */
  onCompact: () => void;
}) {
  const d = session.agentState?.details;
  const [ackedFor, setAckedFor] = useState<number | null>(null);
  const cold = session.live && isAgent(session) && !!d?.cacheExpiresAt && isCold(d, now);
  if (!cold || ackedFor === d!.cacheExpiresAt) return null;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/90 p-4">
      <div className="flex max-w-64 flex-col items-center gap-3 rounded-lg border-2 border-sky-500 bg-card px-5 py-4 text-center shadow-lg">
        <span className="animate-pulse text-2xl text-sky-500">❄</span>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">prompt cache is cold</span>
          <span className="text-xs text-muted-foreground">
            resuming re-reads the full transcript at full price — any message re-warms it
          </span>
          {/* What that re-read would actually cost: which model, and how much
              context it would re-send — the two facts the compact-or-continue
              decision below turns on. */}
          {modelContextLabel(d) && (
            <span className="mt-0.5 font-mono text-[10.5px] text-muted-foreground/70">
              {modelContextLabel(d)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCompact}
            className="rounded-md border border-sky-500/50 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-500 hover:bg-sky-500/20"
          >
            /compact instead
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => setAckedFor(d!.cacheExpiresAt!)}
            className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            got it — continue
          </button>
        </div>
      </div>
    </div>
  );
}

/** Repo/folder/branch/diff live once in the working-context band above, so this
 * says only which session it is — via the rail row's own formatters. */
export function PaneHeader({
  session,
  label,
  now,
  actions,
  focused,
}: {
  session: SessionData;
  label: string;
  now: number;
  actions: SessionActions;
  /** Whether this is the tile the `ab-close-pane` binding would act on. Only
   * then does the ✕ name the chord — on any other pane the two aren't twins,
   * and both the tooltip and the habit score would be lying. */
  focused: boolean;
}) {
  const agent = isAgent(session) && session.live;
  const waitingAge = fmtWaitingAge(session.needsSinceMs, now);
  return (
    <PaneChrome
      lens={
        <>
          <PaneLens
            kind={isAgent(session) ? "agent" : "shell"}
            label={isAgent(session) ? undefined : (session.shellKind ?? undefined)}
          />
          <Dot session={session} />
        </>
      }
      subject={label}
      subjectTitle={label}
      actions={
        <>
          {session.live && (
            <Hint label="running for">
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                {fmtElapsed(now - session.createdAt)}
              </span>
            </Hint>
          )}
          {waitingAge && (
            <Hint label="how long this has been needing you">
              <span className="shrink-0 font-mono text-[10.5px] text-amber-500/80">
                {waitingAge}
              </span>
            </Hint>
          )}
          <PaneContextMeter session={session} />
          <PaneSubagentTotal session={session} />
          <PaneCacheInfo session={session} now={now} />
          {agent && (
            <IconBtn
              title="stop Claude (shell survives)"
              onClick={() => actions.stopClaude(session)}
              className="hover:text-red-500"
            >
              ■
            </IconBtn>
          )}
          <IconBtn
            title="close session (kills the PTY, drops the record)"
            shortcut={focused ? "ab-close-pane" : undefined}
            onClick={() => actions.close(session.id)}
            className="hover:text-red-500"
          >
            <X className="size-3" />
          </IconBtn>
        </>
      }
    />
  );
}
