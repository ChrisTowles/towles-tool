import { useSyncExternalStore } from "react";
import { z } from "zod";
import { invoke, isTauri } from "@/lib/tauri";

// Notes to an agent: the app stores one, the tt Claude mod running in that session takes it
// over MCP and hands it to the model — mid-turn when it is working, as a prompt when idle.
// Rust owns delivery (`crates-tauri/tt-app/src/inbox.rs`); this is the view of it.

const NoteSchema = z.object({
  id: z.number(),
  session: z.string(),
  body: z.string(),
  source: z.enum(["note", "feedback"]),
  images: z.array(z.string()),
  createdAt: z.number(),
  deliveredAt: z.number().nullish(),
  deliveredHow: z.enum(["midTurn", "prompt"]).nullish(),
});
export type AgentNote = z.infer<typeof NoteSchema>;

const InboxStateSchema = z.object({
  listening: z.array(z.string()),
  notes: z.array(NoteSchema),
});
export type InboxState = z.infer<typeof InboxStateSchema>;

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
  invoke<number>("inbox_send", { session, body, images, feedback });

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
    const res = await invoke("inbox_state", {}, { schema: InboxStateSchema });
    if (res.isErr()) return;
    this.state = res.value;
    for (const fn of this.listeners) fn();
  }

  private start(): void {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), REFRESH_MS);
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const sub = await listen("inbox://changed", () => void this.refresh());
      if (cancelled) sub();
      else unlisten = sub;
    })();
    this.stop = () => {
      cancelled = true;
      clearInterval(timer);
      unlisten?.();
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
