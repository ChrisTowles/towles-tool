import { Show, For } from "solid-js";
import type { Accessor } from "solid-js";
import type { Theme } from "@tt-agentboard/runtime";
import { STATUS_ICONS } from "@tt-agentboard/runtime";
import { BOLD } from "../constants";

export interface SessionStatusCounts {
  active: number;
  error: number;
  idle: number;
}

export interface StatusBarProps {
  sessionCount: number;
  runningCount: number;
  errorCount: number;
  unseenCount: number;
  sessionStatusCounts: SessionStatusCounts;
  theme: Accessor<Theme>;
}

interface BadgeConfig {
  label: string;
  count: number;
  color: (p: Theme["palette"]) => string;
  icon: string;
}

export function StatusBar(props: StatusBarProps) {
  const P = () => props.theme().palette;

  const badges = (): BadgeConfig[] => {
    const counts = props.sessionStatusCounts;
    const all: BadgeConfig[] = [
      { label: "active", count: counts.active, color: (p) => p.green, icon: STATUS_ICONS.running },
      { label: "error", count: counts.error, color: (p) => p.red, icon: STATUS_ICONS.error },
      { label: "idle", count: counts.idle, color: (p) => p.surface2, icon: STATUS_ICONS.idle },
    ];
    return all.filter((b) => b.count > 0);
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={0} flexShrink={0}>
      <text>
        <span style={{ fg: P().mauve, attributes: BOLD }}>{"  AgentBoard"}</span>
      </text>
      <text>
        <span style={{ fg: P().overlay1 }}>{"  "}</span>
        <span style={{ fg: P().overlay0 }}>{props.sessionCount}s</span>
        <Show when={props.runningCount > 0}>
          <span style={{ fg: P().yellow }}>
            {" "}
            {"⚡"}
            {props.runningCount}
          </span>
        </Show>
        <Show when={props.errorCount > 0}>
          <span style={{ fg: P().red }}>
            {" "}
            {"✗"}
            {props.errorCount}
          </span>
        </Show>
        <Show when={props.unseenCount > 0}>
          <span style={{ fg: P().teal }}>
            {" "}
            {"●"}
            {props.unseenCount}
          </span>
        </Show>
      </text>
      <Show when={badges().length > 0}>
        <text>
          <span style={{ fg: P().overlay1 }}>{"  "}</span>
          <For each={badges()}>
            {(badge, i) => (
              <>
                <Show when={i() > 0}>
                  <span style={{ fg: P().surface2 }}> </span>
                </Show>
                <span style={{ fg: badge.color(P()) }}>
                  {badge.icon} {badge.count} {badge.label}
                </span>
              </>
            )}
          </For>
        </text>
      </Show>
    </box>
  );
}
