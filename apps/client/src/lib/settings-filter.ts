/** Client-side filtering for the Settings screen. Pure and host-independent so
 * it unit-tests without React or the Tauri shell. */

/** Trim + lowercase a raw query so callers compare against normalized text. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** True when the query is effectively empty (nothing typed → show everything). */
export function isEmptyQuery(query: string): boolean {
  return normalizeQuery(query) === "";
}

/** Case-insensitive substring test over the row's label plus any per-row
 * keywords (its section name, synonyms). An empty query matches everything. */
export function matchesFilter(
  query: string,
  label: string,
  keywords: readonly string[] = [],
): boolean {
  const q = normalizeQuery(query);
  if (q === "") return true;
  const haystack = [label, ...keywords].join(" ").toLowerCase();
  return haystack.includes(q);
}
