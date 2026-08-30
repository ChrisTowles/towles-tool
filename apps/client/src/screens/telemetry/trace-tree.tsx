import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { TelemetryRecord } from "@/lib/telemetry";

/** A span's reconstructed children (`tt_telemetry::children_of`) as a waterfall.
 * Gaps stay visible on purpose: a 58 s span with 4 s of children is 54 s of
 * silence, and the silence is the finding. */

/** Below this share of the parent a bar would be invisible; an event is a tick. */
const MIN_BAR_PERCENT = 0.4;

type Row = {
  record: TelemetryRecord;
  label: string;
  startMs: number;
  durationMs: number;
  depth: number;
};

function windowOf(record: TelemetryRecord): { start: number; end: number } {
  const end = new Date(record.ts).getTime();
  return { start: end - (record.durationMs ?? 0), end };
}

/** An event's identity is its `message`; a span's is its name. */
function labelOf(record: TelemetryRecord): string {
  const message = record.fields.message;
  return record.kind === "event" && typeof message === "string" ? message : record.name;
}

/** Depth = how many earlier spans' windows contain this one; children arrive
 * oldest-first, so every ancestor precedes its descendants. */
export function layoutRows(descendants: TelemetryRecord[]): Row[] {
  const open: { start: number; end: number }[] = [];
  return descendants.map((record) => {
    const { start, end } = windowOf(record);
    while (open.length > 0) {
      const top = open[open.length - 1];
      if (start >= top.start && end <= top.end) break;
      open.pop();
    }
    const depth = open.length;
    if (record.durationMs !== null) open.push({ start, end });
    return {
      record,
      label: labelOf(record),
      startMs: start,
      durationMs: record.durationMs ?? 0,
      depth,
    };
  });
}

function fmtMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function TraceTree({
  parent,
  descendants,
  onOpen,
}: {
  parent: TelemetryRecord;
  /** Oldest first, as `telemetry_trace` returns them. */
  descendants: TelemetryRecord[];
  onOpen: (record: TelemetryRecord) => void;
}) {
  const rows = useMemo(() => layoutRows(descendants), [descendants]);
  const parentWindow = windowOf(parent);
  const total = Math.max(1, parentWindow.end - parentWindow.start);
  const childrenMs = rows.reduce((sum, r) => sum + r.durationMs, 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-medium text-foreground">Trace</h4>
        <span className="font-mono text-[11px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? "child" : "children"} · {fmtMs(childrenMs)} of{" "}
          {fmtMs(total)}
        </span>
      </div>
      <div className="flex flex-col rounded-md border border-border">
        <TraceRow
          label={parent.name}
          duration={total}
          left={0}
          width={100}
          depth={0}
          isEvent={false}
          isError={parent.level === "ERROR"}
          isParent
        />
        {rows.map((row, i) => (
          <TraceRow
            key={`${row.record.ts}-${i}`}
            label={row.label}
            duration={row.durationMs}
            left={((row.startMs - parentWindow.start) / total) * 100}
            width={(row.durationMs / total) * 100}
            depth={row.depth + 1}
            isEvent={row.record.kind === "event"}
            isError={row.record.level === "ERROR"}
            onClick={() => onOpen(row.record)}
          />
        ))}
      </div>
    </div>
  );
}

function TraceRow({
  label,
  duration,
  left,
  width,
  depth,
  isEvent,
  isError,
  isParent,
  onClick,
}: {
  label: string;
  duration: number;
  left: number;
  width: number;
  depth: number;
  isEvent: boolean;
  isError: boolean;
  isParent?: boolean;
  onClick?: () => void;
}) {
  const barLeft = Math.min(100 - MIN_BAR_PERCENT, Math.max(0, left));
  const barWidth = isEvent
    ? MIN_BAR_PERCENT
    : Math.min(100 - barLeft, Math.max(MIN_BAR_PERCENT, width));
  const body = (
    <>
      <span
        className={cn(
          "w-48 shrink-0 truncate font-mono text-[11px]",
          isParent ? "text-foreground" : "text-muted-foreground",
          isError && "text-red-600 dark:text-red-400",
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
        title={label}
      >
        {label}
      </span>
      <span className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted/40">
        <span
          className={cn(
            "absolute top-0 h-full rounded-sm",
            isParent ? "bg-foreground/15" : isEvent ? "bg-foreground/70" : "bg-foreground/35",
            isError && "bg-red-500/60",
          )}
          style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
        />
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        {isEvent ? "·" : fmtMs(duration)}
      </span>
    </>
  );
  const rowClass = "flex w-full items-center gap-2 px-2 py-1 text-left";
  if (!onClick) {
    return <div className={cn(rowClass, "border-b border-border bg-muted/20")}>{body}</div>;
  }
  return (
    <button type="button" onClick={onClick} className={cn(rowClass, "hover:bg-accent/50")}>
      {body}
    </button>
  );
}
