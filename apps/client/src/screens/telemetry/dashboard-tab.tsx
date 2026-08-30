import {
  ChevronDown,
  Crosshair,
  Hourglass,
  Layers,
  RefreshCw,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, Empty, StatTile } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { uiAction } from "@/lib/ui-action";
import {
  fmtDuration,
  type DashboardGroupBy,
  type DashboardRange,
  type DashboardSummary,
} from "@/lib/telemetry";
import {
  DurationBars,
  ErrorRateLines,
  SeriesLegend,
  StackedBars,
  WaitBars,
  type LogPoint,
} from "@/screens/telemetry/dashboard-charts";

/** Dashboard — Braintrust's "cost and quality" board over our data: cost is seconds
 * the app spent waiting on subprocesses, quality is their failure rate. Presentation
 * only; every number comes from `crates/tt-telemetry/src/dashboard.rs`. */

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 1, label: "Past day" },
  { value: 3, label: "Past 3 days" },
  { value: 7, label: "Past 7 days" },
  { value: 14, label: "Past 14 days" },
];

const GROUPS: { value: DashboardGroupBy; label: string }[] = [
  { value: "executable", label: "executable" },
  { value: "task", label: "tt.task" },
  { value: "working_directory", label: "working directory" },
];

export const DEFAULT_RANGE: DashboardRange = 7;
export const DEFAULT_GROUP: DashboardGroupBy = "executable";

export function DashboardTab({
  summary,
  loading,
  range,
  group,
  onRange,
  onGroup,
  onRefresh,
  onOpenLog,
}: {
  summary: DashboardSummary | null;
  loading: boolean;
  range: DashboardRange;
  group: DashboardGroupBy;
  onRange: (range: DashboardRange) => void;
  onGroup: (group: DashboardGroupBy) => void;
  onRefresh: () => void;
  onOpenLog: (point: LogPoint) => void;
}) {
  const groupLabel = GROUPS.find((g) => g.value === group)?.label ?? group;

  function openPoint(point: LogPoint) {
    uiAction("telemetry.dashboard_point", "telemetry", point.executable ?? "bucket");
    onOpenLog(point);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>
          Spans <ChevronDown className="size-3 opacity-50" />
        </Chip>
        <ChipMenu
          label={RANGES.find((r) => r.value === range)?.label ?? `Past ${range} days`}
          active={range !== DEFAULT_RANGE}
          items={RANGES.map((r) => ({
            key: String(r.value),
            label: r.label,
            onSelect: () => {
              uiAction("telemetry.dashboard_range", "telemetry", `${r.value}d`);
              onRange(r.value);
            },
          }))}
        />
        <ChipMenu
          label={`Group: ${groupLabel}`}
          active={group !== DEFAULT_GROUP}
          items={GROUPS.map((g) => ({
            key: g.value,
            label: g.label,
            onSelect: () => {
              uiAction("telemetry.dashboard_group", "telemetry", g.value);
              onGroup(g.value);
            },
          }))}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => {
            uiAction("telemetry.dashboard_refresh", "telemetry");
            onRefresh();
          }}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!summary ? (
        <Card title="Dashboard">
          <Empty inline>{loading ? "Reading the range…" : "No telemetry for this range."}</Empty>
        </Card>
      ) : (
        <DashboardGrid summary={summary} groupLabel={groupLabel} onPoint={openPoint} />
      )}
    </div>
  );
}

function ratePct(t: { count: number; failures: number }): string {
  return t.count > 0 ? `${((t.failures / t.count) * 100).toFixed(1)}%` : "–";
}

function DashboardGrid({
  summary,
  groupLabel,
  onPoint,
}: {
  summary: DashboardSummary;
  groupLabel: string;
  onPoint: (point: LogPoint) => void;
}) {
  const totals = summary.series.map((name, index) => {
    let count = 0;
    let failures = 0;
    for (const b of summary.buckets) {
      const s = b.spawnsByExec.find((e) => e.name === name);
      if (s) {
        count += s.count;
        failures += s.failures;
      }
    }
    return { name, index, count, failures };
  });
  const noSpawns = summary.spawnCount === 0;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
      <ChartCard icon={Layers} title={`Spawns by ${groupLabel}`} note={`${summary.spawnCount}`}>
        {noSpawns ? (
          <Empty inline>No subprocesses ran in this range.</Empty>
        ) : (
          <>
            <StackedBars summary={summary} onPoint={onPoint} />
            <SeriesLegend items={totals.map((t) => ({ ...t, note: String(t.count) }))} />
          </>
        )}
      </ChartCard>

      <ChartCard icon={Crosshair} title="Tool error rate">
        {noSpawns ? (
          <Empty inline>Nothing to fail yet.</Empty>
        ) : (
          <>
            <ErrorRateLines summary={summary} onPoint={onPoint} />
            <SeriesLegend items={totals.map((t) => ({ ...t, note: ratePct(t) }))} />
          </>
        )}
      </ChartCard>

      <ChartCard icon={Timer} title="Tool duration p50 · p95">
        {summary.byExecutable.length === 0 ? (
          <Empty inline>No durations recorded.</Empty>
        ) : (
          <DurationBars summary={summary} />
        )}
      </ChartCard>

      <ChartCard icon={Hourglass} title="Subprocess wait per day">
        <WaitBars summary={summary} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Overlaps allowed, so it can exceed wall time.
        </p>
      </ChartCard>

      <StatTile
        label="Focus"
        value={fmtDuration(summary.focus.focusedMs)}
        detail={`longest stretch ${fmtDuration(summary.focus.longestMs)}`}
      />
      <StatTile
        label="Interruptions"
        value={String(summary.notifications.fired)}
        detail={`${summary.notifications.skipped} skipped`}
      />
    </div>
  );
}

function ChartCard({
  icon: Icon,
  title,
  note,
  children,
}: {
  icon: LucideIcon;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="size-3.5 text-muted-foreground" />
          {title}
        </h3>
        {note && (
          <span className="font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
            {note}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

const CHIP =
  "inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2.5 font-mono text-[11px] text-muted-foreground";

function Chip({ children }: { children: React.ReactNode }) {
  return <span className={CHIP}>{children}</span>;
}

function ChipMenu({
  label,
  active,
  items,
}: {
  label: string;
  active: boolean;
  items: { key: string; label: string; onSelect: () => void }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          CHIP,
          "hover:bg-accent/50 data-[state=open]:border-violet-500/40 data-[state=open]:bg-violet-500/10 data-[state=open]:text-violet-700 dark:data-[state=open]:text-violet-300",
          active && "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        )}
      >
        {label}
        <ChevronDown className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((it) => (
          <DropdownMenuItem key={it.key} onSelect={it.onSelect} className="font-mono text-xs">
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
