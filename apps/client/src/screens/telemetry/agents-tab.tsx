import { ArrowClockwiseIcon, CurrencyDollarIcon, RobotIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { Card, Empty, StatTile } from "@/components/store-bits";
import { ChipMenu } from "@/screens/telemetry/chips";
import { cn } from "@/lib/utils";
import { uiAction } from "@/lib/ui-action";
import { fmtDuration, fmtUsd } from "@/lib/format";
import { type AgentsSummary } from "@/lib/telemetry";
import {
  ColumnBars,
  dayTick,
  SeriesLegend,
  seriesColorAt,
} from "@/screens/telemetry/dashboard-charts";

/** Agents — what the app's own `claude` calls cost (prompt improvers, `/next`,
 * copy suggestions) and how each checkout's agents split their time between working
 * and waiting on you. Presentation only; the numbers come from
 * `crates/tt-telemetry/src/agents.rs`. Session spend lives on Claude Sessions. */

const AGENT_RANGES = [1, 7, 14] as const;
export type AgentRange = (typeof AGENT_RANGES)[number];
export const DEFAULT_AGENT_RANGE: AgentRange = 7;

const rangeLabel = (days: number) => (days === 1 ? "Past day" : `Past ${days} days`);

const WORKING = 0;
const WAITING = 2;

export function AgentsTab({
  summary,
  loading,
  range,
  onRange,
  onRefresh,
}: {
  summary: AgentsSummary | null;
  loading: boolean;
  range: AgentRange;
  onRange: (range: AgentRange) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <ChipMenu
          label={rangeLabel(range)}
          active={range !== DEFAULT_AGENT_RANGE}
          items={AGENT_RANGES.map((days) => ({
            key: String(days),
            label: rangeLabel(days),
            onSelect: () => {
              uiAction("telemetry.agents_range", "telemetry", `${days}d`);
              onRange(days);
            },
          }))}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => {
            uiAction("telemetry.agents_refresh", "telemetry");
            onRefresh();
          }}
          disabled={loading}
        >
          <ArrowClockwiseIcon className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!summary ? (
        <Card title="Agents">
          <Empty inline>{loading ? "Reading the range…" : "No telemetry for this range."}</Empty>
        </Card>
      ) : (
        <AgentsGrid summary={summary} />
      )}
    </div>
  );
}

function AgentsGrid({ summary }: { summary: AgentsSummary }) {
  const calls = summary.spendBySource.reduce((n, s) => n + s.calls, 0);
  const working = summary.timeByFolder.reduce((n, f) => n + f.workingMs, 0);
  const waiting = summary.timeByFolder.reduce((n, f) => n + f.waitingMs, 0);
  const sourceIndex = (source: string) =>
    summary.spendBySource.findIndex((s) => s.source === source);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
      <StatTile
        label="App model spend"
        value={fmtUsd(summary.totalUsd)}
        detail={`${calls} calls`}
      />
      <StatTile
        label="Agents waiting on you"
        value={fmtDuration(waiting)}
        detail={`${fmtDuration(working)} working`}
      />

      <section className="rounded-lg border border-border bg-card p-3.5">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CurrencyDollarIcon className="size-3.5 text-muted-foreground" />
          Model spend per day
        </h3>
        {calls === 0 ? (
          <Empty inline>No priced model calls in this range.</Empty>
        ) : (
          <>
            <ColumnBars
              label="App model spend per day, stacked by source"
              columns={summary.spendByDay.map((d, i, all) => ({
                key: d.day,
                label: dayTick(d.day, i, all.length),
                caption: d.usd > 0 ? fmtUsd(d.usd) : "",
                segments: d.bySource.map((s) => ({
                  value: s.usd,
                  color: seriesColorAt(sourceIndex(s.source)),
                  title: `${d.day} · ${s.source} · ${fmtUsd(s.usd)} over ${s.calls} calls`,
                })),
              }))}
            />
            <SeriesLegend
              items={summary.spendBySource.map((s, index) => ({
                name: s.source,
                index,
                note: fmtUsd(s.usd),
              }))}
            />
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-3.5">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <RobotIcon className="size-3.5 text-muted-foreground" />
          Agent time by checkout
        </h3>
        {summary.timeByFolder.length === 0 ? (
          <Empty inline>No agent status changes in this range.</Empty>
        ) : (
          <>
            <FolderTimeBars rows={summary.timeByFolder} />
            <SeriesLegend
              items={[
                { name: "working", index: WORKING, note: fmtDuration(working) },
                { name: "waiting on you", index: WAITING, note: fmtDuration(waiting) },
              ]}
            />
          </>
        )}
      </section>
    </div>
  );
}

function FolderTimeBars({ rows }: { rows: AgentsSummary["timeByFolder"] }) {
  const max = Math.max(1, ...rows.map((r) => r.workingMs + r.waitingMs));
  const pct = (ms: number) => `${(ms / max) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div
          key={r.folder}
          className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-x-2 text-xs"
        >
          <span className="truncate font-mono" title={r.folder}>
            {r.folder}
          </span>
          <div className="flex h-2.5 gap-px overflow-hidden rounded-full bg-muted">
            <div
              className="h-full"
              style={{ width: pct(r.workingMs), backgroundColor: seriesColorAt(WORKING) }}
              title={`${r.folder} · working ${fmtDuration(r.workingMs)}`}
            />
            <div
              className="h-full"
              style={{ width: pct(r.waitingMs), backgroundColor: seriesColorAt(WAITING) }}
              title={`${r.folder} · waiting on you ${fmtDuration(r.waitingMs)}`}
            />
          </div>
          <span className="whitespace-nowrap font-mono text-mini text-muted-foreground [font-variant-numeric:tabular-nums]">
            {fmtDuration(r.workingMs + r.waitingMs)}
          </span>
        </div>
      ))}
    </div>
  );
}
