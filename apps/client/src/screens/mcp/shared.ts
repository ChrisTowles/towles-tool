import { useEffect } from "react";
import { uiAction } from "@/lib/ui-action";

/** What a request must say about itself (MCP 2026-07-28 has no handshake):
 * the protocol version, from the backend so it can never drift, and this
 * app's version as the tester's own identity. */
export type McpWire = { protocolVersion: string; version: string };

/** One settled event per search, never one per keystroke — continuous input
 * is excluded from the event log. */
export function useSearchTelemetry(query: string, action: string) {
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => uiAction(action, "mcp"), 400);
    return () => clearTimeout(t);
  }, [query, action]);
}
