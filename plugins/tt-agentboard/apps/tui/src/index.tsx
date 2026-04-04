import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { appendFileSync } from "node:fs";
import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  batch,
  For,
  Show,
  createMemo,
  createSelector,
} from "solid-js";
import type { Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";

import {
  ensureServer,
  SERVER_PORT,
  SERVER_HOST,
  loadConfig,
  resolveTheme,
  saveConfig,
} from "@tt-agentboard/runtime";
import type { ServerMessage, SessionData, ClientCommand, Theme } from "@tt-agentboard/runtime";
import { TmuxClient, SIDEBAR_PANE_TITLE } from "@tt-agentboard/mux-tmux";
import { SessionCard } from "./components/SessionCard";
import { DetailPanel } from "./components/DetailPanel";
import { StatusBar } from "./components/StatusBar";

// Detect tmux context (tmux only)
type MuxContext = { type: "tmux"; sdk: TmuxClient; paneId: string } | { type: "none" };

function detectMuxContext(): MuxContext {
  if (process.env.TMUX_PANE && process.env.TMUX) {
    return { type: "tmux", sdk: new TmuxClient(), paneId: process.env.TMUX_PANE };
  }
  return { type: "none" };
}

const muxCtx = detectMuxContext();

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOLD = TextAttributes.BOLD;
const DIM = TextAttributes.DIM;
const DEFAULT_DETAIL_PANEL_HEIGHT = 10;
const MIN_DETAIL_PANEL_HEIGHT = 4;
const DIVIDER = "─".repeat(200);
const RESIZE_DEBUG_LOG = "/tmp/agentboard-tui-resize.log";

const TUI_DEBUG = !!process.env.TT_AGENTBOARD_DEBUG;

function logResizeDebug(message: string, data?: Record<string, unknown>): void {
  if (!TUI_DEBUG) return;
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  try {
    appendFileSync(RESIZE_DEBUG_LOG, `[${ts}] [pid:${process.pid}] ${message}${extra}\n`);
  } catch {}
}

function clampDetailPanelHeight(height: number): number {
  return Math.max(MIN_DETAIL_PANEL_HEIGHT, Math.round(height));
}

function getStoredDetailPanelHeight(sessionName: string): number {
  const stored = loadConfig().detailPanelHeights?.[sessionName];
  return typeof stored === "number" ? clampDetailPanelHeight(stored) : DEFAULT_DETAIL_PANEL_HEIGHT;
}

function persistDetailPanelHeight(sessionName: string, height: number): void {
  const config = loadConfig();
  saveConfig({
    detailPanelHeights: {
      ...(config.detailPanelHeights ?? {}),
      [sessionName]: clampDetailPanelHeight(height),
    },
  });
}

/** Ensure this sidebar pane is titled so getActiveSessionDirs() can filter it out. */
if (muxCtx.type === "tmux") {
  muxCtx.sdk.setPaneTitle(muxCtx.paneId, SIDEBAR_PANE_TITLE);
}

/** Refocus the main (non-sidebar) pane after TUI capability detection finishes.
 *  This must happen from the TUI process — doing it from the server races with
 *  capability query responses and leaks escape sequences to the main pane. */
function refocusMainPane() {
  if (muxCtx.type === "tmux") {
    try {
      // Use the TUI's own pane ID to find its current window (handles stash restore
      // where the pane may have moved to a different window than the original).
      const windowId =
        process.env.REFOCUS_WINDOW ||
        Bun.spawnSync(["tmux", "display-message", "-t", muxCtx.paneId, "-p", "#{window_id}"], {
          stdout: "pipe",
          stderr: "pipe",
        })
          .stdout.toString()
          .trim();
      if (!windowId) return;
      const r = Bun.spawnSync(
        ["tmux", "list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const lines = r.stdout.toString().trim().split("\n");
      const main = lines.find((l) => !l.includes(SIDEBAR_PANE_TITLE));
      if (main) {
        const paneId = main.split(" ")[0];
        Bun.spawnSync(["tmux", "select-pane", "-t", paneId], { stdout: "pipe", stderr: "pipe" });
      }
    } catch {}
  }
}

function getClientTty(): string {
  if (muxCtx.type === "tmux") {
    const { sdk, paneId } = muxCtx;
    const sessName = sdk.display("#{session_name}", { target: paneId });
    if (sessName) {
      const clients = sdk.listClients();
      const client = clients.find((c) => c.sessionName === sessName);
      if (client) return client.tty;
    }
    return sdk.getClientTty();
  }
  return "";
}

function getLocalSessionName(): string | null {
  if (muxCtx.type === "tmux") {
    const sessionName = muxCtx.sdk.display("#{session_name}", { target: muxCtx.paneId });
    return sessionName || null;
  }
  return null;
}

function App() {
  const renderer = useRenderer();

  // --- Theme state (driven by server) ---
  const [theme, setTheme] = createSignal<Theme>(resolveTheme(undefined));
  const P = () => theme().palette;
  const S = () => theme().status;

  const [sessions, setSessions] = createStore<SessionData[]>([]);
  const [focusedSession, setFocusedSession] = createSignal<string | null>(null);
  const [currentSession, setCurrentSession] = createSignal<string | null>(null);
  const [mySession, setMySession] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [spinIdx, setSpinIdx] = createSignal(0);
  const [detailPanelHeight, setDetailPanelHeight] = createSignal(DEFAULT_DETAIL_PANEL_HEIGHT);
  const [isDetailResizeHover, setIsDetailResizeHover] = createSignal(false);
  const [isDetailResizing, setIsDetailResizing] = createSignal(false);
  const detailPanelSessionName = createMemo(() => focusedSession() ?? mySession());

  // --- Panel focus: sessions list vs agent detail ---
  type PanelFocus = "sessions" | "agents";
  const [panelFocus, setPanelFocus] = createSignal<PanelFocus>("sessions");
  const [focusedAgentIdx, setFocusedAgentIdx] = createSignal(0);

  // --- Modal state ---
  const [modal, setModal] = createSignal<"none" | "confirm-kill" | "help">("none");
  const [killTarget, setKillTarget] = createSignal<string | null>(null);

  const [clientTty, setClientTty] = createSignal(getClientTty());
  let ws: WebSocket | null = null;
  let startupFocusSynced = false;
  let detailResizeStartY = 0;
  let detailResizeStartHeight = DEFAULT_DETAIL_PANEL_HEIGHT;
  const startupSessionName = getLocalSessionName();

  const focusedData = createMemo(() => sessions.find((s) => s.name === focusedSession()) ?? null);

  function send(cmd: ClientCommand) {
    if (connected() && ws) ws.send(JSON.stringify(cmd));
  }

  function switchToSession(name: string) {
    // Optimistic local update — makes rapid Tab repeat instant by removing
    // the server/hook round-trip from the next-Tab decision.
    // The server's focus/state broadcast will reconcile if needed.
    setCurrentSession(name);
    setFocusedSession(name);
    setPanelFocus("sessions");
    setFocusedAgentIdx(0);
    send({ type: "switch-session", name });
  }

  function reIdentify() {
    const sessionName = getLocalSessionName();
    if (!sessionName) return;

    if (muxCtx.type === "tmux") {
      send({ type: "identify-pane", paneId: muxCtx.paneId, sessionName });
    }
  }

  function moveLocalFocus(delta: -1 | 1) {
    const list = sessions;
    if (list.length === 0) return;

    const current = focusedSession();
    const currentIdx = Math.max(
      0,
      list.findIndex((s) => s.name === current),
    );
    const nextIdx = Math.max(0, Math.min(list.length - 1, currentIdx + delta));
    const next = list[nextIdx]?.name ?? null;

    if (!next || next === current) return;

    setFocusedSession(next);
    send({ type: "focus-session", name: next });
  }

  function moveAgentFocus(delta: -1 | 1) {
    const data = focusedData();
    const agents = data?.agents ?? [];
    if (agents.length === 0) return;
    const idx = focusedAgentIdx();
    const next = Math.max(0, Math.min(agents.length - 1, idx + delta));
    setFocusedAgentIdx(next);
  }

  function activateFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    if (TUI_DEBUG)
      appendFileSync(
        "/tmp/agentboard-tui-agent-click.log",
        `[${new Date().toISOString()}] keyboard focus-agent-pane session=${data.name} agent=${agent.agent} threadId=${agent.threadId} threadName=${agent.threadName}\n`,
      );
    send({
      type: "focus-agent-pane",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
      threadName: agent.threadName,
    });
  }

  function dismissFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send({
      type: "dismiss-agent",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
    });
    // Adjust index if we dismissed the last item
    if (focusedAgentIdx() >= agents.length - 1 && agents.length > 1) {
      setFocusedAgentIdx(agents.length - 2);
    }
    // If no agents left, go back to sessions
    if (agents.length <= 1) setPanelFocus("sessions");
  }

  function killFocusedAgentPane() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send({
      type: "kill-agent-pane",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
      threadName: agent.threadName,
    });
  }

  function beginDetailResize(event: MouseEvent) {
    logResizeDebug("beginDetailResize", {
      button: event.button,
      x: event.x,
      y: event.y,
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
      target: event.target?.id ?? null,
    });
    if (event.button !== 0) return;
    (renderer as any).setCapturedRenderable?.(event.target ?? undefined);
    detailResizeStartY = event.y;
    detailResizeStartHeight = detailPanelHeight();
    setIsDetailResizing(true);
    event.stopPropagation();
  }

  function handleDetailResizeDrag(event: MouseEvent) {
    logResizeDebug("handleDetailResizeDrag", {
      x: event.x,
      y: event.y,
      isResizing: isDetailResizing(),
      startY: detailResizeStartY,
      startHeight: detailResizeStartHeight,
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
    });
    if (!isDetailResizing()) return;
    const delta = detailResizeStartY - event.y;
    const nextHeight = clampDetailPanelHeight(detailResizeStartHeight + delta);
    setDetailPanelHeight(nextHeight);
    logResizeDebug("handleDetailResizeDrag:applied", {
      delta,
      nextHeight,
      session: detailPanelSessionName(),
    });
    event.stopPropagation();
  }

  function endDetailResize(event?: MouseEvent) {
    logResizeDebug("endDetailResize", {
      x: event?.x,
      y: event?.y,
      isResizing: isDetailResizing(),
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
      target: event?.target?.id ?? null,
    });
    if (!isDetailResizing()) return;
    (renderer as any).setCapturedRenderable?.(undefined);
    setIsDetailResizing(false);
    setIsDetailResizeHover(false);

    const sessionName = detailPanelSessionName();
    if (sessionName) {
      persistDetailPanelHeight(sessionName, detailPanelHeight());
      logResizeDebug("endDetailResize:persisted", {
        session: sessionName,
        height: detailPanelHeight(),
      });
    }

    event?.stopPropagation();
  }

  function createNewSession() {
    if (muxCtx.type !== "tmux") {
      send({ type: "new-session" });
      return;
    }
    const scriptPath = new URL("../scripts/sessionizer.sh", import.meta.url).pathname;
    muxCtx.sdk.displayPopup({
      command: `bash "${scriptPath}"`,
      title: " new session ",
      width: "60%",
      height: "60%",
      closeOnExit: true,
    });
  }

  onMount(() => {
    logResizeDebug("mount", {
      startupSessionName,
      localSessionName: getLocalSessionName(),
      muxType: muxCtx.type,
      tmuxPane: process.env.TMUX_PANE ?? null,
    });
    // Refocus the main pane once terminal capability detection finishes.
    // This avoids the race where the server refocuses too early and capability
    // responses leak as garbage text into the main pane.
    let startupRefocused = false;
    const doStartupRefocus = () => {
      if (startupRefocused) return;
      startupRefocused = true;
      refocusMainPane();
    };
    renderer.on("capabilities", doStartupRefocus);
    // Fallback: if no capability response arrives within 2s, refocus anyway
    const refocusTimeout = setTimeout(doStartupRefocus, 2000);

    onCleanup(() => {
      clearTimeout(refocusTimeout);
      renderer.removeListener("capabilities", doStartupRefocus);
    });

    const socket = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}`);
    ws = socket;

    socket.onopen = () => {
      setConnected(true);
      const tty = clientTty();
      if (tty) send({ type: "identify", clientTty: tty });
      reIdentify();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        let startupFocusToPublish: string | null = null;
        batch(() => {
          if (msg.type === "state") {
            const startupFocus =
              !startupFocusSynced &&
              startupSessionName &&
              msg.sessions.some((session) => session.name === startupSessionName)
                ? startupSessionName
                : msg.focusedSession;

            if (startupFocus === startupSessionName) {
              startupFocusSynced = true;
              if (msg.focusedSession !== startupSessionName) {
                startupFocusToPublish = startupSessionName;
              }
            }

            setSessions(reconcile(msg.sessions, { key: "name" }));
            setFocusedSession(startupFocus);
            setCurrentSession(msg.currentSession);
            setTheme(resolveTheme(msg.theme));
          } else if (msg.type === "focus") {
            setFocusedSession(msg.focusedSession);
            setCurrentSession(msg.currentSession);
          } else if (msg.type === "your-session") {
            setMySession(msg.name);
            if (msg.clientTty) setClientTty(msg.clientTty);

            if (!startupFocusSynced && sessions.some((session) => session.name === msg.name)) {
              startupFocusSynced = true;
              setFocusedSession(msg.name);
              if (focusedSession() !== msg.name) {
                startupFocusToPublish = msg.name;
              }
            }
          } else if (msg.type === "re-identify") {
            reIdentify();
          }
        });

        if (startupFocusToPublish) {
          send({ type: "focus-session", name: startupFocusToPublish });
        }
      } catch {}
    };

    socket.onclose = () => {
      setConnected(false);
      renderer.destroy();
    };

    onCleanup(() => socket.close());

    // Listen for quit messages from server
    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "quit") {
          if (ws) ws.close();
          renderer.destroy();
        }
      } catch {}
    });
  });

  const hasRunning = createMemo(() => sessions.some((s) => s.agentState?.status === "running"));

  createEffect(() => {
    if (!hasRunning()) return;
    const interval = setInterval(() => {
      setSpinIdx((i) => (i + 1) % SPINNERS.length);
    }, 120);
    onCleanup(() => clearInterval(interval));
  });

  createEffect(() => {
    const sessionName = detailPanelSessionName();
    if (!sessionName) return;
    const storedHeight = getStoredDetailPanelHeight(sessionName);
    logResizeDebug("loadStoredDetailPanelHeight", {
      session: sessionName,
      storedHeight,
    });
    setDetailPanelHeight(storedHeight);
  });

  createEffect(() => {
    logResizeDebug("detailPanelHeight:changed", {
      height: detailPanelHeight(),
      session: detailPanelSessionName(),
      isResizing: isDetailResizing(),
    });
  });

  useKeyboard((key) => {
    const currentModal = modal();

    // --- Help modal ---
    if (currentModal === "help") {
      setModal("none");
      return;
    }

    // --- Confirm kill modal ---
    if (currentModal === "confirm-kill") {
      if (key.name === "y") {
        const target = killTarget();
        if (target) send({ type: "kill-session", name: target });
        setKillTarget(null);
        setModal("none");
      } else {
        setKillTarget(null);
        setModal("none");
      }
      return;
    }

    // --- Normal mode keybindings ---
    // Alt+Up / Alt+Down → reorder session
    if ((key.meta || key.option) && (key.name === "up" || key.name === "down")) {
      const focused = focusedSession();
      if (focused) {
        const delta: -1 | 1 = key.name === "up" ? -1 : 1;
        send({ type: "reorder-session", name: focused, delta });
      }
      return;
    }

    switch (key.name) {
      case "q":
        send({ type: "quit" });
        break;
      case "escape":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        }
        break;
      case "up":
      case "k":
        if (panelFocus() === "agents") {
          moveAgentFocus(-1);
        } else {
          moveLocalFocus(-1);
        }
        break;
      case "down":
      case "j":
        if (panelFocus() === "agents") {
          moveAgentFocus(1);
        } else {
          moveLocalFocus(1);
        }
        break;
      case "left":
      case "h":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        }
        break;
      case "right":
      case "l": {
        const data = focusedData();
        const agents = data?.agents ?? [];
        if (panelFocus() === "sessions" && agents.length > 0) {
          setPanelFocus("agents");
          setFocusedAgentIdx((idx) => Math.min(idx, agents.length - 1));
        }
        break;
      }
      case "return": {
        if (panelFocus() === "agents") {
          activateFocusedAgent();
        } else {
          const focused = focusedSession();
          if (focused) switchToSession(focused);
        }
        break;
      }
      case "tab": {
        const list = sessions;
        if (list.length === 0) break;
        const cur = currentSession();
        const idx = list.findIndex((s) => s.name === cur);
        const next = list[(idx + (key.shift ? list.length - 1 : 1)) % list.length];
        if (next) switchToSession(next.name);
        break;
      }
      case "r":
        send({ type: "refresh" });
        break;
      case "t":
        // reserved — was theme picker
        break;
      case "u":
        send({ type: "show-all-sessions" });
        break;
      case "d": {
        if (panelFocus() === "agents") {
          dismissFocusedAgent();
        } else {
          const focused = focusedSession();
          if (focused) send({ type: "hide-session", name: focused });
        }
        break;
      }
      case "x": {
        if (panelFocus() === "agents") {
          killFocusedAgentPane();
        } else {
          const focused = focusedSession();
          if (focused) {
            setKillTarget(focused);
            setModal("confirm-kill");
          }
        }
        break;
      }
      case "n":
      case "c":
        createNewSession();
        break;
      case "?":
        setModal("help");
        break;
      default: {
        if (key.number) {
          const idx = Number.parseInt(key.name, 10) - 1;
          const target = sessions[idx];
          if (target) switchToSession(target.name);
        }
        break;
      }
    }
  });

  const runningAgentCount = createMemo(() =>
    sessions.reduce((n, s) => n + (s.agents?.filter((a) => a.status === "running").length ?? 0), 0),
  );

  const errorAgentCount = createMemo(() =>
    sessions.reduce((n, s) => n + (s.agents?.filter((a) => a.status === "error").length ?? 0), 0),
  );

  const unseenCount = createMemo(() => sessions.filter((s) => s.unseen).length);

  const isFocused = createSelector(focusedSession);

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={P().crust}>
      {/* Header */}
      <StatusBar
        sessionCount={sessions.length}
        runningCount={runningAgentCount()}
        errorCount={errorAgentCount()}
        unseenCount={unseenCount()}
        theme={theme}
      />

      {/* Session list */}
      <scrollbox flexGrow={1} flexShrink={1} paddingTop={1}>
        <For each={sessions}>
          {(session, i) => (
            <SessionCard
              session={session}
              index={i() + 1}
              isFocused={isFocused(session.name)}
              isCurrent={session.name === currentSession()}
              spinIdx={spinIdx}
              theme={theme}
              statusColors={S}
              onSelect={() => {
                setFocusedSession(session.name);
                send({ type: "focus-session", name: session.name });
                switchToSession(session.name);
              }}
            />
          )}
        </For>
      </scrollbox>

      {/* Detail panel — focused session info, draggable height */}
      <Show when={focusedData()}>
        {(data) => (
          <scrollbox height={detailPanelHeight()} maxHeight={detailPanelHeight()} flexShrink={0}>
            <DetailPanel
              session={data()}
              theme={theme}
              statusColors={S}
              spinIdx={spinIdx}
              focusedAgentIdx={panelFocus() === "agents" ? focusedAgentIdx() : -1}
              onDismissAgent={(agent) => {
                send({
                  type: "dismiss-agent",
                  session: data().name,
                  agent: agent.agent,
                  threadId: agent.threadId,
                });
              }}
              onFocusAgentPane={(agent) => {
                if (TUI_DEBUG)
                  appendFileSync(
                    "/tmp/agentboard-tui-agent-click.log",
                    `[${new Date().toISOString()}] sending focus-agent-pane session=${data().name} agent=${agent.agent} threadId=${agent.threadId} threadName=${agent.threadName}\n`,
                  );
                send({
                  type: "focus-agent-pane",
                  session: data().name,
                  agent: agent.agent,
                  threadId: agent.threadId,
                  threadName: agent.threadName,
                });
              }}
              isResizeHover={isDetailResizeHover()}
              isResizing={isDetailResizing()}
              onResizeStart={beginDetailResize}
              onResizeDrag={handleDetailResizeDrag}
              onResizeEnd={endDetailResize}
              onResizeHoverChange={setIsDetailResizeHover}
            />
          </scrollbox>
        )}
      </Show>

      {/* Footer */}
      <box flexDirection="column" paddingLeft={1} paddingBottom={1} paddingTop={0} flexShrink={0}>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <Show
          when={panelFocus() === "sessions"}
          fallback={
            <text>
              <span style={{ fg: P().overlay0 }}>{"←"}</span>
              <span style={{ fg: P().overlay1 }}>{" back  "}</span>
              <span style={{ fg: P().overlay0 }}>{"⏎"}</span>
              <span style={{ fg: P().overlay1 }}>{" focus  "}</span>
              <span style={{ fg: P().overlay0 }}>{"d"}</span>
              <span style={{ fg: P().overlay1 }}>{" dismiss  "}</span>
              <span style={{ fg: P().overlay0 }}>{"x"}</span>
              <span style={{ fg: P().overlay1 }}>{" kill"}</span>
            </text>
          }
        >
          <text>
            <span style={{ fg: P().overlay0 }}>{"⇥"}</span>
            <span style={{ fg: P().overlay1 }}>{" cycle  "}</span>
            <span style={{ fg: P().overlay0 }}>{"⏎"}</span>
            <span style={{ fg: P().overlay1 }}>{" go  "}</span>
            <span style={{ fg: P().overlay0 }}>{"→"}</span>
            <span style={{ fg: P().overlay1 }}>{" detail  "}</span>
            <span style={{ fg: P().overlay0 }}>{"d"}</span>
            <span style={{ fg: P().overlay1 }}>{" hide  "}</span>
            <span style={{ fg: P().overlay0 }}>{"x"}</span>
            <span style={{ fg: P().overlay1 }}>{" kill"}</span>
          </text>
        </Show>
      </box>

      {/* Kill confirmation overlay */}
      <Show when={modal() === "confirm-kill"}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          justifyContent="center"
          alignItems="center"
          backgroundColor="transparent"
        >
          <box
            border
            borderStyle="rounded"
            borderColor={P().red}
            backgroundColor={P().mantle}
            padding={1}
            paddingX={2}
            flexDirection="column"
            alignItems="center"
          >
            <text>
              <span style={{ fg: P().red, attributes: BOLD }}>Kill session?</span>
            </text>
            <text>
              <span style={{ fg: P().text }}>{killTarget() ?? ""}</span>
            </text>
            <text>
              <span style={{ fg: P().overlay0 }}>y</span>
              <span style={{ fg: P().overlay1 }}>/</span>
              <span style={{ fg: P().overlay0 }}>n</span>
            </text>
          </box>
        </box>
      </Show>

      {/* Help overlay */}
      <Show when={modal() === "help"}>
        <HelpOverlay palette={P} onClose={() => setModal("none")} />
      </Show>
    </box>
  );
}

// --- Help Overlay ---

function HelpOverlay(props: { palette: Accessor<Theme["palette"]>; onClose: () => void }) {
  const P = () => props.palette();
  const keys: [string, string][] = [
    ["j/k ↑↓", "Move focus"],
    ["Enter", "Switch to session"],
    ["1-9", "Jump to session"],
    ["Tab", "Cycle sessions"],
    ["n/c", "New session"],
    ["d", "Hide session"],
    ["x", "Kill session"],
    ["r", "Refresh"],
    ["u", "Show all sessions"],
    ["→/l", "Detail panel"],
    ["←/h/Esc", "Back to sessions"],
    ["Alt+↑↓", "Reorder sessions"],
    ["q", "Quit"],
  ];

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      justifyContent="center"
      alignItems="center"
      backgroundColor="transparent"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={P().blue}
        backgroundColor={P().mantle}
        padding={1}
        flexDirection="column"
        width={30}
      >
        <text>
          <span style={{ fg: P().blue, attributes: BOLD }}>Keybindings</span>
        </text>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <For each={keys}>
          {([key, desc]) => (
            <box flexDirection="row" paddingLeft={1}>
              <box width={12} flexShrink={0}>
                <text>
                  <span style={{ fg: P().sky }}>{key}</span>
                </text>
              </box>
              <text truncate>
                <span style={{ fg: P().subtext0 }}>{desc}</span>
              </text>
            </box>
          )}
        </For>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <text style={{ fg: P().overlay0 }}>
          <span style={{ attributes: DIM }}>Press any key to close</span>
        </text>
      </box>
    </box>
  );
}

async function main() {
  await ensureServer();
  render(() => <App />, {
    exitOnCtrlC: true,
    targetFPS: 30,
    useMouse: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
