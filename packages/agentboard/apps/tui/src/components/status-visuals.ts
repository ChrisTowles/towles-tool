import type { AgentStatus, Theme } from "@tt-agentboard/runtime";
import { SPINNERS } from "../constants";

/** Icon for a live (non-terminal) status. Returns "" for statuses without a glyph. */
export function liveStatusIcon(status: AgentStatus, spinIdx: number): string {
  if (status === "running") return SPINNERS[spinIdx % SPINNERS.length]!;
  if (status === "waiting") return "◉";
  if (status === "question") return "?";
  return "";
}

/** Accent color for a terminal agent whose final status the user hasn't seen yet. */
export function unseenTerminalColor(status: AgentStatus, palette: Theme["palette"]): string {
  if (status === "error") return palette.red;
  if (status === "interrupted") return palette.peach;
  return palette.teal;
}
