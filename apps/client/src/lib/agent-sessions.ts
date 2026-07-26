/**
 * Chat sessions (the rendered-agent panes) as app-level state, not component
 * state.
 *
 * A chat pane's transcript and its running `claude` process must outlive the
 * component that renders them. The pane area only tiles the *active* folder's
 * *active* window, so clicking another folder in the rail unmounts every pane
 * that isn't in it — which, while the transcript lived in `AgentPane`'s own
 * `useState` and the process died with its unmount effect, meant switching
 * folders silently killed the session you were talking to and threw the
 * conversation away. Terminals never had this problem because they are pooled
 * and merely hidden; a chat's *state* is what has to be pooled instead.
 *
 * So: one record per agent pane id, one `agent://event` listener for the whole
 * app folding into it, and the record is dropped only when the pane is really
 * closed. That also makes chat status readable *outside* the pane — the folder
 * rail renders a row per chat from these records (see `ChatRow`), which is only
 * possible because they don't live inside the pane it would have to be mounted
 * to see.
 *
 * `agentId` here is always the pane id (`agentPaneId(folderDir)`), which is the
 * backend session key too — see `tt-agent`'s doc on why that is folder-scoped.
 */

import { useSyncExternalStore } from "react";
import {
  AGENT_EVENT,
  agentSend,
  agentStart,
  agentStop,
  appendUserTurn,
  emptyView,
  foldEvent,
  type AgentEventPayload,
  type AgentView,
} from "@/lib/agent";
import { isTauri } from "@/lib/tauri";

export type ChatSession = {
  /** The folded transcript. */
  view: AgentView;
  /** A `claude` process was started for this pane and hasn't been stopped. */
  started: boolean;
};

/** The record an unopened (or just-closed) pane reads as. A frozen singleton
 * because `useSyncExternalStore` compares snapshots by identity — returning a
 * fresh object per read would re-render forever. */
const IDLE: ChatSession = Object.freeze({ view: Object.freeze(emptyView()), started: false });

let sessions: ReadonlyMap<string, ChatSession> = new Map();
const listeners = new Set<() => void>();
let feedAttached = false;

function emit(next: Map<string, ChatSession>) {
  sessions = next;
  for (const listener of listeners) listener();
}

function patch(agentId: string, fn: (cur: ChatSession) => ChatSession) {
  const next = new Map(sessions);
  next.set(agentId, fn(sessions.get(agentId) ?? IDLE));
  emit(next);
}

/**
 * The single `agent://event` subscription, attached on first use and never
 * torn down — the feed belongs to the app, not to whichever pane happened to
 * mount first. Events for an id with no record are dropped: that is a stopped
 * session's own exit arriving after its pane closed, and folding it would
 * resurrect a row for a pane that no longer exists.
 */
function ensureFeed() {
  if (feedAttached || !isTauri()) return;
  feedAttached = true;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<AgentEventPayload>(AGENT_EVENT, (e) => {
      const agentId = e.payload.agentId;
      if (!sessions.has(agentId)) return;
      patch(agentId, (cur) => ({ ...cur, view: foldEvent(cur.view, e.payload) }));
    });
  })();
}

function subscribe(listener: () => void) {
  ensureFeed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => sessions;

/** Every live chat record, keyed by pane id — for board-wide tallies. */
export function useChatSessions(): ReadonlyMap<string, ChatSession> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One pane's chat record; `IDLE` when nothing has been started there. */
export function useChatSession(agentId: string): ChatSession {
  return useSyncExternalStore(
    subscribe,
    () => sessions.get(agentId) ?? IDLE,
    () => IDLE,
  );
}

/** Start a session in `cwd` with the first prompt. The echoed user turn lands
 * immediately (the CLI never replays it) and is rolled back if the spawn
 * fails — a turn describing a session that never started implies the prompt is
 * queued somewhere. */
export async function startChat(agentId: string, cwd: string, prompt: string) {
  ensureFeed();
  patch(agentId, () => ({
    view: appendUserTurn({ ...emptyView(), running: true }, prompt),
    started: false,
  }));
  const res = await agentStart({ agentId, cwd, prompt });
  res.match({
    ok: () => patch(agentId, (cur) => ({ ...cur, started: true })),
    err: () => patch(agentId, () => ({ view: emptyView(), started: false })),
  });
  return res;
}

/** Send a follow-up turn to a running session. The echo lands before the round
 * trip for the same reason the first prompt's does — a composer that clears
 * with nothing to show for it reads as a dropped message. */
export async function sendChat(agentId: string, text: string) {
  patch(agentId, (cur) => ({
    ...cur,
    view: appendUserTurn({ ...cur.view, running: true }, text),
  }));
  const res = await agentSend(agentId, text);
  if (res.isErr()) patch(agentId, (cur) => ({ ...cur, view: { ...cur.view, running: false } }));
  return res;
}

/** Stop the process but keep the transcript on screen — the pane stays open
 * and can be started again. */
export async function stopChat(agentId: string) {
  const res = await agentStop(agentId);
  patch(agentId, (cur) => ({ view: { ...cur.view, running: false }, started: false }));
  return res;
}

/** The pane itself is gone: kill the process and forget the transcript, so a
 * reopened chat on the same folder starts clean rather than inheriting a
 * conversation the user closed. */
export function closeChat(agentId: string) {
  void agentStop(agentId);
  if (!sessions.has(agentId)) return;
  const next = new Map(sessions);
  next.delete(agentId);
  emit(next);
}

/** How a chat is doing, for the rail row and the pane's own status line.
 * `off` is a pane with no session behind it yet. */
export type ChatStatus = "off" | "working" | "idle" | "exited" | "error";

/** Pure so the rail and the pane can never describe the same session
 * differently. Exit outranks `running`: an agent that dies mid-turn never
 * sends the `turn` event that would clear it. */
export function chatStatus({ view, started }: ChatSession): ChatStatus {
  if (view.exitCode !== undefined) return view.exitCode ? "error" : "exited";
  if (view.running) return "working";
  if (started || view.turns.length > 0) return "idle";
  return "off";
}

/** Board-wide chat tally for the rail's rollup chip — chats are agents, and a
 * tally that counted only PTY sessions read "no agents running" with a chat
 * visibly working beside it. */
export type ChatTally = { total: number; busy: number; error: number };

export function chatTally(records: Iterable<ChatSession>): ChatTally {
  const tally: ChatTally = { total: 0, busy: 0, error: 0 };
  for (const record of records) {
    const status = chatStatus(record);
    if (status === "off") continue;
    tally.total += 1;
    if (status === "working") tally.busy += 1;
    else if (status === "error") tally.error += 1;
  }
  return tally;
}
