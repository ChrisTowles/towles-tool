/** A prompt sent from a terminal pane: Enter with no modifier. The board listens
 * so it can move on to the next agent waiting on you; the pane only reports. */
const listeners = new Set<(termId: string) => void>();
const lastKeyAt = new Map<string, number>();

export function notePaneKey(termId: string, enter: boolean, now = Date.now()) {
  lastKeyAt.set(termId, now);
  if (enter) for (const l of listeners) l(termId);
}

/** Whether `termId` has seen a keystroke since `sinceMs` — typing on means stay. */
export function typedSince(termId: string, sinceMs: number): boolean {
  return (lastKeyAt.get(termId) ?? 0) > sinceMs;
}

export function onPromptSubmit(cb: (termId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
