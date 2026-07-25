import { useMemo } from "react";
import { CircleAlert } from "lucide-react";
import { BarRow, Card, Empty, maxCount, StatTile } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { fmtDuration, focusShare, type AttentionSummary, type FocusSession } from "@/lib/telemetry";

/**
 * Attention — the Telemetry screen's derived view, over the same day the Log
 * tab browses raw. Where the other tabs answer "what did the app record?",
 * this one answers "where did the day go?": how long the window actually held
 * focus, in how many unbroken stretches, what was clicked and on which
 * screens, how often the app interrupted, and how much of the elapsed time
 * was spent waiting on subprocesses.
 *
 * Every number here is computed in Rust (`crates/tt-telemetry/src/
 * attention.rs`) and arrives as one small `AttentionSummary`, so this file is
 * presentation only — no aggregation, no second definition of what a focus
 * session is. Read that module for the two counting rules that surprise
 * people (event identity comes from `message`, not `name`; hour buckets are
 * local while the day file is UTC).
 */

/** A day with fewer than this many focus stretches has no fragmentation story
 * worth telling — one or two short glances is just a quiet day, not thrash. */
const FRAGMENT_CALLOUT_MIN_SESSIONS = 4;

/** Fragmented share of the day's stretches at or above which the callout
 * fires. Half the day's focus being glances is the point where "you kept
 * bouncing off this app" is a real observation rather than noise. */
const FRAGMENT_CALLOUT_RATIO = 0.5;

export function AttentionTab({
  summary,
  loading,
}: {
  summary: AttentionSummary | null;
  loading: boolean;
}) {
  if (!summary) {
    return (
      <Card title="Attention">
        <Empty inline>{loading ? "Reading the day's log…" : "No telemetry for this day."}</Empty>
      </Card>
    );
  }

  if (summary.recordCount === 0) {
    return (
      <Card title="Attention">
        <Empty inline>Nothing was recorded on {summary.date}.</Empty>
      </Card>
    );
  }

  const share = focusShare(summary);
  const { focus, actions, notifications, machine } = summary;
  const fragmented =
    focus.sessionCount >= FRAGMENT_CALLOUT_MIN_SESSIONS &&
    focus.fragmentCount / focus.sessionCount >= FRAGMENT_CALLOUT_RATIO;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Focused"
          value={fmtDuration(focus.focusedMs)}
          detail={share === null ? undefined : `${share}% of ${fmtDuration(summary.elapsedMs)} up`}
        />
        <StatTile
          label="Longest stretch"
          value={fmtDuration(focus.longestMs)}
          detail={`${focus.sessionCount} ${focus.sessionCount === 1 ? "stretch" : "stretches"}`}
        />
        <StatTile
          label="Gestures"
          value={String(actions.total)}
          detail={`${actions.screenSwitches} screen switches`}
        />
        <StatTile
          label="Interruptions"
          value={String(notifications.fired)}
          detail={
            notifications.skipped > 0
              ? `${notifications.skipped} suppressed`
              : "notifications fired"
          }
        />
      </div>

      {fragmented && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {focus.fragmentCount} of {focus.sessionCount} focus stretches were under two minutes —
            the day was mostly glances at this app rather than time spent in it.
          </span>
        </div>
      )}

      <Card
        title="Day rhythm"
        note={
          summary.firstTs && summary.lastTs
            ? `${timeOf(summary.firstTs)} – ${timeOf(summary.lastTs)}`
            : undefined
        }
      >
        <HourChart hours={summary.hours} />
      </Card>

      <Card title="Focus stretches" note={`${focus.sessions.length}`}>
        {focus.sessions.length === 0 ? (
          <Empty inline>
            The window never gained OS focus this day — this checkout's app ran without ever being
            looked at, or the log predates focus tracking.
          </Empty>
        ) : (
          <>
            <FocusTimeline sessions={focus.sessions} />
            <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <Figure label="Departures" value={String(focus.departures)} />
              <Figure label="Under 2 min" value={String(focus.fragmentCount)} />
              <Figure label="Median stretch" value={fmtDuration(medianDuration(focus.sessions))} />
            </div>
          </>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Attention by screen" note={`${actions.byScreen.length}`}>
          {actions.byScreen.length === 0 ? (
            <Empty inline>No gestures recorded.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {actions.byScreen.map((r) => (
                <BarRow
                  key={r.key}
                  label={r.key}
                  count={r.count}
                  max={maxCount(actions.byScreen)}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title="Most-used actions" note={`${actions.byAction.length}`}>
          {actions.byAction.length === 0 ? (
            <Empty inline>No gestures recorded.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {actions.byAction.map((r) => (
                <BarRow
                  key={r.key}
                  label={r.key}
                  count={r.count}
                  max={maxCount(actions.byAction)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Waiting on the machine"
        note={`${machine.spawnCount} spawns · ${fmtDuration(machine.totalMs)}`}
      >
        {machine.byExecutable.length === 0 ? (
          <Empty inline>No subprocesses ran this day.</Empty>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {machine.byExecutable.map((e) => (
                <MeterRow
                  key={e.name}
                  label={e.name}
                  value={e.totalMs}
                  max={machine.byExecutable[0]?.totalMs ?? 1}
                  right={`${fmtDuration(e.totalMs)} · ${e.count}×`}
                />
              ))}
            </div>
            <p className="mt-2.5 text-[11px] text-muted-foreground">
              Ranked by time, not call count — spans overlap, so the total can exceed the day's
              elapsed time.
              {machine.failures > 0 && ` ${machine.failures} did not exit cleanly.`}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * Focused time per local hour, all 24 shown. The empty hours are the point:
 * a chart of only the busy ones hides the shape of the day, and the shape is
 * what this tab is for. Bars scale against a full hour rather than against
 * the busiest hour, so a bar's height means the same thing on every day.
 */
function HourChart({ hours }: { hours: AttentionSummary["hours"] }) {
  const busiest = Math.max(1, ...hours.map((h) => h.actions));
  return (
    <div>
      <div className="flex h-24 items-end gap-[3px]">
        {hours.map((h) => (
          <div
            key={h.hour}
            className="group relative flex h-full flex-1 flex-col justify-end gap-[2px]"
            title={`${String(h.hour).padStart(2, "0")}:00 — ${fmtDuration(h.focusedMs)} focused, ${h.actions} gestures, ${h.spawns} spawns`}
          >
            <div
              className="w-full rounded-t-sm bg-violet-500/70 group-hover:bg-violet-500"
              style={{ height: `${Math.min(100, (h.focusedMs / 3_600_000) * 100)}%` }}
            />
            <div
              className="w-full shrink-0 rounded-sm bg-sky-500/70"
              style={{ height: `${h.actions > 0 ? Math.max(2, (h.actions / busiest) * 18) : 0}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] font-mono text-[9.5px] text-muted-foreground/70">
        {hours.map((h) => (
          <span key={h.hour} className="flex-1 text-center">
            {h.hour % 3 === 0 ? h.hour : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <Legend className="bg-violet-500/70" label="focused time" />
        <Legend className="bg-sky-500/70" label="gestures" />
        <span className="ml-auto">local hours</span>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-sm", className)} />
      {label}
    </span>
  );
}

/**
 * Every focus stretch placed on one strip spanning the first to the last
 * stretch of the day, so the gaps between them are as visible as the blocks —
 * a day of six evenly spaced check-ins looks nothing like a day with one long
 * afternoon, and the totals above can't tell them apart.
 */
function FocusTimeline({ sessions }: { sessions: FocusSession[] }) {
  const placed = useMemo(() => {
    const start = new Date(sessions[0]?.start ?? "").getTime();
    const end = new Date(sessions.at(-1)?.end ?? "").getTime();
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) return null;
    return sessions.map((s, i) => ({
      key: `${s.start}-${i}`,
      session: s,
      leftPct: ((new Date(s.start).getTime() - start) / span) * 100,
      // Floored so a 30-second stretch on an eight-hour strip is still a
      // visible tick rather than a sub-pixel nothing.
      widthPct: Math.max(0.6, (s.durationMs / span) * 100),
    }));
  }, [sessions]);

  if (!placed) return null;

  return (
    <div className="relative h-7 overflow-hidden rounded-md bg-muted">
      {placed.map((p) => (
        <div
          key={p.key}
          className={cn(
            "absolute inset-y-0 rounded-sm bg-violet-500/80",
            p.session.openEnded && "bg-violet-500/40",
          )}
          style={{ left: `${p.leftPct}%`, width: `${p.widthPct}%` }}
          title={`${timeOf(p.session.start)} – ${timeOf(p.session.end)} · ${fmtDuration(p.session.durationMs)}${p.session.openEnded ? " (still focused at the last record)" : ""}`}
        />
      ))}
    </div>
  );
}

/** A bar row whose right-hand column is a formatted string rather than a raw
 * count — `BarRow` renders the number it scales by, which is milliseconds
 * here and unreadable as digits. */
function MeterRow({
  label,
  value,
  max,
  right,
}: {
  label: string;
  value: number;
  max: number;
  right: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 truncate font-mono text-xs" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-violet-500"
          style={{ width: `${Math.max(2, (value / Math.max(1, max)) * 100)}%` }}
        />
      </div>
      <span className="w-32 shrink-0 whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
        {right}
      </span>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

/** Median rather than mean: one four-hour stretch among a dozen glances would
 * drag an average up to something the day never looked like. */
function medianDuration(sessions: FocusSession[]): number {
  if (sessions.length === 0) return 0;
  const sorted = sessions.map((s) => s.durationMs).toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

/** `HH:MM` of an RFC 3339 timestamp, in local time. */
function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
