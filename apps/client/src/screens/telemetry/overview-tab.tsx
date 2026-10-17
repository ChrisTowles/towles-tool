import { useMemo } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { BarRow, Card, Empty, maxCount } from "@/components/store-bits";
import { LEVELS, type TelemetryRecord } from "@/lib/telemetry";
import { LEVEL_TONE, timeOf } from "@/screens/telemetry/telemetry-row";

/** Groups `items` by `key`, one pass. */
export function countBy<T>(items: T[], key: (item: T) => string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, count]) => ({ key: k, count }));
}

/** A single source (target or name) is this dominant before Overview calls it
 * out — the log being this lopsided is itself a signal something may be
 * over-logging, not just a UI-scale problem to page past. */
const DOMINANCE_THRESHOLD = 0.8;

export function OverviewTab({
  events,
  levelCounts,
  day,
  onOpenLog,
}: {
  events: TelemetryRecord[];
  levelCounts: { key: string; count: number }[];
  day: string | null;
  onOpenLog: () => void;
}) {
  const byLevel = useMemo(() => {
    const counts = new Map(levelCounts.map((r) => [r.key, r.count]));
    return LEVELS.map((l) => ({ level: l, count: counts.get(l) ?? 0 })).filter((r) => r.count > 0);
  }, [levelCounts]);
  const byTarget = useMemo(
    () =>
      countBy(events, (e) => e.target)
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 8),
    [events],
  );
  const recentErrors = useMemo(
    () => events.filter((e) => e.level === "ERROR").slice(0, 6),
    [events],
  );
  const dominant = byTarget[0];

  if (events.length === 0) {
    return (
      <Card title="No telemetry">
        <Empty inline>
          {day ? `No records for ${day}.` : "No telemetry logs found for this checkout yet."}
        </Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {dominant && dominant.count / events.length >= DOMINANCE_THRESHOLD && (
        <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <WarningCircleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-mono">{dominant.key}</span> accounts for{" "}
            {Math.round((dominant.count / events.length) * 100)}% of today's records (
            {dominant.count} of {events.length}) — if that's more than you'd expect, something may
            be over-logging rather than this just being a busy day.
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="By level">
          <div className="flex flex-col gap-1.5">
            {byLevel.map((r) => (
              <BarRow
                key={r.level}
                label={r.level}
                count={r.count}
                max={maxCount(byLevel)}
                tone={LEVEL_TONE[r.level]}
              />
            ))}
          </div>
        </Card>

        <Card title="Busiest targets" note={`${byTarget.length}`}>
          <div className="flex flex-col gap-1.5">
            {byTarget.map((r) => (
              <BarRow key={r.key} label={r.key} count={r.count} max={maxCount(byTarget)} />
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Recent errors"
        note={recentErrors.length > 0 ? undefined : "none"}
        action={
          <Button variant="outline" size="sm" onClick={onOpenLog}>
            Open log
          </Button>
        }
      >
        {recentErrors.length === 0 ? (
          <Empty inline>No errors today.</Empty>
        ) : (
          <div className="-mx-1 flex flex-col">
            {recentErrors.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="flex items-center gap-2.5 px-1 py-1">
                <span className="font-mono text-xs text-foreground">{e.name}</span>
                <span className="font-mono text-mini text-muted-foreground/60">{e.target}</span>
                <span className="ml-auto font-mono text-mini text-muted-foreground">
                  {timeOf(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
