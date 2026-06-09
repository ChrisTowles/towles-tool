import { createSignal, For, Show, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionData, Theme } from "../../runtime/index";
import { truncate } from "../../runtime/index";
import { UNSEEN_ICON, BOLD, DIM, toneColor } from "../constants";
import { DiffStats } from "./DiffStats";
import { shortModel } from "./short-model";
import { formatElapsed } from "./elapsed";
import { liveStatusIcon, unseenTerminalColor } from "./status-visuals";
import { familyColor } from "./family-color";

// Non-nullable `details` of a single agent row — used to type `<Show>` render-prop accessors.
type AgentRowDetails = NonNullable<SessionData["agents"][number]["details"]>;

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
  const truncBranch = () => (props.session.branch ? truncate(props.session.branch, 45) : "");

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
    if (props.isFocused) return P().surface0;
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
          <box flexDirection="row" height={1}>
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
            <Show when={hasDiff()}>
              <box flexShrink={0} paddingLeft={1}>
                <DiffStats session={props.session} palette={() => P()} />
              </box>
            </Show>
            <box width={3} flexShrink={0}>
              <Show when={statusIcon()}>
                <text>
                  <span style={{ fg: statusColor() }}>
                    {" "}
                    {statusIcon()}
                    {runningAgents() > 1 ? String(runningAgents()) : ""}
                  </span>
                </text>
              </Show>
            </box>
          </box>

          <Show when={props.session.branch}>
            <box flexDirection="row" height={1}>
              <text truncate flexShrink={1}>
                <span style={{ fg: props.isFocused ? P().pink : P().overlay0 }}>
                  {truncBranch()}
                </span>
              </text>
            </box>
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

  const cacheLabel = () => {
    const details = props.agent.details;
    if (!details) return null;
    const expiresAt =
      details.cacheExpiresAt ??
      (details.lastActivityAt != null ? details.lastActivityAt + 60 * 60 * 1000 : null);
    if (expiresAt == null) return null;
    const minutesLeft = Math.ceil((expiresAt - props.now()) / 60_000);
    return minutesLeft <= 0 ? "cache expired" : `cache ${minutesLeft}m`;
  };

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
    if (isFlash()) return P().surface2;
    if (props.isKeyboardFocused) return P().surface1;
    return "transparent";
  };

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={bgColor()}
      onMouseDown={(event) => {
        if (event.target?.id === "dismiss") return;
        // Stop the click bubbling to SessionCard's onSelect, which would fire
        // switch-session and clobber the precise pane that onFocusPane selects.
        event.stopPropagation();
        triggerFlash();
        props.onFocusPane();
      }}
    >
      <box flexDirection="row" height={1}>
        <text flexShrink={0}>
          <span style={{ fg: color() }}>{icon()}</span>
        </text>
        <text flexGrow={1} flexShrink={1} truncate>
          <Show when={props.agent.threadName}>
            <span style={{ fg: isUnseen() ? color() : P().overlay0 }}>
              {" "}
              {truncate(props.agent.threadName!.replace(/\s+/g, " ").trim(), 40)}
            </span>
          </Show>
        </text>
        <Show when={props.agent.status === "running" && props.agent.details?.lastActivityAt}>
          <text flexShrink={0}>
            <span
              style={{
                fg: props.isKeyboardFocused ? P().subtext0 : P().overlay1,
                attributes: DIM,
              }}
            >
              {" "}
              {formatElapsed(props.now() - (props.agent.details?.lastActivityAt ?? props.now()))}
            </span>
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

      <Show when={props.agent.status === "running" && props.agent.details}>
        {(d: Accessor<AgentRowDetails>) => {
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

      <Show when={props.agent.status === "running" && props.agent.details?.subagents?.length}>
        {(_count: Accessor<number>) => {
          const subagents = () => props.agent.details?.subagents ?? [];
          return (
            <>
              <text truncate>
                <span style={{ fg: P().mauve, attributes: DIM }}>⚡ </span>
                <span style={{ fg: P().subtext0 }}>
                  {subagents().length} agent{subagents().length === 1 ? "" : "s"}
                </span>
              </text>
              <For each={subagents()}>
                {(sa) => (
                  <text truncate>
                    <span style={{ fg: P().overlay0, attributes: DIM }}>{"  ↳ "}</span>
                    <Show when={sa.agentType}>
                      <span style={{ fg: P().teal, attributes: DIM }}>{sa.agentType}</span>
                    </Show>
                    <Show when={sa.description}>
                      <span style={{ fg: P().overlay0, attributes: DIM }}>
                        {sa.agentType ? " · " : ""}
                      </span>
                      <span style={{ fg: P().subtext0 }}>
                        {truncate(sa.description!.replace(/\s+/g, " ").trim(), 40)}
                      </span>
                    </Show>
                  </text>
                )}
              </For>
            </>
          );
        }}
      </Show>

      <Show
        when={
          props.agent.details?.loop && props.agent.details.loop.nextWakeAt > props.now()
            ? props.agent.details.loop
            : undefined
        }
      >
        {(loop: Accessor<NonNullable<AgentRowDetails["loop"]>>) => (
          <text truncate>
            <span style={{ fg: P().lavender, attributes: DIM }}>⟳ </span>
            <span style={{ fg: P().subtext0 }}>
              loops in {formatElapsed(loop().nextWakeAt - props.now())}
            </span>
            <Show when={loop().reason}>
              <span style={{ fg: P().overlay0, attributes: DIM }}>
                {" · "}
                {truncate(loop().reason!.replace(/\s+/g, " ").trim(), 36)}
              </span>
            </Show>
          </text>
        )}
      </Show>

      <Show when={cacheLabel()}>
        <text truncate>
          <span style={{ fg: P().overlay0, attributes: DIM }}>{cacheLabel()}</span>
        </text>
      </Show>
    </box>
  );
}
