import { memo, useCallback, useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Dialog, Input, Select } from "@cloudflare/kumo";
import { Card, Empty } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { fmtAge, type McpCall } from "@/lib/data";
import { uiAction } from "@/lib/ui-action";
import { useSearchTelemetry } from "@/screens/mcp/shared";

type CallFilter = "all" | "errors";

/** Lowercased once per call when the log changes, not per keystroke or clock
 * tick — the screen re-renders every second. */
function searchHaystack(call: McpCall): string {
  return [call.method, call.tool, call.args, call.client, call.error]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function CallsTab({
  calls,
  now,
  live,
  onSelect,
}: {
  calls: McpCall[];
  now: number;
  live: boolean;
  onSelect: (call: McpCall) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CallFilter>("all");

  useSearchTelemetry(query, "mcp.calls.search");

  const indexed = useMemo(
    () => calls.map((call) => ({ call, hay: searchHaystack(call) })),
    [calls],
  );

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      indexed
        .filter(
          ({ call, hay }) => (filter === "errors" ? !call.ok : true) && (!q || hay.includes(q)),
        )
        .map(({ call }) => call),
    [indexed, filter, q],
  );

  // The age string is computed here, not inside the row, so a tick that doesn't
  // change a row's coarse age ("2m") produces identical props and `CallRow`'s
  // `memo` skips it entirely.
  const rows = useMemo(
    () => shown.map((call) => ({ call, age: fmtAge(call.ts, now) })),
    [shown, now],
  );

  const open = useCallback(
    (call: McpCall) => {
      uiAction("mcp.call.open", "mcp", call.tool ?? call.method);
      onSelect(call);
    },
    [onSelect],
  );

  return (
    <Card title="Incoming calls" note={`${shown.length} of ${calls.length}`}>
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-72">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-kumo-subtle" />
          <Input
            aria-label="Search incoming calls"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tool, args, client…"
            size="sm"
            className="pl-8"
          />
        </div>
        <Select
          aria-label="Filter calls"
          size="sm"
          className="w-36"
          value={filter}
          onValueChange={(v) => {
            if (!v) return;
            setFilter(v as CallFilter);
            uiAction("mcp.calls.filter", "mcp", v);
          }}
          items={{ all: "All calls", errors: "Errors only" }}
        />
      </div>

      {shown.length === 0 ? (
        <Empty inline>
          {calls.length === 0
            ? live
              ? "No MCP calls yet. See the Setup tab to point a client here."
              : "Not connected yet."
            : "No calls match."}
        </Empty>
      ) : (
        <div className="-mx-1.5 flex flex-col">
          {rows.map(({ call, age }) => (
            <CallRow key={call.id} call={call} age={age} onSelect={open} />
          ))}
        </div>
      )}
    </Card>
  );
}

/** `memo`'d, and taking `age` pre-rendered rather than `now`, because the
 * screen re-renders on a one-second clock and the log holds a hundred of
 * these. No interactive children, so a real `<button>` is safe here. */
const CallRow = memo(function CallRow({
  call,
  age,
  onSelect,
}: {
  call: McpCall;
  age: string;
  onSelect: (call: McpCall) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(call)}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border-l-2 border-transparent px-3 py-2 text-left hover:bg-accent/50",
        !call.ok && "border-l-danger bg-danger/5",
      )}
    >
      <div className="flex w-full items-center gap-2.5">
        <span className={cn("size-2 shrink-0 rounded-full", call.ok ? "bg-ok" : "bg-danger")} />
        <span className="font-mono text-xs text-foreground">{call.tool ?? call.method}</span>
        {call.tool && (
          <span className="font-mono text-mini text-kumo-subtle/60">{call.method}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-mini text-kumo-subtle">
          {call.durationMs !== undefined && <span>{call.durationMs}ms</span>}
          <span>{age}</span>
        </div>
      </div>
      {call.args && call.args !== "{}" && (
        <span className="w-full truncate pl-[18px] font-mono text-mini text-kumo-subtle/70">
          {call.args}
        </span>
      )}
      {!call.ok && call.error && (
        <span className="w-full truncate pl-[18px] font-mono text-mini text-danger">
          {call.error}
        </span>
      )}
    </button>
  );
});

export function CallDialog({
  call,
  now,
  onClose,
}: {
  call: McpCall | null;
  now: number;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={!!call} onOpenChange={(o) => !o && onClose()}>
      <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="pr-6 font-mono text-base">
            {call?.tool ?? call?.method}
          </Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">
            {call?.method}
            {call?.client ? ` · ${call.client}` : ""}
            {call?.durationMs !== undefined ? ` · ${call.durationMs}ms` : ""}
            {call ? ` · ${fmtAge(call.ts, now)}` : ""}
          </Dialog.Description>
        </div>

        {call && (
          <div className="flex flex-col gap-4">
            <section>
              <h4 className="mb-2 text-mini font-medium uppercase tracking-wider text-kumo-subtle">
                Result
              </h4>
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={cn("size-2 shrink-0 rounded-full", call.ok ? "bg-ok" : "bg-danger")}
                />
                <span className="text-foreground">{call.ok ? "Succeeded" : "Failed"}</span>
              </div>
              {!call.ok && call.error && (
                <pre className="mt-2 overflow-x-auto rounded-md border border-kumo-hairline bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap text-danger">
                  {call.error}
                </pre>
              )}
            </section>

            <section>
              <h4 className="mb-2 text-mini font-medium uppercase tracking-wider text-kumo-subtle">
                Arguments
              </h4>
              {call.args && call.args !== "{}" ? (
                <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap text-foreground">
                  {call.args}
                </pre>
              ) : (
                <Empty inline>No arguments.</Empty>
              )}
            </section>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
