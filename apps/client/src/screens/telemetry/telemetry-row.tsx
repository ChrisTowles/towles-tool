import { useEffect, useState } from "react";
import { Dialog } from "@cloudflare/kumo";
import { cn } from "@/lib/utils";
import { telemetryTrace, type TelemetryRecord } from "@/lib/telemetry";
import { TraceTree } from "@/screens/telemetry/trace-tree";

export const LEVEL_TONE: Record<string, string> = {
  ERROR: "text-danger",
  WARN: "text-warn",
  INFO: "text-foreground",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

/** `HH:MM:SS` of an RFC 3339 timestamp, for a compact time column. */
export function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour12: false });
}

/** A one-line summary of a record's extra fields, for the row's second line. */
export function fieldsSummary(fields: Record<string, unknown>): string | null {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

export function TelemetryRow({
  record,
  summary,
  showDay,
  onSelect,
}: {
  record: TelemetryRecord;
  summary: string | null;
  /** A multi-day range needs the date; a single day would only repeat it. */
  showDay: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border-l-2 border-transparent px-3 py-2 text-left hover:bg-accent/50",
        record.level === "ERROR" && "border-l-danger bg-danger/5",
      )}
    >
      <div className="flex w-full items-center gap-2.5">
        <span
          className={cn(
            "shrink-0 font-mono text-mini text-muted-foreground",
            showDay ? "w-36" : "w-20",
          )}
        >
          {showDay && <span className="text-muted-foreground/60">{record.ts.slice(5, 10)} </span>}
          {timeOf(record.ts)}
        </span>
        <span
          className={cn("w-12 shrink-0 font-mono text-mini font-medium", LEVEL_TONE[record.level])}
        >
          {record.level}
        </span>
        <span className="font-mono text-xs text-foreground">{record.name}</span>
        <span className="font-mono text-mini text-muted-foreground/60">{record.target}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-mini text-muted-foreground">
          {record.durationMs !== null && <span>{record.durationMs}ms</span>}
        </div>
      </div>
      {summary && (
        <span
          className={cn(
            "w-full truncate font-mono text-mini text-muted-foreground/70",
            showDay ? "pl-[150px]" : "pl-[86px]",
          )}
        >
          {summary}
        </span>
      )}
    </button>
  );
}

export function RecordDialog({
  record,
  onOpen,
  onClose,
}: {
  record: TelemetryRecord | null;
  onOpen: (record: TelemetryRecord) => void;
  onClose: () => void;
}) {
  const [children, setChildren] = useState<TelemetryRecord[] | null>(null);

  // Children are fetched, not derived: with a multi-day range the page holds
  // a few hundred rows, and the siblings live in the day file.
  useEffect(() => {
    setChildren(null);
    if (!record || record.durationMs === null) return;
    let live = true;
    void telemetryTrace(record.ts, record.ts.slice(0, 10)).then((r) => {
      if (live) setChildren(r.unwrapOr([]));
    });
    return () => {
      live = false;
    };
  }, [record]);

  return (
    <Dialog.Root open={!!record} onOpenChange={(o) => !o && onClose()}>
      <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="pr-6 font-mono text-base">{record?.name}</Dialog.Title>
          <Dialog.Description className="text-sm">
            {record?.kind} · {record?.target}
            {record?.durationMs !== null && record?.durationMs !== undefined
              ? ` · ${record.durationMs}ms`
              : ""}
            {record ? ` · ${record.ts}` : ""}
          </Dialog.Description>
        </div>

        {record && (
          <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-2.5 font-mono text-xs whitespace-pre-wrap text-kumo-default">
            {prettyRaw(record.raw)}
          </pre>
        )}

        {record && children && children.length > 0 && (
          <TraceTree parent={record} descendants={children} onOpen={onOpen} />
        )}
      </Dialog>
    </Dialog.Root>
  );
}

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
