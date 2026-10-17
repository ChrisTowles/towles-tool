import { useEffect, useState } from "react";
import { CopyIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Button, Checkbox, Dialog, InputArea } from "@cloudflare/kumo";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { McpTestResultSchema, type McpTestResult, type McpToolDoc } from "@/lib/schemas/mcp";
import { McpWire } from "@/screens/mcp/shared";
import { isMutating } from "@/screens/mcp/tools-tab";

/** Issued **from Rust**, not by `fetch` here: the webview would carry an
 * `Origin` header and the server would correctly refuse it. The "as a browser
 * would" toggle re-sends *with* one so you can watch the refusal happen. */
export function ToolTesterDialog({
  tool,
  endpoint,
  wire,
  onClose,
}: {
  tool: McpToolDoc | null;
  endpoint: string;
  wire: McpWire;
  onClose: () => void;
}) {
  const [args, setArgs] = useState("{}");
  const [asBrowser, setAsBrowser] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<McpTestResult | null>(null);

  // `running` resets too: without it, switching tools mid-call leaves the new
  // tool's Run button permanently disabled reading "Running…".
  useEffect(() => {
    if (!tool) return;
    setArgs(skeletonArgs(tool));
    setResult(null);
    setAsBrowser(false);
    setRunning(false);
  }, [tool]);

  if (!tool) return null;

  async function run() {
    if (!tool) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (e) {
      toast.error(`Arguments must be valid JSON: ${errorMessage(e)}`);
      return;
    }
    // A slow call whose tool has since been switched away must not paint its
    // result into the new tool's identical-looking pane.
    const issuedFor = tool.name;
    setRunning(true);
    // Both facts, always: encoding one *or* the other lost the tool name for
    // exactly the runs where the security boundary was being exercised.
    uiAction("mcp.tool.test_run", "mcp", asBrowser ? `${tool.name} as-browser` : tool.name);
    const body = requestBody(tool.name, parsed, wire);
    const res = await invoke<McpTestResult>(
      "mcp_test_call",
      { body, simulateBrowserOrigin: asBrowser },
      { schema: McpTestResultSchema },
    );
    // `tool` is the current prop by the time this resolves; if it changed, this
    // reply belongs to a pane nobody is looking at.
    if (issuedFor !== tool?.name) return;
    setRunning(false);
    res.match({
      ok: setResult,
      err: (e) => toast.error(errorMessage(e)),
    });
  }

  async function copyCurl() {
    if (!tool) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (e) {
      toast.error(`Arguments must be valid JSON: ${errorMessage(e)}`);
      return;
    }
    uiAction("mcp.tool.copy_curl", "mcp", tool.name);
    // Safe to hand out precisely because `curl` sends no Origin header, which
    // the transport's DNS-rebinding guard is what refuses.
    const command = curlCommand(endpoint, tool.name, requestBody(tool.name, parsed, wire), wire);
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Copied curl command");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const mutating = isMutating(tool);
  const destructive = tool.annotations?.destructiveHint === true;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="xl" className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="font-mono text-sm">{tool.name}</Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">{tool.description}</Dialog.Description>
        </div>

        {mutating && (
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            <WarningCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {destructive
                ? "This tool deletes real data — the task's panes and its worktree — and cannot be undone."
                : "This tool writes real data. Running it changes your board or calendar."}
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="mcp-test-args" className="text-xs font-medium text-kumo-subtle">
            Arguments (JSON)
          </label>
          <InputArea
            id="mcp-test-args"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            spellCheck={false}
            rows={6}
            className="font-mono text-xs"
          />
        </div>

        <Checkbox
          checked={asBrowser}
          onCheckedChange={(v) => {
            uiAction("mcp.tool.as_browser", "mcp", v === true ? "on" : "off");
            setAsBrowser(v === true);
          }}
          label={
            <span className="text-xs text-kumo-subtle">
              Send as a browser would (adds an <span className="font-mono">Origin</span> header) —
              the server must refuse this
            </span>
          }
        />

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<PlayIcon className="size-3.5" />}
            onClick={() => void run()}
            disabled={running}
          >
            {running ? "Running…" : "Run tool"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<CopyIcon className="size-3.5" />}
            onClick={() => void copyCurl()}
          >
            Copy as curl
          </Button>
          {result && (
            <span className="text-xs text-kumo-subtle">
              HTTP {result.status} · {result.durationMs}ms
            </span>
          )}
        </div>

        {result && (
          <div className="flex flex-col gap-1.5">
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
                result.status === 200 ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger",
              )}
            >
              {result.status === 200
                ? "Accepted — the request reached the dispatcher."
                : result.sentOrigin
                  ? "Refused, as it should be: an Origin header means a web page sent it."
                  : "Refused before reaching the dispatcher."}
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-kumo-hairline bg-muted/40 p-2 font-mono text-mini whitespace-pre-wrap">
              {prettyJson(result.body)}
            </pre>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

/** The one body both the live test call and the copied curl command send. */
function requestBody(name: string, args: unknown, wire: McpWire): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": wire.protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "towles-tool-app", version: wire.version },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

/** `'\''` is the standard idiom, and the only sequence that needs handling
 * inside single quotes. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `Content-Type: application/json` is an admission requirement, the `Mcp-*`
 * headers must mirror the body, and `Accept` is the spec's rule for every
 * client; every part is shell-quoted so this pastes in verbatim. */
function curlCommand(endpoint: string, name: string, body: string, wire: McpWire): string {
  return [
    "curl -X POST",
    shellSingleQuote(endpoint),
    "-H 'Content-Type: application/json'",
    "-H 'Accept: application/json, text/event-stream'",
    `-H ${shellSingleQuote(`MCP-Protocol-Version: ${wire.protocolVersion}`)}`,
    "-H 'Mcp-Method: tools/call'",
    `-H ${shellSingleQuote(`Mcp-Name: ${name}`)}`,
    `-d ${shellSingleQuote(body)}`,
  ].join(" ");
}

/** Required properties only: a pre-filled optional is a value you didn't mean
 * to send. */
function skeletonArgs(tool: McpToolDoc): string {
  const required = tool.inputSchema.required ?? [];
  if (required.length === 0) return "{}";
  const seed: Record<string, unknown> = {};
  for (const name of required) {
    const type = tool.inputSchema.properties[name]?.type;
    seed[name] = type === "integer" || type === "number" ? 0 : type === "array" ? [] : "";
  }
  return JSON.stringify(seed, null, 2);
}

/** Falls back to raw text for the transport's plain-text refusal bodies. */
function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
