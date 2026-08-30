import { cn } from "@/lib/utils";
import { fmtDuration, type DashboardSummary } from "@/lib/telemetry";

/** Series colours go by position in `summary.series`, never by name, so a series
 * keeps its hue across ranges and groupings; `other` (always last) is neutral.
 * The five hues were validated as a set for CVD separation in both themes. */

const SERIES_TONES = [
  { fill: "fill-violet-600", stroke: "stroke-violet-600", bg: "bg-violet-600" },
  { fill: "fill-sky-600", stroke: "stroke-sky-600", bg: "bg-sky-600" },
  { fill: "fill-emerald-600", stroke: "stroke-emerald-600", bg: "bg-emerald-600" },
  { fill: "fill-orange-600", stroke: "stroke-orange-600", bg: "bg-orange-600" },
  { fill: "fill-pink-600", stroke: "stroke-pink-600", bg: "bg-pink-600" },
];

const OTHER_TONE = {
  fill: "fill-muted-foreground/50",
  stroke: "stroke-muted-foreground/50",
  bg: "bg-muted-foreground/50",
};

export function seriesTone(name: string, index: number) {
  return name === "other" ? OTHER_TONE : (SERIES_TONES[index] ?? OTHER_TONE);
}

export type LogPoint = { day: string; hour?: number; executable?: string };

/** `YYYY-MM-DD HH` (local hour) or `YYYY-MM-DD` (UTC day) → the log's coordinates. */
export function pointOf(bucketKey: string, series?: string): LogPoint {
  const day = bucketKey.slice(0, 10);
  const hour = bucketKey.length > 10 ? Number(bucketKey.slice(11)) : undefined;
  return { day, ...(hour !== undefined && { hour }), ...(series && { executable: series }) };
}

const VIEW_W = 320;
const VIEW_H = 130;
const PAD = { top: 8, right: 6, bottom: 18, left: 30 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

function tickLabel(key: string, bucket: DashboardSummary["bucket"], i: number, n: number) {
  if (bucket === "hour") return i % 3 === 0 ? key.slice(11) : "";
  return n > 8 && i % 2 === 1 ? "" : key.slice(5);
}

function Grid({ top, mid, unit }: { top: string; mid: string; unit?: string }) {
  const lines = [0, 0.5, 1];
  return (
    <g className="stroke-border" strokeWidth={0.5}>
      {lines.map((f) => (
        <line
          key={f}
          x1={PAD.left}
          x2={VIEW_W - PAD.right}
          y1={PAD.top + PLOT_H * f}
          y2={PAD.top + PLOT_H * f}
        />
      ))}
      <g className="fill-muted-foreground stroke-none" fontSize={8} textAnchor="end">
        <text x={PAD.left - 3} y={PAD.top + 3}>
          {top}
        </text>
        <text x={PAD.left - 3} y={PAD.top + PLOT_H / 2 + 3}>
          {mid}
        </text>
        {unit && (
          <text x={PAD.left - 3} y={PAD.top + PLOT_H + 3}>
            {unit}
          </text>
        )}
      </g>
    </g>
  );
}

function XAxis({ keys, bucket }: { keys: string[]; bucket: DashboardSummary["bucket"] }) {
  const step = PLOT_W / Math.max(1, keys.length);
  return (
    <g className="fill-muted-foreground" fontSize={8} textAnchor="middle">
      {keys.map((k, i) => {
        const label = tickLabel(k, bucket, i, keys.length);
        return label ? (
          <text key={k} x={PAD.left + step * (i + 0.5)} y={VIEW_H - 5}>
            {label}
          </text>
        ) : null;
      })}
    </g>
  );
}

const svgProps = {
  viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
  className: "h-auto w-full font-mono [font-variant-numeric:tabular-nums]",
  role: "img",
} as const;

export function StackedBars({
  summary,
  onPoint,
}: {
  summary: DashboardSummary;
  onPoint: (point: LogPoint) => void;
}) {
  const { buckets, series, bucket } = summary;
  const totals = buckets.map((b) => b.spawnsByExec.reduce((n, s) => n + s.count, 0));
  const max = Math.max(1, ...totals);
  const step = PLOT_W / Math.max(1, buckets.length);
  const barW = Math.max(1.5, step - 2);
  const keys = buckets.map((b) => b.key);
  const scale = (n: number) => (n / max) * PLOT_H;

  return (
    <svg {...svgProps} aria-label="Spawns per bucket, stacked by series">
      <Grid top={String(max)} mid={String(Math.round(max / 2))} />
      {buckets.map((b, i) => {
        let y = PAD.top + PLOT_H;
        const x = PAD.left + step * i + (step - barW) / 2;
        return b.spawnsByExec.map((s) => {
          const h = scale(s.count);
          y -= h;
          const tone = seriesTone(s.name, series.indexOf(s.name));
          return (
            <rect
              key={`${b.key}-${s.name}`}
              x={x}
              y={y + 0.5}
              width={barW}
              height={Math.max(0, h - 1)}
              className={cn(tone.fill, "cursor-pointer hover:opacity-80")}
              onClick={() => onPoint(pointOf(b.key, s.name))}
            >
              <title>{`${b.key} · ${s.name} · ${s.count} spawns, ${s.failures} failed`}</title>
            </rect>
          );
        });
      })}
      <XAxis keys={keys} bucket={bucket} />
    </svg>
  );
}

export function ErrorRateLines({
  summary,
  onPoint,
}: {
  summary: DashboardSummary;
  onPoint: (point: LogPoint) => void;
}) {
  const { buckets, series, bucket } = summary;
  const step = PLOT_W / Math.max(1, buckets.length);
  const xOf = (i: number) => PAD.left + step * (i + 0.5);
  const yOf = (rate: number) => PAD.top + PLOT_H * (1 - rate);

  return (
    <svg {...svgProps} aria-label="Share of failed spawns per bucket, one line per series">
      <Grid top="100%" mid="50%" unit="0" />
      {series.map((name, si) => {
        const tone = seriesTone(name, si);
        const points = buckets.map((b, i) => {
          const s = b.spawnsByExec.find((e) => e.name === name);
          return s && s.count > 0 ? { i, x: xOf(i), y: yOf(s.failures / s.count), s, b } : null;
        });
        let d = "";
        let previous = false;
        for (const p of points) {
          if (!p) {
            previous = false;
            continue;
          }
          d += `${previous ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          previous = true;
        }
        const last = points.findLast((p) => p !== null);
        return (
          <g key={name}>
            <path d={d} fill="none" strokeWidth={1.5} className={tone.stroke} />
            {last && <circle cx={last.x} cy={last.y} r={3} className={tone.fill} />}
            {points.map(
              (p) =>
                p && (
                  <circle
                    key={p.i}
                    cx={p.x}
                    cy={p.y}
                    r={5}
                    className="cursor-pointer fill-transparent hover:fill-foreground/10"
                    onClick={() => onPoint(pointOf(p.b.key, name))}
                  >
                    <title>{`${p.b.key} · ${name} · ${p.s.failures}/${p.s.count} failed`}</title>
                  </circle>
                ),
            )}
          </g>
        );
      })}
      <XAxis keys={buckets.map((b) => b.key)} bucket={bucket} />
    </svg>
  );
}

const WAIT_W = 320;
const WAIT_H = 110;

export function WaitBars({ summary }: { summary: DashboardSummary }) {
  const days = summary.waitByDay;
  const max = Math.max(1, ...days.map((d) => d.totalMs));
  const step = (WAIT_W - PAD.left - PAD.right) / Math.max(1, days.length);
  const barW = Math.max(4, Math.min(28, step - 6));
  const plotH = WAIT_H - PAD.top - PAD.bottom;

  return (
    <svg
      viewBox={`0 0 ${WAIT_W} ${WAIT_H}`}
      className={svgProps.className}
      role="img"
      aria-label="Subprocess wait per day"
    >
      <g className="stroke-border" strokeWidth={0.5}>
        <line x1={PAD.left} x2={WAIT_W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
      </g>
      {days.map((d, i) => {
        const h = (d.totalMs / max) * plotH;
        const x = PAD.left + step * i + (step - barW) / 2;
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={PAD.top + plotH - h}
              width={barW}
              height={h}
              rx={1.5}
              className="fill-violet-600"
            >
              <title>{`${d.day} · ${fmtDuration(d.totalMs)} over ${d.count} spawns`}</title>
            </rect>
            <text
              x={x + barW / 2}
              y={PAD.top + plotH - h - 3}
              fontSize={8}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              {d.totalMs === 0
                ? ""
                : d.totalMs < 60_000
                  ? "<1m"
                  : `${Math.round(d.totalMs / 60_000)}m`}
            </text>
            <text
              x={x + barW / 2}
              y={WAIT_H - 5}
              fontSize={8}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              {days.length > 8 && i % 2 === 1 ? "" : d.day.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const LONG_SPAWN_MS = 30_000;

const fmtMs = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** Log-ish scale: a 5 ms `git status` and a 40 s `cargo build` share one axis. */
export function DurationBars({ summary }: { summary: DashboardSummary }) {
  const rows = summary.byExecutable;
  const top = Math.max(1, ...rows.map((r) => r.p95Ms));
  const width = (ms: number) => `${Math.max(1, (Math.log10(ms + 1) / Math.log10(top + 1)) * 100)}%`;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 text-xs">
          <span className="w-16 truncate font-mono" title={r.name}>
            {r.name}
          </span>
          <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-violet-600/30"
              style={{ width: width(r.p95Ms) }}
              title={`p95 ${fmtMs.format(r.p95Ms)} ms`}
            />
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-violet-600"
              style={{ width: width(r.p50Ms) }}
              title={`p50 ${fmtMs.format(r.p50Ms)} ms`}
            />
          </div>
          <span className="w-36 shrink-0 whitespace-nowrap text-right font-mono text-muted-foreground [font-variant-numeric:tabular-nums]">
            {r.maxMs === 0 ? (
              "detached"
            ) : (
              <>
                {fmtMs.format(r.p50Ms)} · {fmtMs.format(r.p95Ms)} ms
                {r.maxMs > LONG_SPAWN_MS && (
                  <span className="text-orange-800 dark:text-orange-400">
                    {" "}
                    max {Math.round(r.maxMs / 1000)}s
                  </span>
                )}
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SeriesLegend({
  items,
}: {
  items: { name: string; index: number; note: string }[];
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
      {items.map((it) => (
        <span key={it.name} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-sm", seriesTone(it.name, it.index).bg)} />
          <span className="max-w-32 truncate" title={it.name}>
            {it.name}
          </span>
          <span>{it.note}</span>
        </span>
      ))}
    </div>
  );
}
