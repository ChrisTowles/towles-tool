import { useMemo } from "react";
import { PlugIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { Card, Empty } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { PALETTE } from "@/lib/colors";
import { fmtAge, type McpCall } from "@/lib/data";
import type { McpToolDoc } from "@/lib/schemas/mcp";

/** Distinct clients that identified themselves (`clientInfo` rides on every request). */
export function clientNames(calls: McpCall[]): string[] {
  return [...new Set(calls.map((c) => c.client).filter((c): c is string => !!c))];
}

/** Per-tool call counts, busiest first. */
function toolUsage(calls: McpCall[]): { name: string; total: number; failed: number }[] {
  const by = new Map<string, { name: string; total: number; failed: number }>();
  for (const c of calls) {
    const name = c.tool ?? c.method;
    const row = by.get(name) ?? { name, total: 0, failed: 0 };
    row.total += 1;
    if (!c.ok) row.failed += 1;
    by.set(name, row);
  }
  return [...by.values()].toSorted((a, b) => b.total - a.total);
}

export function OverviewTab({
  calls,
  tools,
  now,
  onOpenSetup,
}: {
  calls: McpCall[];
  tools: McpToolDoc[] | null;
  now: number;
  onOpenSetup: () => void;
}) {
  const usage = useMemo(() => toolUsage(calls), [calls]);
  const max = Math.max(1, ...usage.map((u) => u.total));
  const clients = useMemo(() => clientNames(calls), [calls]);
  const recent = calls.slice(0, 6);

  if (calls.length === 0) {
    return (
      <Card title="No calls yet">
        <Empty inline>
          Nothing has called this server. The towles-tool-app plugin registers it automatically —
          check the Setup tab if a client isn&apos;t connecting.
        </Empty>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          icon={<PlugIcon className="size-3.5" />}
          onClick={onOpenSetup}
        >
          Setup
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Most-used tools" note={tools ? `${tools.length} exposed` : undefined}>
          <div className="flex flex-col gap-1.5">
            {usage.slice(0, 8).map((u) => (
              <div key={u.name} className="flex items-center gap-2 text-sm">
                <span className="w-40 truncate font-mono text-xs text-foreground" title={u.name}>
                  {u.name}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", u.failed > 0 && "bg-warn")}
                    style={{
                      width: `${Math.max(2, (u.total / max) * 100)}%`,
                      backgroundColor: u.failed > 0 ? undefined : PALETTE[0],
                    }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-xs text-kumo-subtle">
                  {u.total}
                  {u.failed > 0 && <span className="text-danger"> ·{u.failed}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Callers" note={`${clients.length}`}>
          {clients.length === 0 ? (
            <Empty inline>No client has identified itself yet.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {clients.map((c) => (
                <span key={c} className="font-mono text-xs text-foreground">
                  {c}
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Recent activity" note={`newest ${fmtAge(calls[0].ts, now)}`}>
        <div className="-mx-1 flex flex-col">
          {recent.map((call) => (
            <div key={call.id} className="flex items-center gap-2.5 px-1 py-1">
              <span
                className={cn("size-2 shrink-0 rounded-full", call.ok ? "bg-ok" : "bg-danger")}
              />
              <span className="font-mono text-xs text-foreground">{call.tool ?? call.method}</span>
              <span className="ml-auto font-mono text-mini text-kumo-subtle">
                {fmtAge(call.ts, now)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
