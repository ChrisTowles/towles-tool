import { useSyncExternalStore } from "react";

/** What the rail's status line says after an action — the echo of a click,
 * held in place where the next glance lands rather than in a passing toast. */
export type HudNote = { text: string; tone: "ok" | "warn" | "danger"; at: number };

/** How long a note outranks the resting legend. */
export const HUD_NOTE_MS = 8000;

let current: HudNote | null = null;
const listeners = new Set<() => void>();

export function hudNote(text: string, tone: HudNote["tone"], at: number = Date.now()): void {
  current = { text, tone, at };
  for (const l of listeners) l();
}

export function useHudNote(): HudNote | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

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
