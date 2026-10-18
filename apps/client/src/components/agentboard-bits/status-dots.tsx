import { CaretDownIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import {
  collapsedLiveColor,
  alertColor,
  sessionBackgroundAgents,
  statusColor,
  type AgentRollup,
  type AlertStatus,
} from "@/lib/agentboard/status";
import type { SessionData } from "@/lib/agentboard/types";
import { COLOR_FADE_CLASS } from "@/lib/motion-presets";
import { cn } from "@/lib/utils";

/** Open ring = pending on you, filled = something happened, so the states don't
 * lean on hue alone. The live two shout — waiting loudest, its halo the only
 * expanding one — off an unchanged `size-2` box, so volume never shifts a title. */
export function Dot({ session }: { session: SessionData }) {
  if (!session.live) {
    return (
      <Hint label="starting">
        <span className="size-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground/50 bg-transparent" />
      </Hint>
    );
  }
  const n = sessionBackgroundAgents(session);
  return (
    <>
      <StatusDot session={session} />
      {n > 0 && <BackgroundAgentsBadge n={n} />}
    </>
  );
}

function StatusDot({ session }: { session: SessionData }) {
  const st = session.agentState?.status;
  if (st === "waiting") {
    return (
      <Hint label="agent waiting — needs your input">
        <span className="relative block size-2 shrink-0 motion-safe:animate-in motion-safe:fade-in-0 duration-200">
          <span className="absolute inset-0 -m-1 animate-ping rounded-full bg-waiting/40 motion-reduce:animate-none" />
          <span className="absolute inset-0 -m-0.5 rounded-full border-2 border-waiting bg-waiting/30 ring-2 ring-waiting/25" />
        </span>
      </Hint>
    );
  }
  if (st === "busy") {
    return (
      <Hint label="agent busy">
        <span className="relative block size-2 shrink-0 motion-safe:animate-in motion-safe:fade-in-0 duration-200">
          <span className="absolute inset-0 -m-0.5 animate-pulse rounded-full bg-busy ring-3 ring-busy/30 motion-reduce:animate-none" />
        </span>
      </Hint>
    );
  }
  return (
    <Hint label={st ? `agent ${st}` : "shell running, no agent"}>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          COLOR_FADE_CLASS,
          st ? statusColor(st) : "bg-muted-foreground/40",
        )}
      />
    </Hint>
  );
}

/** A fact, so bare mono type and no box; the same tiny dot + count the rollup uses. */
function BackgroundAgentsBadge({ n }: { n: number }) {
  return (
    <Hint label={`${n} background agent${n > 1 ? "s" : ""} still running — not waiting on you`}>
      <span className="flex shrink-0 items-center gap-0.5 font-mono text-micro leading-none tabular-nums text-kumo-subtle">
        <span className={cn("size-1.5 rounded-full", COLOR_FADE_CLASS, alertColor("background"))} />
        {n}
      </span>
    </Hint>
  );
}

/** Shape and color derive from `Dot`, so the buckets can't drift from it. No
 * `n` is a bare dot, for a count something beside it already says. */
function DotCount({ status, n }: { status: AlertStatus; n?: number }) {
  return (
    <span className="flex items-center gap-1 tabular-nums text-kumo-subtle">
      <span
        className={cn(
          "size-1.5 rounded-full",
          COLOR_FADE_CLASS,
          status === "waiting"
            ? "border-[1.5px] border-waiting bg-transparent"
            : alertColor(status),
        )}
      />
      {n}
    </span>
  );
}

const ROLLUP_STATUSES = ["busy", "background", "waiting", "error"] as const;

/** A rollup's per-status counts, in the order both the rail and sidebar show.
 * `bare` drops the number when one status holds every agent, so a total shown
 * beside it isn't said twice. */
export function RollupDots({ r, bare = false }: { r: AgentRollup; bare?: boolean }) {
  const shown = ROLLUP_STATUSES.filter((status) => r[status] > 0);
  const whole = bare && shown.length === 1 && r[shown[0]] === r.total;
  return shown.map((status) => (
    <DotCount key={status} status={status} n={whole ? undefined : r[status]} />
  ));
}

/** So a collapsed header with running sessions inside doesn't look asleep. */
export function CollapsedLive({ sessions }: { sessions: SessionData[] }) {
  const color = collapsedLiveColor(sessions);
  if (!color) return null;
  const n = sessions.filter((s) => s.live).length;
  return (
    <Hint label={`${n} running session${n > 1 ? "s" : ""} hidden — expand to see`}>
      <span className="flex shrink-0 items-center gap-1">
        <span className={cn("size-2 rounded-full", COLOR_FADE_CLASS, color)} />
        <span className="font-mono text-micro tabular-nums text-kumo-subtle">{n}</span>
      </span>
    </Hint>
  );
}

export function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <CaretDownIcon
      className={cn(
        "size-3.5 shrink-0 text-kumo-subtle transition-transform",
        collapsed && "-rotate-90",
      )}
    />
  );
}
