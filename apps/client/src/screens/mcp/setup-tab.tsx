import { CopyIcon } from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Button } from "@cloudflare/kumo";
import { Card } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";

const pluginMcpJson = (endpoint: string) => `{
  "mcpServers": {
    "towles-tool": { "type": "http", "url": "${endpoint}" }
  }
}`;

/** The plugin ships the `.mcp.json` that points at the server, so the common
 * case is "enable the plugin" and the manual commands are the fallback. No
 * token: the listener is bound to 127.0.0.1. */
export function SetupTab({ endpoint, port }: { endpoint: string; port: number }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Endpoint">
        <p className="mb-3 text-xs text-kumo-subtle">
          The app serves MCP over loopback HTTP. Nothing to start by hand and no token — the
          listener is bound to 127.0.0.1.
        </p>
        <CopyBlock value={endpoint} />
        <p className="mt-2 text-mini text-kumo-subtle">
          Port defaults to {port}; set <span className="font-mono">mcp.port</span> in the settings
          file to change it.
        </p>
      </Card>

      <Card title="Connect a client">
        <SetupStep
          title="Claude Code (recommended)"
          detail="Enable the towles-tool-app plugin — it ships the .mcp.json below."
          command="claude plugin marketplace add ChrisTowles/towles-tool && claude plugin enable towles-tool-app@towles-tool"
        />
        <SetupStep
          title="Claude Code, manual"
          detail="Registers the HTTP server at user scope, without the plugin."
          command={`claude mcp add --scope user --transport http towles-tool ${endpoint}`}
        />
        <SetupStep
          title="Any MCP client"
          detail="What the plugin ships; merge it into your client's config."
          command={pluginMcpJson(endpoint)}
          block
        />
        <p className="px-3 py-2 text-xs text-kumo-subtle">
          Verify with <span className="font-mono">claude mcp list</span> — calls appear on the Calls
          tab as they arrive.
        </p>
      </Card>
    </div>
  );
}

function SetupStep({
  title,
  detail,
  command,
  block = false,
}: {
  title: string;
  detail: string;
  command: string;
  block?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-foreground">{title}</span>
        <span className="text-mini text-kumo-subtle">{detail}</span>
      </div>
      <CopyBlock value={command} block={block} />
    </div>
  );
}

function CopyBlock({ value, block = false }: { value: string; block?: boolean }) {
  async function copy() {
    uiAction("mcp.setup.copy", "mcp");
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="flex items-start gap-1 rounded-md border border-kumo-hairline bg-background px-3 py-1.5">
      <pre
        className={cn(
          "min-w-0 flex-1 self-center overflow-x-auto font-mono text-xs text-foreground",
          !block && "whitespace-nowrap",
        )}
      >
        {value}
      </pre>
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        className="shrink-0 text-kumo-subtle"
        icon={<CopyIcon className="size-3.5" />}
        onClick={copy}
        title="Copy"
        aria-label="Copy"
      />
    </div>
  );
}
