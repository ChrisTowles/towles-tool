import { appendFileSync } from "node:fs";

export const DEBUG_LOG = "/tmp/agentboard-debug.log";
export const TUI_RESIZE_LOG = "/tmp/agentboard-tui-resize.log";
export const TUI_AGENT_CLICK_LOG = "/tmp/agentboard-tui-agent-click.log";
export const SERVER_ERR_LOG = "/tmp/agentboard-server-err.log";
export const INSTALL_LOG = "/tmp/agentboard-install.log";

const DEBUG_ENABLED = !!process.env.AGENTBOARD2_DEBUG;

export function debugLog(category: string, msg: string, data?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  const ts = new Date().toISOString().slice(11, 23);
  const extra = data ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${category}] ${msg}${extra}\n`;
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch {}
}
