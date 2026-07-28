import { useState } from "react";
import { X } from "lucide-react";
import { Dot, fmtMins, IconBtn } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import {
  fmtElapsed,
  fmtWaitingAge,
  isAgent,
  isCacheExpiring,
  isCold,
  modelContextLabel,
  type SessionActions,
  type SessionData,
} from "@/lib/agentboard";
import { cn } from "@/lib/utils";

/** Cache health for one pane, shown only while Claude is actually running in
 * it (a live agent for this session). Cache warmth only — no context percent —
 * so the pane chrome stays quiet: `⧗ 42m left` / `◔ 3m left` while warm
 * (amber once inside the warn window — nudge Claude before the cache lapses),
 * `❄ cache cold` once the prompt cache has expired. Nothing when no agent is
 * running here or the session never touched a cache. */
function PaneCacheInfo({ session, now }: { session: SessionData; now: number }) {
  const d = session.agentState?.details;
  // Gate on a live Claude in this pane: `agentState` is pruned when the pid
  // dies, so `isAgent && live` == "Claude running here right now".
  if (!session.live || !isAgent(session) || !d?.cacheExpiresAt) return null;
  const cold = isCold(d, now);
  const expiring = isCacheExpiring(d, now);
  return (
    <span
      title={
        cold
          ? "prompt cache expired"
          : expiring
            ? "prompt cache expires soon — any message re-warms it; a cold resume re-reads everything at full price"
            : "prompt cache warm — time left"
      }
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
  );
}

/** Blocks the terminal until the user deliberately acknowledges a cold prompt
 * cache: unlike the quiet ❄ in the pane header, a cold resume silently
 * re-reads the whole transcript at full price, so this earns a click rather
 * than a glance. The ❄ pulses to draw the eye across a busy multi-pane grid;
 * the card itself stays put so the buttons are always easy to hit. Re-arms on
 * the next cold generation (keyed by `cacheExpiresAt`, the same dedup key the
 * board-wide toast in `screens/agentboard.tsx` uses). */
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

/** One pane's chrome: glyph · dot · session name · shell kind · running time ·
 * waiting age · cache info · lifecycle buttons. The repo / folder / branch /
 * diff live once in the working-context band above (every pane in a window
 * shares that folder), so they're not repeated here — the pane header only
 * identifies *which session* this is and how it's doing, mirroring the same
 * badges the rail row shows (`fmtElapsed`, `fmtWaitingAge`) so the two
 * surfaces never disagree. */
export function PaneHeader({
  session,
  label,
  now,
  actions,
}: {
  session: SessionData;
  label: string;
  now: number;
  actions: SessionActions;
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
            <span
              className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70"
              title="running for"
            >
              {fmtElapsed(now - session.createdAt)}
            </span>
          )}
          {waitingAge && (
            <span
              className="shrink-0 font-mono text-[10.5px] text-amber-500/80"
              title="how long this has been needing you"
            >
              {waitingAge}
            </span>
          )}
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
