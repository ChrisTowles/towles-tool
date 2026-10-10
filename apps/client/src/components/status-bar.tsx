import { useEffect, useState } from "react";
import { FireIcon, KeyboardIcon, ShieldWarningIcon, StethoscopeIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { isTauri } from "@/lib/tauri";
import { claudeUsageLimits, type UsageLimitBar, type UsageLimits } from "@/lib/claude-sessions";
import {
  collectorHealth,
  COLLECTOR_STATE_DOT,
  COLLECTOR_STATE_LABEL,
  type CollectorHealth,
} from "@/lib/collector-health";
import {
  TIER_LABELS,
  actionsToGoal,
  fmtShare,
  tierFor,
  useKeyboardScore,
  type KeyboardScore,
} from "@/lib/keyboard-score";
import { useRulesFailing } from "@/lib/telemetry-rules";
import { fmtAge, fmtCountdown, useStoreSnapshot } from "@/lib/data";
import { useNow } from "@/lib/now";
import { taskExplorerSnapshot } from "@/lib/task-explorer";
import { cn } from "@/lib/utils";
import { useAppVersion } from "@/lib/version";
import { useWorkspace } from "@/lib/workspace";
import { uiAction } from "@/lib/ui-action";

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

/** Read from the CLI's cached `~/.claude.json`, never a live call. The cache
 * only refreshes when the CLI makes a real API request, so a shorter poll would
 * see nothing fresher. */
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

/** Same severity ramp as {@link COLLECTOR_STATE_DOT}. */
function limitFillColor(percent: number): string {
  if (percent >= 90) return "bg-red-500 dark:bg-red-400";
  if (percent >= 70) return "bg-amber-500/80 dark:bg-amber-400/80";
  return "bg-kumo-contrast/50";
}

function LimitBar({ bar }: { bar: UsageLimitBar }) {
  const pct = Math.min(100, Math.max(0, bar.percent));
  const resetMs = bar.resetsAt ? new Date(bar.resetsAt).getTime() - Date.now() : null;
  return (
    <Tooltip
      content={
        <>
          {bar.label}: {Math.round(bar.percent)}%
          {resetMs !== null && resetMs > 0 ? ` · resets in ${fmtCountdown(resetMs)}` : ""}
        </>
      }
      render={<div className="flex items-center gap-1" />}
    >
      <span>{shortLimitLabel(bar.label)}</span>
      <div className="h-1.5 w-6 overflow-hidden rounded-full bg-kumo-fill">
        <div
          className={cn("h-full rounded-full", limitFillColor(bar.percent))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Tooltip>
  );
}

/** Sums `task_explorer_snapshot`'s groups rather than calling
 * `app_resource_usage`, so this number always agrees with the Task Explorer
 * screen's own total. */
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

function CollectorHealthDot({ health, now }: { health: CollectorHealth; now: number }) {
  const { label, state, run } = health;
  return (
    <Tooltip
      content={
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {label} · {COLLECTOR_STATE_LABEL[state]}
          </span>
          {run ? (
            <span className="text-kumo-subtle">
              {run.ok ? "ran" : "failed"} {fmtAge(run.ranAt, now)}
              {run.message ? ` · ${run.message}` : ""}
            </span>
          ) : (
            <span className="text-kumo-subtle">no run recorded yet</span>
          )}
        </div>
      }
      render={
        <span
          className={cn("size-1.5 rounded-full", COLLECTOR_STATE_DOT[state])}
          aria-label={`${label}: ${COLLECTOR_STATE_LABEL[state]}`}
        />
      }
    />
  );
}

/** Always on, so a focused user sees `gh` auth expiring before PRs quietly go
 * missing. Classification lives in the pure {@link collectorHealth}. */
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

/** Deliberately the smallest possible readout, coaching detail kept in the
 * tooltip: a habit gauge that competes for attention defeats the app's point. */
function KeyboardHabit({ score }: { score: KeyboardScore }) {
  const { openTab, activeTab } = useWorkspace();
  const { today, streak } = score;
  const tier = tierFor(today.share);
  const remaining = actionsToGoal(today, score.goalShare, score.goalMinActions);
  const missed = score.topMissed[0];

  return (
    <Tooltip
      content={
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {tier ? TIER_LABELS[tier] : "No shortcut-bound actions yet today"}
            {today.goalMet && " · goal met"}
          </span>
          <span className="text-kumo-subtle">
            {today.shortcut} by keyboard · {today.mouse} by mouse
          </span>
          <span className="text-kumo-subtle">
            {streak > 0 ? `${streak}-day streak` : "No streak yet"} · best {score.bestStreak} · goal{" "}
            {Math.round(score.goalShare * 100)}% over {score.goalMinActions}+ actions
          </span>
          {remaining !== null && (
            <span className="text-kumo-subtle">
              {remaining} more keyboard {remaining === 1 ? "action" : "actions"} wins today
            </span>
          )}
          {missed && (
            <span className="text-kumo-subtle">
              Most clicked past its shortcut: {missed.id} ({missed.mouse}×)
            </span>
          )}
        </div>
      }
      render={
        <button
          className="flex items-center gap-1 tabular-nums hover:text-kumo-default"
          aria-label="Keyboard shortcut habit"
          onClick={() => {
            uiAction("status_bar.open_telemetry", activeTab, "keyboard");
            openTab("telemetry");
          }}
        />
      }
    >
      <KeyboardIcon className="size-3.5" />
      <span className={today.goalMet ? "text-emerald-600 dark:text-emerald-500" : undefined}>
        {fmtShare(today.share)}
      </span>
      {streak > 0 && (
        <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-500">
          <FireIcon className="size-3" />
          {streak}
        </span>
      )}
    </Tooltip>
  );
}

/** Sky on purpose, never amber or red: the bar is chrome, and a failing rule is
 * a fact to read on the Rules tab, not an alarm to react to here. Hidden at
 * zero — a pill saying "0" is noise. */
function RulesFailing({ count }: { count: number }) {
  const { openTab, activeTab } = useWorkspace();
  if (count === 0) return null;
  return (
    <Tooltip
      content={`${count} telemetry ${count === 1 ? "rule" : "rules"} failing today`}
      render={
        <button
          className="flex items-center gap-1 tabular-nums hover:text-kumo-default"
          aria-label="Telemetry rules failing"
          onClick={() => {
            uiAction("status_bar.open_telemetry", activeTab, "rules");
            openTab("telemetry");
          }}
        />
      }
    >
      <ShieldWarningIcon className="size-3.5" />
      <span className="rounded-full bg-sky-500/15 px-1.5 font-mono text-[11px] text-sky-700 dark:text-sky-300">
        {count}
      </span>
    </Tooltip>
  );
}

export function StatusBar() {
  const { openTab, activeTab } = useWorkspace();
  const usage = useResourceUsage();
  const claudeLimits = useClaudeUsageLimits();
  const keyboard = useKeyboardScore();
  const rulesFailing = useRulesFailing();
  const version = useAppVersion();

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-kumo-hairline px-3 text-xs text-kumo-subtle">
      <button
        className="flex items-center gap-1.5 hover:text-kumo-default"
        onClick={() => {
          uiAction("status_bar.open_doctor", activeTab);
          openTab("doctor");
        }}
      >
        <StethoscopeIcon className="size-3.5" />
        Doctor
      </button>
      <div className="flex items-center gap-3">
        <CollectorHealthCluster />
        {keyboard && <KeyboardHabit score={keyboard} />}
        {rulesFailing !== null && <RulesFailing count={rulesFailing} />}
        {claudeLimits && claudeLimits.bars.length > 0 && (
          <div className="flex items-center gap-2.5 tabular-nums">
            {claudeLimits.bars.map((b) => (
              <LimitBar key={b.label} bar={b} />
            ))}
          </div>
        )}
        {usage && (
          <button
            className="tabular-nums hover:text-kumo-default"
            title="Total CPU / memory — this app plus every open terminal"
            onClick={() => {
              uiAction("status_bar.open_task_explorer", activeTab);
              openTab("task-explorer");
            }}
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
