import { useMemo } from "react";
import { BarRow, Card, Empty, maxCount } from "@/components/store-bits";
import type { TelemetryRecord } from "@/lib/telemetry";
import { countBy } from "@/screens/telemetry/overview-tab";

export function InsightsTab({
  events,
  onSelect,
}: {
  events: TelemetryRecord[];
  onSelect: (record: TelemetryRecord) => void;
}) {
  const slowestSpans = useMemo(
    () =>
      events
        .filter((e): e is TelemetryRecord & { durationMs: number } => e.durationMs !== null)
        .toSorted((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10),
    [events],
  );
  const byName = useMemo(
    () =>
      countBy(events, (e) => e.name)
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 10),
    [events],
  );

  if (events.length === 0) {
    return (
      <Card title="Insights">
        <Empty inline>No telemetry to analyze for this day.</Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Slowest spans" note={`${slowestSpans.length}`}>
        {slowestSpans.length === 0 ? (
          <Empty inline>No spans recorded.</Empty>
        ) : (
          <div className="-mx-1.5 flex flex-col">
            {slowestSpans.map((e, i) => (
              <button
                key={`${e.ts}-${i}`}
                type="button"
                onClick={() => onSelect(e)}
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/50"
              >
                <span className="font-mono text-xs text-foreground">{e.name}</span>
                <span className="font-mono text-mini text-muted-foreground/60">{e.target}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {e.durationMs}ms
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Busiest names" note={`${byName.length}`}>
        <div className="flex flex-col gap-1.5">
          {byName.map((r) => (
            <BarRow key={r.key} label={r.key} count={r.count} max={maxCount(byName)} />
          ))}
        </div>
      </Card>
    </div>
  );
}
