import { replaceEqualDeep } from "@/lib/replace-equal-deep";
import { useSyncExternalStore } from "react";
import { Result, Schema } from "effect";
import { list } from "@/lib/schemas/shape";
import { startPoll, subscribe } from "@/lib/run";
import { invoke, isTauri, runIpc } from "@/lib/tauri";

// Notes to an agent: the app stores one, the tt Claude mod running in that session takes it
// over MCP and hands it to the model — mid-turn when it is working, as a prompt when idle.
// Rust owns delivery (`crates-tauri/tt-app/src/inbox.rs`); this is the view of it.

const NoteSchema = Schema.Struct({
  id: Schema.Number,
  session: Schema.String,
  body: Schema.String,
  source: Schema.Literals(["note", "feedback"]),
  images: list(Schema.String),
  createdAt: Schema.Number,
  deliveredAt: Schema.optional(Schema.NullOr(Schema.Number)),
  deliveredHow: Schema.optional(Schema.NullOr(Schema.Literals(["midTurn", "prompt"]))),
});
export type AgentNote = typeof NoteSchema.Type;

const InboxStateSchema = Schema.Struct({
  listening: list(Schema.String),
  notes: list(NoteSchema),
});
export type InboxState = typeof InboxStateSchema.Type;

const EMPTY: InboxState = { listening: [], notes: [] };
/** Listening lapses without an event (a mod that stops polling says nothing), so re-read. */
const REFRESH_MS = 5_000;

export const NOT_LISTENING_HINT =
  "This session isn't running the tt mod. Enable towles-tool-app in Claude Code.";

/** The one chip a session row shows: a note still waiting, else one just delivered. */
export type NoteChip = { kind: "pending" | "delivered"; how?: "midTurn" | "prompt" };

export function noteChip(state: InboxState, session: string): NoteChip | null {
  const mine = state.notes.filter((n) => n.session === session);
  if (mine.some((n) => n.deliveredAt == null)) return { kind: "pending" };
  const last = mine.findLast((n) => n.deliveredAt != null);
  return last ? { kind: "delivered", how: last.deliveredHow ?? undefined } : null;
}

export function isListening(state: InboxState, session: string): boolean {
  return state.listening.includes(session);
}

export const inboxSend = (session: string, body: string, images: string[], feedback: boolean) =>
  runIpc(invoke<number>("inbox_send", { session, body, images, feedback }));

class InboxStore {
  private state: InboxState = EMPTY;
  private listeners = new Set<() => void>();
  private stop: (() => void) | null = null;

  get = (): InboxState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.stop?.();
        this.stop = null;
      }
    };
  };

  private async refresh(): Promise<void> {
    const res = await runIpc(invoke<InboxState>("inbox_state", {}, { schema: InboxStateSchema }));
    if (Result.isFailure(res)) return;
    // Every row reads this: an unchanged poll must wake none of them.
    const next = replaceEqualDeep(this.state, res.success);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  private start(): void {
    if (!isTauri()) return;
    const stopPoll = startPoll(() => this.refresh(), REFRESH_MS);
    const stopEvents = subscribe("inbox://changed", () => void this.refresh());
    this.stop = () => {
      stopPoll();
      stopEvents();
    };
  }
}

const store = new InboxStore();

export function useInbox(): InboxState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The note box, mounted once at the root; a row's menu or the shortcut opens it. */
export type NoteTarget = { sessionId: string; label: string };

class NoteDialogStore {
  private target: NoteTarget | null = null;
  private listeners = new Set<() => void>();
  get = (): NoteTarget | null => this.target;
  set(target: NoteTarget | null): void {
    this.target = target;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

const dialog = new NoteDialogStore();

export const openNoteDialog = (target: NoteTarget) => dialog.set(target);
export const closeNoteDialog = () => dialog.set(null);
export function useNoteDialog(): NoteTarget | null {
  return useSyncExternalStore(dialog.subscribe, dialog.get);
}
