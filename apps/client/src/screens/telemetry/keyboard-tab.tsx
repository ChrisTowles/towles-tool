import { Card, Empty, StatTile } from "@/components/store-bits";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  TIER_LABELS,
  actionsToGoal,
  fmtShare,
  tierFor,
  type KeyboardDay,
  type KeyboardScore,
  type ShortcutSplit,
} from "@/lib/keyboard-score";
import { SHORTCUTS, shortcutKeys } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * Keyboard — the habit tab. Where Attention answers "where did the day go?",
 * this one answers "am I actually learning the shortcuts?", from the same
 * event log: every binding that fired (`shortcut.<id>`) against every click
 * that took a bound action's place (`mouse.<id>`).
 *
 * Deliberately *not* day-scoped like the tabs beside it — a habit is only
 * legible across days, so this reads the fixed 14-day window `tt-telemetry`'s
 * `keyboard_score` returns and ignores the screen's day picker. All the
 * arithmetic (share, goal, streak) happens in Rust; this file only paints it.
 *
 * The tone is a deliberate constraint. A streak, a ladder and a practice list
 * are enough to make the habit visible; badges, scores and losing-streak
 * warnings would turn a tool for getting into the zone into one more thing
 * demanding attention, which is the opposite of the point.
 */
export function KeyboardTab({ score, loading }: { score: KeyboardScore | null; loading: boolean }) {
  if (!score) {
    return (
      <Card title="Keyboard">
        <Empty inline>{loading ? "Reading the habit log…" : "No telemetry yet."}</Empty>
      </Card>
    );
  }

  const { today, days, streak, bestStreak } = score;
  const tier = tierFor(today.share);
  const remaining = actionsToGoal(today, score.goalShare, score.goalMinActions);
  const goalPercent = Math.round(score.goalShare * 100);
  const unused = unusedShortcuts(score);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Today"
          value={fmtShare(today.share)}
          detail={tier ? TIER_LABELS[tier] : "nothing bound yet"}
        />
        <StatTile
          label="Streak"
          value={streak === 0 ? "—" : `${streak}d`}
          detail={bestStreak > 0 ? `best ${bestStreak}d` : "no won day yet"}
        />
        <StatTile
          label="Last 14 days"
          value={fmtShare(score.windowShare)}
          detail={`${score.windowShortcut} keys · ${score.windowMouse} clicks`}
        />
        <StatTile
          label="Goal"
          value={`${goalPercent}%`}
          detail={`over ${score.goalMinActions}+ bound actions`}
        />
      </div>

      {remaining !== null && !today.idle && (
        <div className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs text-violet-700 dark:text-violet-300">
          {remaining} more keyboard {remaining === 1 ? "action" : "actions"} today clears the{" "}
          {goalPercent}% goal{streak > 0 && ` and extends the ${streak}-day streak`}.
        </div>
      )}

      <Card
        title="Streak"
        note={`${days.filter((d) => d.goalMet).length} of ${days.length} days won`}
      >
        <StreakStrip days={days} />
        <p className="mt-2.5 text-[11px] text-muted-foreground">
          A day is won at {goalPercent}% keyboard over {score.goalMinActions}+ actions that had a
          shortcut. Quiet days are skipped rather than breaking the streak, and today is forgiven
          until it ends.
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Practice these" note={`${score.topMissed.length}`}>
          {score.topMissed.length === 0 ? (
            <Empty inline>
              Nothing with a shortcut was clicked in the last 14 days — the habit is holding.
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {score.topMissed.map((s) => (
                <SplitRow key={s.id} split={s} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Never used" note={`${unused.length}`}>
          {unused.length === 0 ? (
            <Empty inline>Every registered shortcut has fired at least once. Nice.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {unused.map((id) => (
                <div key={id} className="flex items-baseline gap-2 text-xs">
                  <KbdGroup className="w-24 shrink-0 justify-start">
                    {shortcutKeys(id).map((cap) => (
                      <Kbd key={cap}>{cap}</Kbd>
                    ))}
                  </KbdGroup>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {SHORTCUTS[id].description}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Registry bindings with no keyboard use in the window, in registry order.
 * The overlay-hidden duplicates (mod+2…9, the bracket aliases) are left out —
 * they're the same action under another key, and listing them would read as
 * nine separate things left unlearned. */
function unusedShortcuts(score: KeyboardScore): string[] {
  const used = new Set(score.byShortcut.filter((s) => s.shortcut > 0).map((s) => s.id));
  return Object.values(SHORTCUTS)
    .filter((s) => !s.hideInHelp && !used.has(s.id))
    .map((s) => s.id);
}

/** One day per square, oldest left: won, lost, or too quiet to count. The
 * strip is the streak — a number alone can't show that last Tuesday was the
 * one that broke it. */
function StreakStrip({ days }: { days: KeyboardDay[] }) {
  return (
    <div className="flex items-end gap-1">
      {days.map((day) => (
        <Tooltip key={day.date}>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "h-8 flex-1 rounded-sm",
                day.idle
                  ? "bg-muted"
                  : day.goalMet
                    ? "bg-emerald-500/70"
                    : "bg-muted-foreground/30",
              )}
            />
          </TooltipTrigger>
          <TooltipContent className="flex flex-col gap-0.5">
            <span className="font-medium">
              {day.date} · {fmtShare(day.share)}
              {day.goalMet && " · won"}
            </span>
            <span className="text-muted-foreground">
              {day.idle
                ? "too quiet to score"
                : `${day.shortcut} by keyboard · ${day.mouse} by mouse`}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** One binding's keys, what it does, and how the duel went for it. */
function SplitRow({ split }: { split: ShortcutSplit }) {
  const shortcut = SHORTCUTS[split.id];
  const total = split.shortcut + split.mouse;
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <KbdGroup className="w-24 shrink-0 justify-start">
        {shortcut ? (
          shortcutKeys(split.id).map((cap) => <Kbd key={cap}>{cap}</Kbd>)
        ) : (
          // A binding that has since been renamed or removed still has records
          // in the log; show the raw id rather than dropping the history.
          <span className="font-mono text-muted-foreground">{split.id}</span>
        )}
      </KbdGroup>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {shortcut?.description ?? split.id}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
        <span className="text-muted-foreground">{split.shortcut}</span>
        <span className="text-muted-foreground/40">/</span>
        <span className={split.mouse > split.shortcut ? "text-amber-600 dark:text-amber-500" : ""}>
          {split.mouse}
        </span>
        <span className="w-10 text-right text-muted-foreground/70">
          {total > 0 ? fmtShare(split.shortcut / total) : "—"}
        </span>
      </span>
    </div>
  );
}
