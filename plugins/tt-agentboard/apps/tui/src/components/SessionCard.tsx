import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionData, Theme } from "@tt-agentboard/runtime";
import { SPINNERS, UNSEEN_ICON, BOLD, DIM, toneColor } from "../constants";
import { DiffStats } from "./DiffStats";

export interface SessionCardProps {
  session: SessionData;
  index: number;
  isFocused: boolean;
  isCurrent: boolean;
  spinIdx: Accessor<number>;
  theme: Accessor<Theme>;
  statusColors: Accessor<Theme["status"]>;
  onSelect: () => void;
}

export function SessionCard(props: SessionCardProps) {
  const P = () => props.theme().palette;
  const SC = () => props.statusColors();

  const status = () => props.session.agentState?.status ?? "idle";
  const unseen = () => props.session.unseen;

  const isUnseenTerminal = () => unseen() && ["done", "error", "interrupted"].includes(status());

  const accentColor = () => {
    if (props.isCurrent) return P().green;
    if (isUnseenTerminal()) return unseenAccentColor();
    const s = status();
    if (s === "error") return P().red;
    if (s === "interrupted") return P().peach;
    if (s === "running") return P().yellow;
    if (props.isFocused) return P().lavender;
    return "transparent";
  };

  const unseenAccentColor = () => {
    const s = status();
    if (s === "error") return P().red;
    if (s === "interrupted") return P().peach;
    return P().teal;
  };

  const statusIcon = () => {
    const s = status();
    if (s === "running") return SPINNERS[props.spinIdx() % SPINNERS.length]!;
    if (isUnseenTerminal()) return UNSEEN_ICON;
    return "";
  };

  const statusColor = () => {
    if (isUnseenTerminal()) return unseenAccentColor();
    return SC()[status()];
  };

  const nameColor = () => {
    if (props.isFocused) return P().text;
    if (props.isCurrent) return P().subtext1;
    return P().subtext0;
  };

  const indexColor = () => {
    if (props.isFocused) return P().subtext0;
    return P().surface2;
  };

  const truncName = () => {
    const n = props.session.name;
    return n.length > 18 ? n.slice(0, 17) + "…" : n;
  };

  const truncBranch = () => {
    const b = props.session.branch;
    if (!b) return "";
    return b.length > 30 ? b.slice(0, 29) + "…" : b;
  };

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

  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        flexDirection="row"
        backgroundColor={bgColor()}
        onMouseDown={props.onSelect}
        paddingLeft={1}
      >
        {/* Left accent — space-preserving, only colored for meaningful states */}
        <text style={{ fg: accentColor() }}>{accentColor() === "transparent" ? " " : "▌"}</text>

        {/* Index */}
        <box width={3} flexShrink={0}>
          <text style={{ fg: indexColor() }}>{String(props.index).padStart(2)}</text>
        </box>

        {/* Content */}
        <box flexDirection="column" flexGrow={1} paddingRight={1}>
          {/* Row 1: name + status */}
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
                <span style={{ fg: statusColor() }}> {statusIcon()}</span>
              </text>
            </Show>
          </box>

          {/* Row 2: branch */}
          <Show when={props.session.branch}>
            <text truncate>
              <span style={{ fg: props.isFocused ? P().pink : P().overlay0 }}>{truncBranch()}</span>
            </text>
          </Show>

          {/* Row 3: git diff stats */}
          <Show when={hasDiff()}>
            <DiffStats session={props.session} palette={() => P()} />
          </Show>

          {/* Row 3: metadata summary (status + progress) */}
          <Show when={metaSummary()}>
            <text truncate>
              <span style={{ fg: toneColor(metaTone(), P()), attributes: DIM }}>
                {metaSummary()}
              </span>
            </text>
          </Show>
        </box>
      </box>

      {/* Breathing room — 1 empty line between cards */}
      <box height={1} />
    </box>
  );
}
