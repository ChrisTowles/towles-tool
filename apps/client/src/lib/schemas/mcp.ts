import { z } from "zod";

/** Runtime validator for `mcp_tool_docs` (`screens/mcp.tsx`) — the MCP
 * contract's JSON Schema tool list (`tt_mcp::tool_definitions`), worth
 * catching a shape drift on since it's rendered directly as documentation. */

const McpToolParamSchema = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const McpToolDocSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.string(),
    properties: z.record(z.string(), McpToolParamSchema).default({}),
    required: z.array(z.string()).default([]),
  }),
  title: z.string().optional(),
  /** MCP's own tool annotations. The server states every hint on every tool,
   * since the spec reads an omitted one as the risky answer. */
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});

export const McpToolDocsSchema = z.array(McpToolDocSchema);

export type McpToolDoc = z.infer<typeof McpToolDocSchema>;

/** Runtime validator for `mcp_status` — whether *this* instance won the bind
 * race for the MCP port, which port that is, and what the server speaks. */
export const McpStatusSchema = z.object({
  serving: z.boolean(),
  port: z.number(),
  protocolVersion: z.string(),
  version: z.string(),
});

export type McpStatus = z.infer<typeof McpStatusSchema>;

/** Runtime validator for `mcp_test_call` — what one real round-trip against the
 * MCP endpoint came back with. A refusal is a result to display, not an error:
 * the point is seeing what a client would see. `sentOrigin` records whether the
 * request deliberately carried an `Origin` header. */
export const McpTestResultSchema = z.object({
  status: z.number(),
  body: z.string(),
  durationMs: z.number(),
  sentOrigin: z.boolean(),
});

export type McpTestResult = z.infer<typeof McpTestResultSchema>;
