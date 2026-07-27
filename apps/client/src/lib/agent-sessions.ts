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
  agentRespond,
  agentSend,
  agentStart,
  agentStop,
  appendUserTurn,
  cancelPermissions,
  emptyView,
  foldEvent,
  isAsking,
  pendingPermissions,
  resolvePermission,
  type AgentEventPayload,
  type AgentView,
  type PermissionDecision,
  type Verdict,
} from "@/lib/agent";
import { isTauri } from "@/lib/tauri";

/** The authored half of a record — what a mutation decides. */
type ChatState = {
  /** The folded transcript. */
  view: AgentView;
  /** A `claude` process was started for this pane and hasn't been stopped. */
  started: boolean;
};

export type ChatSession = ChatState & {
  /**
   * Is this session blocked on a prompt? Derived from `view`, cached here.
   *
   * Kept on the record rather than recomputed by readers because the readers
   * are on a hot path and this answer is not free: it walks the turn list, and
   * `chatStatus` runs per rail row *and* inside `chatTally` over every open
   * chat, on every `agent://event` — so deriving it at read time costs
   * `events × turns × chats` instead of `events × turns`.
   *
   * Not a counter maintained alongside the fold, which would be one more
   * invariant to break: {@link chatSession} recomputes it from the view at the
   * single point where a record is written, so it cannot drift out of step
   * with the turns it describes.
   */
  asking: boolean;
};

/** The one place a record is built, so `asking` always matches its `view`. */
export const chatSession = ({ view, started }: ChatState): ChatSession => ({
  view,
  started,
  asking: isAsking(view),
});

/** The record an unopened (or just-closed) pane reads as. A frozen singleton
 * because `useSyncExternalStore` compares snapshots by identity — returning a
 * fresh object per read would re-render forever. */
const IDLE: ChatSession = Object.freeze({
  view: Object.freeze(emptyView()),
  started: false,
  asking: false,
});

let sessions: ReadonlyMap<string, ChatSession> = new Map();
const listeners = new Set<() => void>();
let feedAttached = false;

function emit(next: Map<string, ChatSession>) {
  sessions = next;
  for (const listener of listeners) listener();
}

function patch(agentId: string, fn: (cur: ChatSession) => ChatState) {
  const next = new Map(sessions);
  next.set(agentId, chatSession(fn(sessions.get(agentId) ?? IDLE)));
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

/**
 * Mark the spawn's outcome on the session.
 *
 * Shared by both entry points below because the rollback is a rule, not a
 * detail: a transcript describing a session that never started implies the
 * prompt is queued somewhere, so a failed spawn must clear the view outright.
 * Two copies of that would drift the moment one is fixed.
 */
function settleStart(agentId: string, res: Awaited<ReturnType<typeof agentStart>>) {
  res.match({
    ok: () => patch(agentId, (cur) => ({ ...cur, started: true })),
    err: () => patch(agentId, () => ({ view: emptyView(), started: false })),
  });
  return res;
}

/**
 * Start a session in `cwd` with the first prompt. The echoed user turn lands
 * immediately (the CLI never replays it) and is rolled back if the spawn
 * fails — see {@link settleStart}.
 */
export async function startChat(agentId: string, cwd: string, prompt: string) {
  ensureFeed();
  patch(agentId, () => ({
    view: appendUserTurn({ ...emptyView(), running: true }, prompt),
    started: false,
  }));
  return settleStart(agentId, await agentStart({ agentId, cwd, prompt }));
}

/**
 * Reattach to a prior Claude Code session in this folder, sending nothing.
 *
 * `resume` continues a session this pane started *or* one from a terminal/CLI
 * session, since they are the same kind of transcript. The pane opens with an
 * empty transcript either way: the conversation lives in the CLI's own history,
 * and replaying it into the feed would mean parsing a transcript we don't
 * otherwise read. What comes back is a session that *remembers*, which is the
 * part that matters.
 *
 * Deliberately promptless. Sending a canned "recap where we left off" would
 * author a prompt in this repo, spend tokens the user didn't ask for, and put
 * words in their mouth on every resume — the pane's job is to reopen the
 * channel, not to speak first. The composer is focused and the session
 * remembers; the next thing said is the user's.
 */
export async function resumeChat(agentId: string, cwd: string, resume: string) {
  ensureFeed();
  patch(agentId, () => ({ view: emptyView(), started: false }));
  return settleStart(agentId, await agentStart({ agentId, cwd, resume }));
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

/**
 * Answer a permission prompt the agent is blocked on.
 *
 * The card clears optimistically because nothing comes back to clear it: a
 * `control_response` is not acknowledged, so waiting for confirmation would
 * leave the prompt up for the rest of the turn. A failed write means the
 * session died while the card was open — the prompt is moot either way, so the
 * verdict still lands, and the caller reports the error.
 */
export async function answerChat(
  agentId: string,
  requestId: string,
  toolName: string,
  decision: PermissionDecision,
  verdict: Verdict,
) {
  patch(agentId, (cur) => ({ ...cur, view: resolvePermission(cur.view, requestId, verdict) }));
  return agentRespond(agentId, requestId, toolName, verdict, decision);
}

/**
 * Release every prompt this session is blocking on, as `cancelled`.
 *
 * Distinct from denying them: the user closed a pane, they didn't object to
 * the tool, and telling the model it was refused would be a lie it acts on.
 *
 * **Awaited before the kill, never fired alongside it.** Both callers go on to
 * stop the process, and an un-awaited write loses that race every time — the
 * cancels would reach a pipe that is already closing, which is indistinguishable
 * from not sending them at all. Awaiting is what lets the CLI unwind the
 * blocked turn itself instead of dying mid-question.
 */
async function cancelPending(agentId: string) {
  const view = sessions.get(agentId)?.view;
  if (!view) return;
  const pending = pendingPermissions(view);
  if (pending.length === 0) return;
  await Promise.all(
    pending.map((request) =>
      agentRespond(agentId, request.requestId, request.toolName, "cancelled", {
        kind: "cancelled",
      }),
    ),
  );
  // Record the verdict rather than merely dropping the cards: `cancelled` is
  // already the word sent to the CLI, and a card that vanishes with no trace
  // leaves the transcript claiming a decision was never asked for. One pass,
  // not one per prompt — every card here gets the same verdict.
  patch(agentId, (cur) => ({ ...cur, view: cancelPermissions(cur.view) }));
}

/** Stop the process but keep the transcript on screen — the pane stays open
 * and can be started again. Pending prompts are cancelled first, while there is
 * still a process to hear it. */
export async function stopChat(agentId: string) {
  await cancelPending(agentId);
  const res = await agentStop(agentId);
  patch(agentId, (cur) => ({ view: { ...cur.view, running: false }, started: false }));
  return res;
}

/** The pane itself is gone: kill the process and forget the transcript, so a
 * reopened chat on the same folder starts clean rather than inheriting a
 * conversation the user closed. */
export function closeChat(agentId: string) {
  // Stays synchronous — it runs from an unmount effect, which cannot await —
  // but the cancel/stop pair inside it must still be sequenced, for the reason
  // in `cancelPending`.
  void cancelPending(agentId).finally(() => void agentStop(agentId));
  if (!sessions.has(agentId)) return;
  const next = new Map(sessions);
  next.delete(agentId);
  emit(next);
}

/** How a chat is doing, for the rail row and the pane's own status line.
 * `off` is a pane with no session behind it yet. */
export type ChatStatus = "off" | "working" | "asking" | "idle" | "exited" | "error";

/** Pure so the rail and the pane can never describe the same session
 * differently. Exit outranks `running`: an agent that dies mid-turn never
 * sends the `turn` event that would clear it. `asking` outranks it too, and for
 * a sharper reason — a blocked agent is still `running`, but reporting it as
 * working hides the one state that needs the user, in the one place (the rail)
 * they would look without opening the pane. */
export function chatStatus({ view, started, asking }: ChatSession): ChatStatus {
  if (view.exitCode !== undefined) return view.exitCode ? "error" : "exited";
  if (asking) return "asking";
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
