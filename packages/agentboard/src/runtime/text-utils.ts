/** Truncate a string to `max` chars, appending an ellipsis character if clipped. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
