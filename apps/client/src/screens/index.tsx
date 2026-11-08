import { lazy, type ComponentType } from "react";
import type { ScreenId } from "@/lib/screens";
import { AgentBoardScreen } from "@/screens/agentboard";

// Every screen but the landing one loads on first visit; `App` mounts each in a
// Suspense boundary and keeps it mounted afterwards, so this changes only when
// the code arrives, not the keep-mounted behavior.
export const SCREEN_COMPONENTS: Record<ScreenId, ComponentType> = {
  agentboard: AgentBoardScreen,
  board: lazy(() => import("@/screens/board").then((m) => ({ default: m.BoardScreen }))),
  slack: lazy(() => import("@/screens/slack").then((m) => ({ default: m.SlackScreen }))),
  doctor: lazy(() => import("@/screens/doctor").then((m) => ({ default: m.DoctorScreen }))),
  "claude-sessions": lazy(() =>
    import("@/screens/claude-sessions").then((m) => ({ default: m.ClaudeSessionsScreen })),
  ),
  mcp: lazy(() => import("@/screens/mcp").then((m) => ({ default: m.McpScreen }))),
  telemetry: lazy(() =>
    import("@/screens/telemetry").then((m) => ({ default: m.TelemetryScreen })),
  ),
  "task-explorer": lazy(() =>
    import("@/screens/task-explorer").then((m) => ({ default: m.TaskExplorerScreen })),
  ),
  settings: lazy(() => import("@/screens/settings").then((m) => ({ default: m.SettingsScreen }))),
};
