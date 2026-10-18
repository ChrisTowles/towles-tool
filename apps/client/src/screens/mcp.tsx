import { Result } from "effect";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwiseIcon,
  BookOpenIcon,
  BroadcastIcon,
  PlugIcon,
  SquaresFourIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Button, Tabs } from "@cloudflare/kumo";
import { StatTile } from "@/components/store-bits";
import { fmtAge, useStoreSnapshot, type McpCall } from "@/lib/data";
import { useNow } from "@/lib/now";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { invoke, ipcOr, runIpc } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import {
  McpStatusSchema,
  McpToolDocsSchema,
  type McpStatus,
  type McpToolDoc,
} from "@/lib/schemas/mcp";
import { CallDialog, CallsTab } from "@/screens/mcp/calls-tab";
import { OverviewTab, clientNames } from "@/screens/mcp/overview-tab";
import { SetupTab } from "@/screens/mcp/setup-tab";
import { McpWire } from "@/screens/mcp/shared";
import { ToolsTab } from "@/screens/mcp/tools-tab";

const tabLabel = (icon: ReactNode, text: string) => (
  <span className="flex items-center gap-2">
    {icon}
    {text}
  </span>
);

/** Read-only console over the MCP server: who is calling it and how it
 * answered. The dispatcher retains the newest few hundred calls, the snapshot
 * carries the newest 100. */

/** Bottom of the `${tt:port 47870-48069}` range; a placeholder for browser dev
 * and for the moment before {@link useMcpStatus} reports the real port. */
const DEFAULT_MCP_PORT = 47870;

const endpointFor = (port: number) => `http://127.0.0.1:${port}/mcp`;

/** The real bind outcome, not an inference from call recency: an instance
 * whose port was already taken serves nothing while still showing its own
 * past calls, and only the backend knows which. */
function useMcpStatus() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  useEffect(() => {
    void runIpc(invoke<McpStatus>("mcp_status", {}, { schema: McpStatusSchema })).then((r) =>
      Result.match(r, {
        onSuccess: setStatus,
        // Browser dev falls back silently; a real failure must be reported,
        // or the header says "Active" for a server that may serve nothing.
        onFailure: (e) => {
          setStatus(null);
          if (!NotInTauri.is(e)) toast.error(`Could not read MCP status: ${errorMessage(e)}`);
        },
      }),
    );
  }, []);
  return status;
}

/** Drives the Overview/stat wording only, never a data decision. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

/** Falls back to call-recency only when there is no backend to ask. */
function serverLabel(status: McpStatus | null, active: boolean): string {
  if (status) return status.serving ? "Serving" : "Not serving";
  return active ? "Active" : "Idle";
}

export function McpScreen() {
  const { snapshot, live } = useStoreSnapshot();
  const now = useNow();
  const { tools, reload } = useMcpToolDocs();
  const [tab, setTab] = useState("overview");
  const [selected, setSelected] = useState<McpCall | null>(null);

  const status = useMcpStatus();
  const port = status?.port ?? DEFAULT_MCP_PORT;
  const endpoint = endpointFor(port);
  const ignoredStamp = status?.ignoredStamp ?? null;
  const wire: McpWire = {
    protocolVersion: status?.protocolVersion ?? "",
    version: status?.version ?? "",
  };

  const calls = snapshot.mcpCalls;
  const failed = useMemo(() => calls.filter((c) => !c.ok).length, [calls]);
  const clients = useMemo(() => clientNames(calls).length, [calls]);
  const newest = calls[0]?.ts;
  const active = newest !== undefined && now - newest < ACTIVE_WINDOW_MS;

  function switchTab(next: string) {
    setTab(next);
    uiAction("mcp.tab", "mcp", next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-base px-4 py-3">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
          <BroadcastIcon className="size-5 text-kumo-subtle" />
          MCP server
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-kumo-subtle">{endpoint}</span>
          <Button
            variant="outline"
            size="sm"
            icon={<ArrowClockwiseIcon className="size-3.5" />}
            onClick={() => {
              uiAction("mcp.tools.refresh", "mcp");
              reload();
            }}
          >
            Refresh
          </Button>
        </div>
      </header>

      {!live && (
        <div className="flex shrink-0 items-center gap-2 border-b border-kumo-hairline bg-warn/10 px-4 py-1.5 text-xs text-warn">
          <WarningCircleIcon className="size-3.5 shrink-0" />
          Not connected to the store — open this window in the Towles Tool app to see live calls.
        </div>
      )}

      <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-kumo-hairline p-4 lg:grid-cols-4">
        <StatTile
          label="Server"
          value={serverLabel(status, active)}
          // Each checkout claims its own port, so not-serving is a collision.
          detail={
            (status && !status.serving
              ? `port ${port} taken — this app serves no MCP`
              : status
                ? `127.0.0.1:${port} · MCP ${status.protocolVersion}`
                : `127.0.0.1:${port}`) +
            (ignoredStamp === null
              ? ""
              : ` · ignored inherited TT_MCP_PORT=${ignoredStamp} (a parent app's stamp)`)
          }
        />
        <StatTile
          label="Calls"
          value={String(calls.length)}
          detail={newest === undefined ? "none yet" : `last ${fmtAge(newest, now)}`}
        />
        <StatTile
          label="Failed"
          value={String(failed)}
          detail={
            calls.length > 0
              ? `${Math.round((failed / calls.length) * 100)}% error rate`
              : undefined
          }
        />
        <StatTile label="Clients" value={String(clients)} detail="seen in this log" />
      </div>

      <Tabs
        variant="underline"
        value={tab}
        onValueChange={switchTab}
        tabs={[
          {
            value: "overview",
            label: tabLabel(<SquaresFourIcon className="size-4" />, "Overview"),
          },
          { value: "calls", label: tabLabel(<BroadcastIcon className="size-4" />, "Calls") },
          { value: "tools", label: tabLabel(<BookOpenIcon className="size-4" />, "Tools") },
          { value: "setup", label: tabLabel(<PlugIcon className="size-4" />, "Setup") },
        ]}
        className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-2"
      />

      <div
        role="tabpanel"
        aria-label={tab[0].toUpperCase() + tab.slice(1)}
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
        {tab === "overview" && (
          <OverviewTab
            calls={calls}
            tools={tools}
            now={now}
            onOpenSetup={() => switchTab("setup")}
          />
        )}
        {tab === "calls" && <CallsTab calls={calls} now={now} live={live} onSelect={setSelected} />}
        {tab === "tools" && <ToolsTab tools={tools} endpoint={endpoint} wire={wire} />}
        {tab === "setup" && <SetupTab endpoint={endpoint} port={port} />}
      </div>

      <CallDialog call={selected} now={now} onClose={() => setSelected(null)} />
    </div>
  );
}

/** Reads the same contract the server answers `tools/list` with, so the Tools
 * tab can't drift from what is actually exposed. */
function useMcpToolDocs(): { tools: McpToolDoc[] | null; reload: () => void } {
  const [tools, setTools] = useState<McpToolDoc[] | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    void ipcOr(invoke<McpToolDoc[]>("mcp_tool_docs", {}, { schema: McpToolDocsSchema }), null).then(
      setTools,
    );
  }, [nonce]);

  return { tools, reload: () => setNonce((n) => n + 1) };
}
