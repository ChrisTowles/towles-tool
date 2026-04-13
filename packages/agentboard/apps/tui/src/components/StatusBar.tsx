import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { Theme } from "@tt-agentboard/runtime";
import { BOLD } from "../constants";

export interface StatusBarProps {
  sessionCount: number;
  runningCount: number;
  errorCount: number;
  unseenCount: number;
  theme: Accessor<Theme>;
}

export function StatusBar(props: StatusBarProps) {
  const P = () => props.theme().palette;

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
    </box>
  );
}
