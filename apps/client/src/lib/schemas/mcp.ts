import { Effect, Schema } from "effect";
import { list } from "@/lib/schemas/shape";

/** Runtime validator for `mcp_tool_docs` (`screens/mcp.tsx`) — the MCP
 * contract's JSON Schema tool list (`tt_mcp::tool_definitions`), worth
 * catching a shape drift on since it's rendered directly as documentation. */

const McpToolParamSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enum: Schema.optional(list(Schema.String)),
});

const McpToolDocSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Struct({
    type: Schema.String,
    properties: Schema.Record(Schema.String, McpToolParamSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    required: list(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  title: Schema.optional(Schema.String),
  /** MCP's own tool annotations. The server states every hint on every tool,
   * since the spec reads an omitted one as the risky answer. */
  annotations: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      readOnlyHint: Schema.optional(Schema.Boolean),
      destructiveHint: Schema.optional(Schema.Boolean),
      idempotentHint: Schema.optional(Schema.Boolean),
      openWorldHint: Schema.optional(Schema.Boolean),
    }),
  ),
});

export const McpToolDocsSchema = list(McpToolDocSchema);

export type McpToolDoc = (typeof McpToolDocsSchema.Type)[number];

/** Runtime validator for `mcp_status` — whether *this* instance won the bind
 * race for the MCP port, which port that is, and what the server speaks. */
export const McpStatusSchema = Schema.Struct({
  serving: Schema.Boolean,
  port: Schema.Number,
  ignoredStamp: Schema.NullOr(Schema.Number),
  protocolVersion: Schema.String,
  version: Schema.String,
});

export type McpStatus = typeof McpStatusSchema.Type;

/** Runtime validator for `mcp_test_call` — what one real round-trip against the
 * MCP endpoint came back with. A refusal is a result to display, not an error:
 * the point is seeing what a client would see. `sentOrigin` records whether the
 * request deliberately carried an `Origin` header. */
export const McpTestResultSchema = Schema.Struct({
  status: Schema.Number,
  body: Schema.String,
  durationMs: Schema.Number,
  sentOrigin: Schema.Boolean,
});

export type McpTestResult = typeof McpTestResultSchema.Type;
