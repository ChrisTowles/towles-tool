import { useEffect, useState } from "react";
import { Flame, Keyboard, Stethoscope } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isTauri } from "@/lib/tauri";
import { claudeUsageLimits, type UsageLimitBar, type UsageLimits } from "@/lib/claude-sessions";
import { collectorHealth, type CollectorHealth, type CollectorState } from "@/lib/collector-health";
import {
  TIER_LABELS,
  actionsToGoal,
  fmtShare,
  tierFor,
  useKeyboardScore,
  type KeyboardScore,
} from "@/lib/keyboard-score";
import { fmtAge, fmtCountdown, useStoreSnapshot } from "@/lib/data";
import { useNow } from "@/lib/now";
import { taskExplorerSnapshot } from "@/lib/task-explorer";
import { cn } from "@/lib/utils";
import { useAppVersion } from "@/lib/version";
import { useWorkspace } from "@/lib/workspace";

type ResourceUsage = { cpuPercent: number; memoryBytes: number };

const USAGE_POLL_MS = 5000;
const CLAUDE_USAGE_POLL_MS = 5 * 60_000;

export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** `"Session"` → `"5h"`, `"Week (all models)"` → `"Week"`, `"Week (Fable)"` → `"Fable"`. */
function shortLimitLabel(label: string): string {
  if (label === "Session") return "5h";
  if (label === "Week (all models)") return "Week";
  const scoped = /^Week \((.+)\)$/.exec(label);
  return scoped ? scoped[1] : label;
}

/**
 * Claude Code's own 5h-session / weekly / model-scoped rate-limit
 * percentages, read from the CLI's cached `~/.claude.json` snapshot (via
 * `tt-claude-sessions`) — never a live call. The CLI only refreshes this
 * cache when it makes a real API request, so a shorter poll wouldn't see
 * fresher data; this just picks up that refresh promptly.
 */
function useClaudeUsageLimits(): UsageLimits | null {
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const tick = async () => {
      const t = await claudeUsageLimits();
      if (!cancelled && t.isOk()) setLimits(t.value);
    };
    tick();
    const id = window.setInterval(tick, CLAUDE_USAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return limits;
}

/** Fill color by how close a limit is to capping out — same severity ramp as
 * {@link STATE_DOT} below. */
function limitFillColor(percent: number): string {
  if (percent >= 90) return "bg-red-500 dark:bg-red-400";
  if (percent >= 70) return "bg-amber-500/80 dark:bg-amber-400/80";
  return "bg-foreground/50";
}

/** One rate-limit bar: short label + a mini progress track, exact percent and
 * reset countdown in the tooltip. */
function LimitBar({ bar }: { bar: UsageLimitBar }) {
  const pct = Math.min(100, Math.max(0, bar.percent));
  const resetMs = bar.resetsAt ? new Date(bar.resetsAt).getTime() - Date.now() : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1">
          <span>{shortLimitLabel(bar.label)}</span>
          <div className="h-1.5 w-6 overflow-hidden rounded-full bg-muted-foreground/20">
            <div
              className={cn("h-full rounded-full", limitFillColor(bar.percent))}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {bar.label}: {Math.round(bar.percent)}%
        {resetMs !== null && resetMs > 0 ? ` · resets in ${fmtCountdown(resetMs)}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Passive CPU/RAM readout across everything this app is running — its own
 * process plus every embedded terminal's shell and descendants (#78, widened
 * once the Task Explorer screen made the full breakdown available). Polls
 * the Rust sampler on an interval; renders nothing in browser dev or until
 * the first sample lands. Sums `task_explorer_snapshot`'s groups rather than
 * calling `app_resource_usage` directly, so the status bar's number always
 * agrees with the Task Explorer screen's own total.
 */
function useResourceUsage(): ResourceUsage | null {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const tick = async () => {
      const r = await taskExplorerSnapshot();
      if (cancelled || r.isErr()) return;
      const cpuPercent = r.value.reduce((n, g) => n + g.totalCpuPercent, 0);
      const memoryBytes = r.value.reduce((n, g) => n + g.totalMemoryBytes, 0);
      setUsage({ cpuPercent, memoryBytes });
    };
    tick();
    const id = window.setInterval(tick, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return usage;
}

/** Dot color per health state — subtle fills paired with dark: variants. */
const STATE_DOT: Record<CollectorState, string> = {
  fresh: "bg-green-500/70 dark:bg-green-400/70",
  stale: "bg-amber-500/80 dark:bg-amber-400/80",
  failing: "bg-red-500 dark:bg-red-400",
  "never-ran": "bg-muted-foreground/30 dark:bg-muted-foreground/30",
};

const STATE_WORD: Record<CollectorState, string> = {
  fresh: "up to date",
  stale: "stale",
  failing: "failing",
  "never-ran": "never ran",
};

/** One muted dot per collector with a health tooltip (name, age, ok/fail). */
function CollectorHealthDot({ health, now }: { health: CollectorHealth; now: number }) {
  const { label, state, run } = health;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("size-1.5 rounded-full", STATE_DOT[state])}
          aria-label={`${label}: ${STATE_WORD[state]}`}
        />
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span className="font-medium">
          {label} · {STATE_WORD[state]}
        </span>
        {run ? (
          <span className="text-muted-foreground">
            {run.ok ? "ran" : "failed"} {fmtAge(run.ranAt, now)}
            {run.message ? ` · ${run.message}` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">no run recorded yet</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Always-on collector health: a compact cluster of dots so a focused user sees
 * `gh` auth expiring (a red dot) before PRs quietly go missing. Classification
 * lives in the pure {@link collectorHealth}; this only paints it.
 */
function CollectorHealthCluster() {
  const { snapshot } = useStoreSnapshot();
  const now = useNow();
  const health = collectorHealth(snapshot.runs, now);
  return (
    <div className="flex items-center gap-1" title="Collector health">
      {health.map((h) => (
        <CollectorHealthDot key={h.key} health={h} now={now} />
      ))}
    </div>
  );
}

/**
 * The keyboard-shortcut habit, always in the corner of the eye: today's
 * keyboard share of the actions that *have* a shortcut, and the streak of days
 * that cleared the goal. Deliberately the smallest possible readout — a
 * percentage and a flame — with the coaching detail (what the goal is, how
 * close today is, which binding the pointer keeps winning) in the tooltip,
 * because a habit gauge that competes for attention defeats the app's whole
 * point. Numbers come from the event log via {@link useKeyboardScore}; opens
 * the Telemetry screen, whose Attention tab holds the full breakdown.
 */
function KeyboardHabit({ score }: { score: KeyboardScore }) {
  const { openTab } = useWorkspace();
  const { today, streak } = score;
  const tier = tierFor(today.share);
  const remaining = actionsToGoal(today, score.goalShare, score.goalMinActions);
  const missed = score.topMissed[0];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="flex items-center gap-1 tabular-nums hover:text-foreground"
          aria-label="Keyboard shortcut habit"
          onClick={() => openTab("telemetry")}
        >
          <Keyboard className="size-3.5" />
          <span className={today.goalMet ? "text-emerald-600 dark:text-emerald-500" : undefined}>
            {fmtShare(today.share)}
          </span>
          {streak > 0 && (
            <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-500">
              <Flame className="size-3" />
              {streak}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span className="font-medium">
          {tier ? TIER_LABELS[tier] : "No shortcut-bound actions yet today"}
          {today.goalMet && " · goal met"}
        </span>
        <span className="text-muted-foreground">
          {today.shortcut} by keyboard · {today.mouse} by mouse
        </span>
        <span className="text-muted-foreground">
          {streak > 0 ? `${streak}-day streak` : "No streak yet"} · best {score.bestStreak} · goal{" "}
          {Math.round(score.goalShare * 100)}% over {score.goalMinActions}+ actions
        </span>
        {remaining !== null && (
          <span className="text-muted-foreground">
            {remaining} more keyboard {remaining === 1 ? "action" : "actions"} wins today
          </span>
        )}
        {missed && (
          <span className="text-muted-foreground">
            Most clicked past its shortcut: {missed.id} ({missed.mouse}×)
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatusBar() {
  const { openTab } = useWorkspace();
  const usage = useResourceUsage();
  const claudeLimits = useClaudeUsageLimits();
  const keyboard = useKeyboardScore();
  const version = useAppVersion();

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t px-3 text-xs text-muted-foreground">
      <button
        className="flex items-center gap-1.5 hover:text-foreground"
        onClick={() => openTab("doctor")}
      >
        <Stethoscope className="size-3.5" />
        Doctor
      </button>
      <div className="flex items-center gap-3">
        <CollectorHealthCluster />
        {keyboard && <KeyboardHabit score={keyboard} />}
        {claudeLimits && claudeLimits.bars.length > 0 && (
          <div className="flex items-center gap-2.5 tabular-nums">
            {claudeLimits.bars.map((b) => (
              <LimitBar key={b.label} bar={b} />
            ))}
          </div>
        )}
        {usage && (
          <button
            className="tabular-nums hover:text-foreground"
            title="Total CPU / memory — this app plus every open terminal"
            onClick={() => openTab("task-explorer")}
          >
            {usage.cpuPercent.toFixed(0)}% CPU · {formatMemory(usage.memoryBytes)}
          </button>
        )}
        <span className={isTauri() ? undefined : "font-medium text-amber-600 dark:text-amber-500"}>
          {isTauri() ? "Tauri shell" : "browser"}
        </span>
        <span>{version}</span>
      </div>
    </footer>
  );
}
