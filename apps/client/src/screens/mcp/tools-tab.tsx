import { useMemo, useState } from "react";
import { MagnifyingGlassIcon, PlayIcon } from "@phosphor-icons/react";
import { Button, Input } from "@cloudflare/kumo";
import { Card, Empty } from "@/components/store-bits";
import { uiAction } from "@/lib/ui-action";
import type { McpToolDoc } from "@/lib/schemas/mcp";
import { McpWire, useSearchTelemetry } from "@/screens/mcp/shared";
import { ToolTesterDialog } from "@/screens/mcp/tool-tester";

/** Tools are named `<family>_<verb>`, so the prefix groups them without
 * hardcoding any tool name — a new family shows up here on its own. */
function toolFamily(name: string): string {
  const i = name.indexOf("_");
  return i === -1 ? name : name.slice(0, i);
}

function groupTools(tools: McpToolDoc[]): { family: string; tools: McpToolDoc[] }[] {
  const groups: { family: string; tools: McpToolDoc[] }[] = [];
  for (const tool of tools) {
    const family = toolFamily(tool.name);
    const group = groups.find((g) => g.family === family);
    if (group) group.tools.push(tool);
    else groups.push({ family, tools: [tool] });
  }
  return groups;
}

/** Straight from the MCP contract, never hand-maintained. */
export function ToolsTab({
  tools,
  endpoint,
  wire,
}: {
  tools: McpToolDoc[] | null;
  endpoint: string;
  wire: McpWire;
}) {
  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState<McpToolDoc | null>(null);

  useSearchTelemetry(query, "mcp.tools.search");

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (tools === null) return [];
    const shown = q
      ? tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q))
      : tools;
    return groupTools(shown);
  }, [tools, q]);

  if (tools === null) {
    return (
      <Card title="Tools">
        <Empty inline>Not available outside the app.</Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative w-72">
        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-kumo-subtle" />
        <Input
          aria-label="Search tools"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tools…"
          size="sm"
          className="pl-8"
        />
      </div>

      {groups.length === 0 ? (
        <Card title="Tools">
          <Empty inline>No tools match.</Empty>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.family} title={group.family} note={`${group.tools.length}`}>
            <div className="-mx-1.5 flex flex-col">
              {group.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      icon={<PlayIcon className="size-3" />}
                      onClick={() => {
                        uiAction("mcp.tool.test_open", "mcp", tool.name);
                        setTesting(tool);
                      }}
                    >
                      Test
                    </Button>
                  }
                />
              ))}
            </div>
          </Card>
        ))
      )}

      <ToolTesterDialog
        tool={testing}
        endpoint={endpoint}
        wire={wire}
        onClose={() => setTesting(null)}
      />
    </div>
  );
}

/** Read off `annotations.readOnlyHint`, never off the description's wording:
 * the warning this drives is the only signal before a write. Strictly
 * `=== false` — an absent hint is "no claim made", not "read-only". */
export function isMutating(tool: McpToolDoc): boolean {
  return tool.annotations?.readOnlyHint === false;
}

/** `actions` is a sibling of the identity cluster, not a child, so a per-tool
 * control drops in without nesting interactive elements — see
 * apps/client/CLAUDE.md's clickable-rows rule. */
function ToolRow({ tool, actions }: { tool: McpToolDoc; actions?: React.ReactNode }) {
  const params = Object.entries(tool.inputSchema.properties);
  return (
    <div className="flex items-start gap-2 rounded-md px-3 py-2.5 hover:bg-accent/50">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-foreground">{tool.name}</span>
          {tool.title && <span className="text-xs text-kumo-subtle">{tool.title}</span>}
        </div>
        <p className="text-xs text-kumo-subtle">{tool.description}</p>
        {params.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            {params.map(([name, schema]) => {
              const required = tool.inputSchema.required.includes(name);
              return (
                <span
                  key={name}
                  className="font-mono text-mini text-kumo-subtle/80"
                  title={schema.description}
                >
                  {name}
                  {required ? "" : "?"}
                  {schema.type && <span className="text-kumo-subtle/50">:{schema.type}</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
