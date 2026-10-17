import {
  ChartBarIcon,
  DatabaseIcon,
  GaugeIcon,
  GitDiffIcon,
  KeyboardIcon,
  LightbulbIcon,
  RobotIcon,
  ScrollIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";

export const TELEMETRY_TABS = [
  {
    value: "overview",
    label: (
      <span className="flex items-center gap-2">
        <SquaresFourIcon className="size-4" />
        Overview
      </span>
    ),
  },
  {
    value: "dashboard",
    label: (
      <span className="flex items-center gap-2">
        <ChartBarIcon className="size-4" />
        Dashboard
      </span>
    ),
  },
  {
    value: "agents",
    label: (
      <span className="flex items-center gap-2">
        <RobotIcon className="size-4" />
        Agents
      </span>
    ),
  },
  {
    value: "builds",
    label: (
      <span className="flex items-center gap-2">
        <GitDiffIcon className="size-4" />
        Builds
      </span>
    ),
  },
  {
    value: "rules",
    label: (
      <span className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4" />
        Rules
      </span>
    ),
  },
  {
    value: "attention",
    label: (
      <span className="flex items-center gap-2">
        <GaugeIcon className="size-4" />
        Attention
      </span>
    ),
  },
  {
    value: "keyboard",
    label: (
      <span className="flex items-center gap-2">
        <KeyboardIcon className="size-4" />
        Keyboard
      </span>
    ),
  },
  {
    value: "query",
    label: (
      <span className="flex items-center gap-2">
        <DatabaseIcon className="size-4" />
        Query
      </span>
    ),
  },
  {
    value: "log",
    label: (
      <span className="flex items-center gap-2">
        <ScrollIcon className="size-4" />
        Log
      </span>
    ),
  },
  {
    value: "insights",
    label: (
      <span className="flex items-center gap-2">
        <LightbulbIcon className="size-4" />
        Insights
      </span>
    ),
  },
];
