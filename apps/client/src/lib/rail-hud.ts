import * as Atom from "effect/reactivity/Atom";
import { write } from "@/lib/atoms/registry";

/** What the rail's status line says after an action — the echo of a click,
 * held in place where the next glance lands rather than in a passing toast. */
export type HudNote = { text: string; tone: "ok" | "warn" | "danger"; at: number };

/** How long a note outranks the resting legend. */
export const HUD_NOTE_MS = 8000;

const hudNoteAtom = Atom.make<HudNote | null>(null).pipe(Atom.keepAlive);

export function hudNote(text: string, tone: HudNote["tone"], at: number = Date.now()): void {
  write(hudNoteAtom, { text, tone, at });
}

/** The note while it is fresh, `null` once it has aged out — the expiry is the
 * atom's own timer, so nothing has to re-render to notice it. */
export const freshHudNoteAtom: Atom.Atom<HudNote | null> = Atom.make((get) => {
  const note = get(hudNoteAtom);
  if (!noteIsFresh(note, Date.now())) return null;
  const timer = setTimeout(() => get.setSelf(null), HUD_NOTE_MS - (Date.now() - note.at));
  get.addFinalizer(() => clearTimeout(timer));
  return note;
});

/** A note is shown only while fresh; past that the legend speaks again. */
export function noteIsFresh(note: HudNote | null, now: number): note is HudNote {
  return note !== null && now - note.at < HUD_NOTE_MS;
}

/** The hover description of the nearest element that declares one. The rail's
 * controls opt in with `data-hud`, so the status line never guesses. */
export function hudTextAt(target: EventTarget | null): string | null {
  const el = target as Partial<Element> | null;
  if (typeof el?.closest !== "function") return null;
  return el.closest("[data-hud]")?.getAttribute("data-hud") ?? null;
}
