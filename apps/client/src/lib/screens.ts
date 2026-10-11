import {
  BroadcastIcon,
  ChartBarIcon,
  ChatCircleIcon,
  GearIcon,
  KanbanIcon,
  LightningIcon,
  PulseIcon,
  StethoscopeIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";

export type ScreenId =
  | "agentboard"
  | "board"
  | "slack"
  | "doctor"
  | "claude-sessions"
  | "mcp"
  | "telemetry"
  | "task-explorer"
  | "settings";

export type ScreenMeta = {
  id: ScreenId;
  title: string;
  icon: Icon;
  /** Extra terms the command palette matches on. */
  keywords: string[];
  /** Render without the centered/scrolling content wrapper (e.g. terminals). */
  fullBleed?: boolean;
};

export const SCREENS: Record<ScreenId, ScreenMeta> = {
  agentboard: {
    id: "agentboard",
    title: "Agent Board",
    icon: TerminalWindowIcon,
    keywords: [
      "agentboard",
      "home",
      "queue",
      "next up",
      "focus",
      "zone",
      "agents",
      "terminal",
      "sessions",
      "shell",
      "repos",
      "checkouts",
      "worktrees",
      "tree",
      "rail",
    ],
    fullBleed: true,
  },
  board: {
    id: "board",
    title: "Board",
    icon: KanbanIcon,
    keywords: ["kanban", "todos", "tasks", "issues", "backlog"],
    fullBleed: true,
  },
  slack: {
    id: "slack",
    title: "Messages",
    icon: ChatCircleIcon,
    keywords: ["slack", "dm", "chat", "message", "danielle", "wife"],
    fullBleed: true,
  },
  doctor: {
    id: "doctor",
    title: "Doctor",
    icon: StethoscopeIcon,
    keywords: ["health", "checks", "tools"],
  },
  "claude-sessions": {
    id: "claude-sessions",
    title: "Claude Sessions",
    icon: ChartBarIcon,
    keywords: ["tokens", "usage", "sessions", "claude code", "history", "repos"],
    fullBleed: true,
  },
  mcp: {
    id: "mcp",
    title: "MCP server",
    icon: BroadcastIcon,
    keywords: ["mcp", "server", "calls", "tools", "json-rpc", "protocol", "incoming"],
    fullBleed: true,
  },
  telemetry: {
    id: "telemetry",
    title: "Telemetry",
    icon: LightningIcon,
    keywords: ["events", "otel", "telemetry", "spans", "log", "tracing", "attention", "focus"],
    fullBleed: true,
  },
  "task-explorer": {
    id: "task-explorer",
    title: "Task Explorer",
    icon: PulseIcon,
    keywords: ["system", "process", "processes", "cpu", "memory", "ram", "monitor", "activity"],
    fullBleed: true,
  },
  settings: {
    id: "settings",
    title: "Settings",
    icon: GearIcon,
    keywords: [
      "preferences",
      "config",
      "appearance",
      "theme",
      "collectors",
      "journal",
      "shortcuts",
      "about",
      "editor",
    ],
    fullBleed: true,
  },
};

export const NAV_SECTIONS: { label: string; screens: ScreenId[] }[] = [
  // Agent Board leads: it's where the work actually happens, and it's the
  // cold-start screen (`COLD_START_TAB`) — the sidebar order has to agree.
  { label: "Focus", screens: ["agentboard", "board", "slack"] },
  {
    label: "Tools",
    screens: ["doctor", "claude-sessions", "mcp", "telemetry", "task-explorer"],
  },
  { label: "App", screens: ["settings"] },
];

/** Agent Board's two rails over the same panes: tasks worked one at a time, or
 * every repo → checkout → session by place. */
export type RailView = "queue" | "tree";
