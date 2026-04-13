import { createSignal, For, Show, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type { MouseEvent } from "@opentui/core";
import type { SessionData, Theme } from "@tt-agentboard/runtime";
import { TUI_AGENT_CLICK_LOG } from "@tt-agentboard/runtime";
import { appendFileSync } from "node:fs";
import {
  SPINNERS,
  UNSEEN_ICON,
  BOLD,
  DIM,
  DIVIDER,
  SPARK_BLOCKS,
  TONE_ICONS,
  toneColor,
  logResizeDebug,
} from "../constants";

// --- Sparkline ---

export function buildSparkline(
  timestamps: number[],
  width: number,
  windowMs: number = 30 * 60 * 1000,
): string {
  if (timestamps.length === 0 || width <= 0) return "";
  const now = Date.now();
  const start = now - windowMs;
  const bucketSize = windowMs / width;
  const buckets = Array.from({ length: width }, () => 0);

  for (const ts of timestamps) {
    if (ts < start) continue;
    const idx = Math.min(width - 1, Math.floor((ts - start) / bucketSize));
    buckets[idx]++;
  }

  const max = Math.max(...buckets, 1);
  return buckets
    .map((count: number) => {
      const level = Math.round((count / max) * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[level];
    })
    .join("");
}

// --- Context / cache display helpers ---

const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 10;

function contextBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
}

function shortModel(model: string): string {
  if (!model) return "";
  const stripped = model.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
  return stripped;
}

function formatCacheRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "cold";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const hrs = Math.floor(min / 60);
    const rem = min % 60;
    return `${hrs}h${rem}m`;
  }
  return `${min}m${sec.toString().padStart(2, "0")}s`;
}

// --- Detail Panel ---

export interface DetailPanelProps {
  session: SessionData;
  theme: Accessor<Theme>;
  statusColors: Accessor<Theme["status"]>;
  spinIdx: Accessor<number>;
  focusedAgentIdx: number;
  onDismissAgent: (agent: SessionData["agents"][number]) => void;
  onFocusAgentPane: (agent: SessionData["agents"][number]) => void;
  isResizeHover: boolean;
  isResizing: boolean;
  onResizeStart: (event: MouseEvent) => void;
  onResizeDrag: (event: MouseEvent) => void;
  onResizeEnd: (event?: MouseEvent) => void;
  onResizeHoverChange: (hovered: boolean) => void;
}

export function DetailPanel(props: DetailPanelProps) {
  const P = () => props.theme().palette;

  const agents = () => props.session.agents ?? [];
  const hasAgents = () => agents().length > 0;
  const meta = () => props.session.metadata;
  const hasMeta = () => !!meta();
  const visibleLogs = () => {
    const m = meta();
    if (!m || m.logs.length === 0) return [];
    return m.logs.slice(-8);
  };

  const truncDir = () => {
    const d = props.session.dir;
    if (!d) return "";
    const home = process.env.HOME ?? "";
    const short = home && d.startsWith(home) ? "~" + d.slice(home.length) : d;
    return short.length > 24 ? "…" + short.slice(short.length - 23) : short;
  };

  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <box height={1}>
        <text
          selectable={false}
          onMouseDown={(event) => {
            logResizeDebug("separator:onMouseDown", {
              x: event.x,
              y: event.y,
              button: event.button,
              session: props.session.name,
            });
            event.preventDefault();
            props.onResizeStart(event);
          }}
          onMouseDrag={(event) => {
            logResizeDebug("separator:onMouseDrag", {
              x: event.x,
              y: event.y,
              button: event.button,
              session: props.session.name,
            });
            event.preventDefault();
            props.onResizeDrag(event);
          }}
          onMouseDragEnd={(event) => {
            logResizeDebug("separator:onMouseDragEnd", {
              x: event.x,
              y: event.y,
              button: event.button,
              session: props.session.name,
            });
            event.preventDefault();
            props.onResizeEnd(event);
          }}
          onMouseUp={(event) => {
            logResizeDebug("separator:onMouseUp", {
              x: event.x,
              y: event.y,
              button: event.button,
              session: props.session.name,
            });
            event.preventDefault();
            props.onResizeEnd(event);
          }}
          onMouseOver={() => props.onResizeHoverChange(true)}
          onMouseOut={() => {
            if (!props.isResizing) props.onResizeHoverChange(false);
          }}
          style={{
            fg: props.isResizing ? P().blue : props.isResizeHover ? P().overlay1 : P().surface2,
          }}
        >
          {DIVIDER}
        </text>
      </box>

      {/* Directory */}
      <text truncate>
        <span style={{ fg: P().overlay0, attributes: DIM }}>{truncDir()}</span>
      </text>

      {/* Agent instances */}
      <Show when={hasAgents()}>
        <For each={agents()}>
          {(agent, i) => (
            <AgentListItem
              agent={agent}
              palette={P}
              statusColors={props.statusColors}
              spinIdx={props.spinIdx}
              isKeyboardFocused={i() === props.focusedAgentIdx}
              onDismiss={() => props.onDismissAgent(agent)}
              onFocusPane={() => props.onFocusAgentPane(agent)}
            />
          )}
        </For>
      </Show>

      {/* Metadata: status, progress, logs */}
      <Show when={hasMeta()}>
        {(_) => {
          const m = meta()!;
          const progressText = () => {
            const p = m.progress;
            if (!p) return "";
            if (p.current != null && p.total != null) return `${p.current}/${p.total}`;
            if (p.percent != null) return `${Math.round(p.percent * 100)}%`;
            return "";
          };
          return (
            <box flexDirection="column">
              <box height={1} />

              {/* Status + progress on one line */}
              <Show when={m.status || m.progress}>
                <box flexDirection="row" paddingRight={1}>
                  <Show when={m.status}>
                    <text truncate flexGrow={1}>
                      <span style={{ fg: toneColor(m.status!.tone, P()) }}>
                        {TONE_ICONS[m.status!.tone ?? "neutral"]} {m.status!.text}
                      </span>
                    </text>
                  </Show>
                  <Show when={m.progress}>
                    <text flexShrink={0}>
                      <span style={{ fg: P().sky }}>
                        {m.status ? " · " : ""}
                        {progressText()}
                        {m.progress!.label ? ` ${m.progress!.label}` : ""}
                      </span>
                    </text>
                  </Show>
                </box>
              </Show>

              {/* Log entries */}
              <Show when={visibleLogs().length > 0}>
                <For each={visibleLogs()}>
                  {(entry) => (
                    <text truncate>
                      <span style={{ fg: toneColor(entry.tone, P()), attributes: DIM }}>
                        {TONE_ICONS[entry.tone ?? "neutral"]}
                      </span>
                      <Show when={entry.source}>
                        <span
                          style={{ fg: P().surface2, attributes: DIM }}
                        >{` [${entry.source}]`}</span>
                      </Show>
                      <span style={{ fg: P().overlay0 }}> {entry.message}</span>
                    </text>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Show>
    </box>
  );
}

// --- Agent List Item ---

interface AgentListItemProps {
  agent: SessionData["agents"][number];
  palette: Accessor<Theme["palette"]>;
  statusColors: Accessor<Theme["status"]>;
  spinIdx: Accessor<number>;
  isKeyboardFocused: boolean;
  onDismiss: () => void;
  onFocusPane: () => void;
}

function AgentListItem(props: AgentListItemProps) {
  const P = () => props.palette();
  const SC = () => props.statusColors();
  const [isDismissHover, setIsDismissHover] = createSignal(false);
  const [isFlash, setIsFlash] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // Tick every second while any details.cacheExpiresAt is in the future
  // (cheap; only runs while component is mounted)
  const ticker = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(ticker));

  const isTerminal = () => ["done", "error", "interrupted"].includes(props.agent.status);
  const isUnseen = () => isTerminal() && props.agent.unseen === true;

  const icon = () => {
    if (isUnseen()) return UNSEEN_ICON;
    if (isTerminal())
      return props.agent.status === "done" ? "✓" : props.agent.status === "error" ? "✗" : "⚠";
    if (props.agent.status === "running") return SPINNERS[props.spinIdx() % SPINNERS.length]!;
    if (props.agent.status === "waiting") return "◉";
    if (props.agent.status === "question") return "?";
    return "○";
  };

  const color = () => {
    if (isTerminal()) {
      if (props.agent.status === "error") return P().red;
      if (props.agent.status === "interrupted") return P().peach;
      return isUnseen() ? P().teal : P().green;
    }
    return SC()[props.agent.status];
  };

  const statusText = () => {
    if (props.agent.status === "running") return "running";
    if (props.agent.status === "done") return "done";
    if (props.agent.status === "error") return "error";
    if (props.agent.status === "interrupted") return "stopped";
    if (props.agent.status === "waiting") return "waiting";
    if (props.agent.status === "question") return "question";
    return "";
  };

  const triggerFlash = () => {
    setIsFlash(true);
    setTimeout(() => setIsFlash(false), 150);
  };

  const bgColor = () => {
    if (isFlash()) return P().surface1;
    if (props.isKeyboardFocused) return P().surface0;
    return "transparent";
  };

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      onMouseDown={(event) => {
        // Don't trigger focus if clicking the dismiss button
        if (event.target?.id === "dismiss") return;
        appendFileSync(
          TUI_AGENT_CLICK_LOG,
          `[${new Date().toISOString()}] clicked agent=${props.agent.agent} thread=${props.agent.threadName ?? "?"}\n`,
        );
        triggerFlash();
        props.onFocusPane();
      }}
    >
      <box height={1} />
      <box flexDirection="row" backgroundColor={bgColor()} paddingLeft={1}>
        {/* Content column — name row + thread name row */}
        <box flexDirection="column" flexGrow={1} paddingRight={1}>
          {/* Row 1: icon + agent name + status + dismiss */}
          <box flexDirection="row">
            <text flexGrow={1} truncate>
              <span style={{ fg: color() }}>{icon()}</span>
              <span
                style={{
                  fg: props.isKeyboardFocused ? P().text : P().subtext1,
                  attributes: props.isKeyboardFocused ? BOLD : undefined,
                }}
              >
                {" "}
                {props.agent.agent}
              </span>
            </text>
            <Show when={!isTerminal() || !isUnseen()}>
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

          {/* Row 2: thread name */}
          <Show when={props.agent.threadName}>
            <text truncate>
              <span style={{ fg: isUnseen() ? color() : P().overlay0 }}>
                {props.agent.threadName}
              </span>
            </text>
          </Show>

          {/* Row 3: context bar + model + cache countdown */}
          <Show when={props.agent.details}>
            {(d) => {
              const details = d();
              const pct = () =>
                details.contextUsed && details.contextMax
                  ? Math.round((details.contextUsed / details.contextMax) * 100)
                  : 0;
              const bar = () => contextBar(pct());
              const barColor = () => {
                const p = pct();
                if (p < 40) return P().green;
                if (p < 60) return P().yellow;
                if (p < 80) return P().peach;
                return P().red;
              };
              const model = () => (details.model ? shortModel(details.model) : "");
              const cacheText = () =>
                details.cacheExpiresAt != null
                  ? `Cache ${formatCacheRemaining(details.cacheExpiresAt, now())}`
                  : null;
              return (
                <text truncate>
                  <span style={{ fg: barColor() }}>{bar()}</span>
                  <span style={{ fg: P().overlay0, attributes: DIM }}> {pct()}%</span>
                  <Show when={model()}>
                    <span style={{ fg: P().subtext0, attributes: DIM }}> · {model()}</span>
                  </Show>
                  <Show when={cacheText()}>
                    <span style={{ fg: P().sky, attributes: DIM }}> · {cacheText()}</span>
                  </Show>
                </text>
              );
            }}
          </Show>
        </box>
      </box>
    </box>
  );
}
