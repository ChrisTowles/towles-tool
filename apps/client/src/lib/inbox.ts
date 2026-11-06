import { replaceEqualDeep } from "@/lib/replace-equal-deep";
import { Option, Result, Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { write } from "@/lib/atoms/registry";
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

/** Live only while something reads it: the poll and the event listener are
 * the atom's own, released with it. An unchanged poll wakes no reader. */
export const inboxAtom: Atom.Atom<InboxState> = Atom.make((get) => {
  if (!isTauri()) return EMPTY;
  const refresh = async () => {
    const res = await runIpc(invoke<InboxState>("inbox_state", {}, { schema: InboxStateSchema }));
    if (Result.isFailure(res)) return;
    const prev = Option.getOrElse(get.self<InboxState>(), () => EMPTY);
    const next = replaceEqualDeep(prev, res.success);
    if (next !== prev) get.setSelf(next);
  };
  const stopPoll = startPoll(refresh, REFRESH_MS);
  const stopEvents = subscribe("inbox://changed", () => void refresh());
  get.addFinalizer(() => {
    stopPoll();
    stopEvents();
  });
  return EMPTY;
});

/** The note box, mounted once at the root; a row's menu or the shortcut opens it. */
export type NoteTarget = { sessionId: string; label: string };

export const noteDialogAtom = Atom.make<NoteTarget | null>(null).pipe(Atom.keepAlive);

export const openNoteDialog = (target: NoteTarget) => write(noteDialogAtom, target);
export const closeNoteDialog = () => write(noteDialogAtom, null);
