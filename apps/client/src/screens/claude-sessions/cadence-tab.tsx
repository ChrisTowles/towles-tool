import { Result } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, StatTile } from "@/components/store-bits";
import { claudeSessionsCadence, type CadenceSummary } from "@/lib/claude-sessions";
import { PALETTE } from "@/lib/colors";
import { cssPx, cssVar, useEChart } from "@/screens/claude-sessions/charts";
import { reportSessionsError } from "@/screens/claude-sessions/shared";

/** Cadence outlines: from the palette too, so the heat map has no status hue. */
const WEEKEND_OUTLINE = PALETTE[6];
const WORK_HOUR_OUTLINE = PALETTE[1];
/** `0` → `12am`, `13` → `1pm`, … — compact hour-of-day axis labels. */
function formatHourLabel(hour: number): string {
  const period = hour < 12 ? "am" : "pm";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}${period}`;
}

/** `YYYY-MM-DD` for a `Date`, in local time (never UTC — `toISOString` would
 * shift the date near midnight). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The selected window (`"0"` = all time) ending today. The backend clips
 * `byDay`/`byDayHour` to the same window per-prompt (see `build_cadence`), so
 * this only mirrors that window for the axis. */
function dateRange(daysSel: string, byDay: CadenceSummary["byDay"]): [string, string] {
  const today = new Date();
  const end = localDateStr(today);
  const n = Number(daysSel);
  if (n > 0) {
    const start = new Date(today);
    start.setDate(start.getDate() - (n - 1));
    return [localDateStr(start), end];
  }
  return [byDay.length ? byDay[0].date : end, end];
}

/** Every `YYYY-MM-DD` from `start` to `end`, inclusive, ascending — the row
 * labels for the day×hour grid, so a day with zero prompts still gets a row
 * of empty cells rather than silently disappearing. */
function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const last = new Date(`${end}T00:00:00`);
  // Reassigned (not mutated) each pass via `setDate` on a fresh `Date`, so a
  // DST transition's 23/25-hour day can't skip or repeat a calendar date the
  // way a fixed-millisecond increment would.
  let cur = new Date(`${start}T00:00:00`);
  while (cur <= last) {
    dates.push(localDateStr(cur));
    const next = new Date(cur);
    next.setDate(next.getDate() + 1);
    cur = next;
  }
  return dates;
}

/** `true` for a `YYYY-MM-DD` local date that falls on Saturday or Sunday. */
function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00`).getDay();
  return dow === 0 || dow === 6;
}

/** `true` for an 8am–5pm hour (`8..16`) on a weekday — the "work hours" cue. */
function isWorkHour(date: string, hour: number): boolean {
  return !isWeekend(date) && hour >= 8 && hour < 17;
}

/** `#rrggbb` at opacity `a` — the heat ramp fades one palette color in, so it
 * reads on either theme's card. */
function withAlpha(hex: string, a: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

/** Quantile (equal-*count*, not equal-value) bins over the nonzero counts, so
 * a skewed distribution still spreads across the gradient. Up to 9 bins,
 * fewer when the data has too few distinct boundaries. */
function buildCountPieces(counts: number[]): { min: number; max: number; color: string }[] {
  const nonzero = counts.filter((c) => c > 0);
  if (nonzero.length === 0) return [];
  const sorted = nonzero.toSorted((a, b) => a - b);
  const targetBins = 9;
  const boundaries = Array.from({ length: targetBins }, (_, i) => {
    const idx = Math.min(sorted.length - 1, Math.ceil(((i + 1) * sorted.length) / targetBins) - 1);
    return sorted[idx];
  });
  const uniqueBoundaries = [...new Set(boundaries)];
  let lo = 1;
  return uniqueBoundaries.map((hi, i) => {
    const t = uniqueBoundaries.length === 1 ? 1 : i / (uniqueBoundaries.length - 1);
    const piece = { min: lo, max: hi, color: withAlpha(PALETTE[0], 0.3 + 0.7 * t) };
    lo = hi + 1;
    return piece;
  });
}

/** Punch-card heat map: a column per day (oldest left), a row per hour; zero
 * cells stay included and render as the muted surface. Square cells via the grid's pixel
 * `width`/`height` — `left`+`right` makes echarts re-stretch cells to fill. */
function DayHourHeatmap({
  byDayHour,
  range,
}: {
  byDayHour: CadenceSummary["byDayHour"];
  range: [string, string];
}) {
  const days = useMemo(() => enumerateDates(range[0], range[1]), [range]);
  const cellPx = 16;
  const gridWidth = days.length * cellPx;
  const gridHeight = 24 * cellPx;

  const ref = useEChart(
    (chart) => {
      const foreground = cssVar("--foreground");
      const muted = cssVar("--muted-foreground");
      const border = cssVar("--border");
      const card = cssVar("--card");

      const countByCell = new Map(byDayHour.map((c) => [`${c.date}|${c.hour}`, c.count]));
      // Cells are fully opaque and paint over any background layer (markArea
      // and xAxis.splitArea both verified painted-over live); a per-cell
      // border is the one cue that survives — one outline for a weekend, another for a work hour.
      const data: { value: [number, number, number]; itemStyle?: { borderColor: string } }[] = [];
      days.forEach((date, dayIndex) => {
        const weekend = isWeekend(date);
        for (let hour = 0; hour < 24; hour++) {
          const borderColor = weekend
            ? WEEKEND_OUTLINE
            : isWorkHour(date, hour)
              ? WORK_HOUR_OUTLINE
              : undefined;
          data.push({
            value: [dayIndex, hour, countByCell.get(`${date}|${hour}`) ?? 0],
            itemStyle: borderColor ? { borderColor } : undefined,
          });
        }
      });

      chart.setOption({
        tooltip: {
          backgroundColor: card,
          borderColor: border,
          textStyle: { color: foreground },
          formatter: (p: { value: [number, number, number] }) =>
            `${days[p.value[0]]} · ${formatHourLabel(p.value[1])}<br/>${p.value[2]} prompt${
              p.value[2] === 1 ? "" : "s"
            }`,
        },
        visualMap: {
          // Piecewise, not continuous: with `min: 1` a continuous visualMap
          // still painted zero cells like the nonzero low end (verified live —
          // `outOfRange` never took effect); piecewise zero takes `--muted`.
          type: "piecewise",
          dimension: 2,
          show: false,
          pieces: [
            { min: 0, max: 0, color: cssVar("--muted") },
            ...buildCountPieces(byDayHour.map((c) => c.count)),
          ],
        },
        grid: { left: 44, top: 8, width: gridWidth, height: gridHeight },
        xAxis: {
          type: "category",
          data: days.map((d) => d.slice(5)),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: (_value: string, index: number) =>
              isWeekend(days[index]) ? WEEKEND_OUTLINE : muted,
            fontSize: cssPx("--text-micro"),
            interval: Math.ceil(days.length / 15) - 1,
            rotate: 45,
          },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: Array.from({ length: 24 }, (_, h) => formatHourLabel(h)),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: muted, fontSize: cssPx("--text-micro") },
        },
        series: [
          {
            type: "heatmap",
            data,
            itemStyle: { borderWidth: 1, borderColor: border },
          },
        ],
      });
    },
    [byDayHour, days],
  );

  if (byDayHour.length === 0)
    return <p className="text-sm text-muted-foreground">No prompts in this range.</p>;
  return (
    <div className="overflow-x-auto">
      <div ref={ref} style={{ height: gridHeight + 60, width: gridWidth + 60 }} />
    </div>
  );
}

/** When in the day, and how often, the human sends prompts — cadence, not
 * token/cost accounting. Same fetch-once-per-activation pattern as
 * [`InsightsTab`]. */
export function CadenceTab({
  days,
  nonce,
  active,
}: {
  days: string;
  nonce: number;
  active: boolean;
}) {
  const [cadence, setCadence] = useState<CadenceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${days}:${nonce}`;
    if (!active || fetchedKey.current === key) return;
    fetchedKey.current = key;
    setLoading(true);
    void claudeSessionsCadence(Number(days)).then((r) => {
      Result.match(r, {
        onSuccess: setCadence,
        onFailure: (e) => {
          setCadence(null);
          reportSessionsError(e);
        },
      });
      setLoading(false);
    });
  }, [active, days, nonce]);

  if (loading && !cadence)
    return <p className="p-4 text-sm text-muted-foreground">Scanning prompts…</p>;
  if (!cadence) return null;

  const activeDays = cadence.byDay.length;
  const avgPerDay = activeDays > 0 ? cadence.totalPrompts / activeDays : 0;
  const range = dateRange(days, cadence.byDay);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Prompts" value={String(cadence.totalPrompts)} />
        <StatTile label="Active days" value={String(activeDays)} />
        <StatTile label="Avg / active day" value={avgPerDay.toFixed(1)} />
      </div>
      <Card title="Prompts by day & hour">
        <DayHourHeatmap byDayHour={cadence.byDayHour} range={range} />
      </Card>
      <p className="text-mini text-muted-foreground">
        Dates and hours are local time. Counts are human-typed prompts only — tool results and
        injected envelopes are excluded, and token/cost volume plays no part here.{" "}
        <OutlineKey color={WEEKEND_OUTLINE} /> outlines a weekend day;{" "}
        <OutlineKey color={WORK_HOUR_OUTLINE} /> outlines 8am–5pm on a weekday.
      </p>
    </div>
  );
}

function OutlineKey({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 rounded-[2px] border-2 align-middle"
      style={{ borderColor: color }}
    />
  );
}
