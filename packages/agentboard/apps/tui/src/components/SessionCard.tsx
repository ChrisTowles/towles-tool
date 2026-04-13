import { createSignal, For, Show, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type { AgentStatus, SessionData, Theme } from "@tt-agentboard/runtime";
import { truncate } from "@tt-agentboard/runtime";
import { UNSEEN_ICON, BOLD, DIM, toneColor } from "../constants";
import { DiffStats } from "./DiffStats";
import { shortModel } from "./cache-bar";
import { formatElapsed } from "./elapsed";
import { liveStatusIcon, unseenTerminalColor } from "./status-visuals";
import { familyColor } from "./family-color";

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "",
  running: "running",
  done: "done",
  error: "error",
  waiting: "waiting",
  question: "question",
  interrupted: "stopped",
};

export interface SessionCardProps {
  session: SessionData;
  isFocused: boolean;
  isCurrent: boolean;
  spinIdx: Accessor<number>;
  now: Accessor<number>;
  theme: Accessor<Theme>;
  statusColors: Accessor<Theme["status"]>;
  focusedAgentIdx: number;
  onSelect: () => void;
  onDismissAgent: (agent: SessionData["agents"][number]) => void;
  onFocusAgentPane: (agent: SessionData["agents"][number]) => void;
}

export function SessionCard(props: SessionCardProps) {
  const P = () => props.theme().palette;
  const SC = () => props.statusColors();

  const status = () => props.session.agentState?.status ?? "idle";
  const unseen = () => props.session.unseen;
  const runningAgents = () =>
    props.session.agents?.filter((a) => a.status === "running").length ?? 0;

  const isUnseenTerminal = () => unseen() && ["done", "error", "interrupted"].includes(status());

  const accentColor = () => {
    if (props.isCurrent) return P().green;
    if (isUnseenTerminal()) return unseenTerminalColor(status(), P());
    const s = status();
    if (s === "error") return P().red;
    if (s === "interrupted") return P().peach;
    if (s === "running") return P().yellow;
    if (s === "waiting") return P().blue;
    if (s === "question") return P().green;
    if (props.isFocused) return P().lavender;
    return "transparent";
  };

  const statusIcon = () => {
    const live = liveStatusIcon(status(), props.spinIdx());
    if (live) return live;
    return isUnseenTerminal() ? UNSEEN_ICON : "";
  };

  const statusColor = () => {
    if (isUnseenTerminal()) return unseenTerminalColor(status(), P());
    return SC()[status()];
  };

  const familyHue = () => familyColor(props.session.name, P());

  const nameColor = () => {
    if (props.isFocused) return P().text;
    if (props.isCurrent) return P().subtext1;
    return familyHue();
  };

  const truncName = () => truncate(props.session.name, 18);
  const truncBranch = () => (props.session.branch ? truncate(props.session.branch, 30) : "");

  const hasDiff = () => {
    const { linesAdded, linesRemoved, commitsDelta, filesChanged } = props.session;
    return !!(linesAdded || linesRemoved || commitsDelta || filesChanged);
  };

  const metaSummary = () => {
    const meta = props.session.metadata;
    if (!meta) return "";
    const parts: string[] = [];
    if (meta.status) parts.push(meta.status.text);
    if (meta.progress) {
      if (meta.progress.current != null && meta.progress.total != null) {
        parts.push(`${meta.progress.current}/${meta.progress.total}`);
      } else if (meta.progress.percent != null) {
        parts.push(`${Math.round(meta.progress.percent * 100)}%`);
      }
      if (meta.progress.label) parts.push(meta.progress.label);
    }
    return parts.join(" · ");
  };

  const metaTone = () => props.session.metadata?.status?.tone;

  const bgColor = () => {
    if (props.isFocused) return P().surface1;
    return "transparent";
  };

  const agents = () => props.session.agents ?? [];

  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        flexDirection="row"
        backgroundColor={bgColor()}
        onMouseDown={props.onSelect}
        paddingLeft={1}
      >
        <text style={{ fg: accentColor() }}>{accentColor() === "transparent" ? " " : "▌"}</text>

        <Show when={accentColor() === "transparent"}>
          <box width={1} flexShrink={0}>
            <text>
              <span style={{ fg: familyHue(), attributes: DIM }}>▎</span>
            </text>
          </box>
        </Show>

        <box flexDirection="column" flexGrow={1} paddingRight={1}>
          <box flexDirection="row">
            <text truncate flexGrow={1}>
              <span
                style={{
                  fg: nameColor(),
                  attributes: props.isFocused || props.isCurrent ? BOLD : undefined,
                }}
              >
                {truncName()}
              </span>
            </text>
            <Show when={statusIcon()}>
              <text flexShrink={0}>
                <span style={{ fg: statusColor() }}>
                  {" "}
                  {statusIcon()}
                  {runningAgents() > 1 ? String(runningAgents()) : ""}
                </span>
              </text>
            </Show>
          </box>

          <Show when={props.session.branch}>
            <text truncate>
              <span style={{ fg: props.isFocused ? P().pink : P().overlay0 }}>{truncBranch()}</span>
            </text>
          </Show>

          <Show when={hasDiff()}>
            <DiffStats session={props.session} palette={() => P()} />
          </Show>

          <Show when={metaSummary()}>
            <text truncate>
              <span style={{ fg: toneColor(metaTone(), P()), attributes: DIM }}>
                {metaSummary()}
              </span>
            </text>
          </Show>

          <For each={agents()}>
            {(agent, i) => (
              <AgentRow
                agent={agent}
                palette={P}
                statusColors={props.statusColors}
                spinIdx={props.spinIdx}
                now={props.now}
                isKeyboardFocused={i() === props.focusedAgentIdx}
                onDismiss={() => props.onDismissAgent(agent)}
                onFocusPane={() => props.onFocusAgentPane(agent)}
              />
            )}
          </For>
        </box>
      </box>

      <box height={1} />
    </box>
  );
}

interface AgentRowProps {
  agent: SessionData["agents"][number];
  palette: Accessor<Theme["palette"]>;
  statusColors: Accessor<Theme["status"]>;
  spinIdx: Accessor<number>;
  now: Accessor<number>;
  isKeyboardFocused: boolean;
  onDismiss: () => void;
  onFocusPane: () => void;
}

function AgentRow(props: AgentRowProps) {
  const P = () => props.palette();
  const SC = () => props.statusColors();
  const [isDismissHover, setIsDismissHover] = createSignal(false);
  const [isFlash, setIsFlash] = createSignal(false);

  const isTerminal = () => ["done", "error", "interrupted"].includes(props.agent.status);
  const isUnseen = () => isTerminal() && props.agent.unseen === true;

  const icon = () => {
    if (isUnseen()) return UNSEEN_ICON;
    if (isTerminal()) {
      if (props.agent.status === "done") return "✓";
      if (props.agent.status === "error") return "✗";
      return "⚠";
    }
    return liveStatusIcon(props.agent.status, props.spinIdx()) || "○";
  };

  const color = () => {
    if (isTerminal()) {
      if (isUnseen()) return unseenTerminalColor(props.agent.status, P());
      if (props.agent.status === "error") return P().red;
      if (props.agent.status === "interrupted") return P().peach;
      return P().green;
    }
    return SC()[props.agent.status];
  };

  const statusText = () => STATUS_TEXT[props.agent.status];

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerFlash = () => {
    setIsFlash(true);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setIsFlash(false), 150);
  };
  onCleanup(() => {
    if (flashTimer) clearTimeout(flashTimer);
  });

  const bgColor = () => {
    if (isFlash()) return P().surface1;
    if (props.isKeyboardFocused) return P().surface0;
    return "transparent";
  };

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={bgColor()}
      onMouseDown={(event) => {
        if (event.target?.id === "dismiss") return;
        triggerFlash();
        props.onFocusPane();
      }}
    >
      <box flexDirection="row">
        <text flexGrow={1} truncate>
          <span style={{ fg: color() }}>{icon()}</span>
          <Show when={props.agent.status === "running" && props.agent.details?.lastActivityAt}>
            <span
              style={{
                fg: props.isKeyboardFocused ? P().subtext0 : P().overlay1,
                attributes: DIM,
              }}
            >
              {" "}
              {formatElapsed(props.now() - (props.agent.details?.lastActivityAt ?? props.now()))}
            </span>
          </Show>
        </text>
        <Show when={!isUnseen()}>
          <text flexShrink={0}>
            <span style={{ fg: color(), attributes: DIM }}>{statusText()}</span>
          </text>
        </Show>
        <text
          flexShrink={0}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onDismiss();
          }}
          onMouseOver={() => setIsDismissHover(true)}
          onMouseOut={() => setIsDismissHover(false)}
        >
          <span style={{ fg: isDismissHover() ? P().red : P().overlay0 }}>{" ✕"}</span>
        </text>
      </box>

      <Show when={props.agent.threadName}>
        <text truncate>
          <span style={{ fg: isUnseen() ? color() : P().overlay0 }}>
            {props.agent.threadName!.replace(/\s+/g, " ").trim()}
          </span>
        </text>
      </Show>

      <Show when={props.agent.details}>
        {(d) => {
          const details = d();
          const model = () => (details.model ? shortModel(details.model) : "");
          const tool = () => details.lastTool;
          return (
            <Show when={model() || tool()}>
              <text truncate>
                <Show when={model()}>
                  <span style={{ fg: P().subtext0, attributes: DIM }}>{model()}</span>
                </Show>
                <Show when={tool()}>
                  <span style={{ fg: P().overlay0, attributes: DIM }}>{model() ? " · " : ""}</span>
                  <span style={{ fg: P().teal, attributes: DIM }}>⟶ </span>
                  <span style={{ fg: P().subtext0 }}>{tool()}</span>
                </Show>
              </text>
            </Show>
          );
        }}
      </Show>
    </box>
  );
}
