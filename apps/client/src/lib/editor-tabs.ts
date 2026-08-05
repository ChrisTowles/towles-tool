/** The open-file set behind a files pane's tab bar — pure like
 * `editor-history.ts`, which stays the back/forward record beside it. The
 * *active* path lives in that history (`currentPath`), not here: one source of
 * truth for "what's open", with tabs as the set/order/MRU around it. */

export type PaneTabs = {
  /** Visual order, append-on-open. */
  readonly order: readonly string[];
  /** Most-recently-active first — Ctrl+Tab walks this, not `order`. */
  readonly mru: readonly string[];
  /** Reopen stack for ⌘⇧T, newest first. */
  readonly closed: readonly string[];
};

export const NO_TABS: PaneTabs = { order: [], mru: [], closed: [] };

const CLOSED_LIMIT = 20;

/** Idempotent for an already-active path, so it can run on every open. */
export function tabsOnOpen(tabs: PaneTabs, path: string): PaneTabs {
  if (tabs.mru[0] === path) return tabs;
  return {
    order: tabs.order.includes(path) ? tabs.order : [...tabs.order, path],
    mru: [path, ...tabs.mru.filter((p) => p !== path)],
    closed: tabs.closed.filter((p) => p !== path),
  };
}

export function tabsOnClose(tabs: PaneTabs, path: string): PaneTabs {
  if (!tabs.order.includes(path)) return tabs;
  return {
    order: tabs.order.filter((p) => p !== path),
    mru: tabs.mru.filter((p) => p !== path),
    closed: [path, ...tabs.closed].slice(0, CLOSED_LIMIT),
  };
}

/** What to activate once `path` closes: MRU first (matches VS Code), falling
 * back to the visual neighbor for tabs never activated. Null closes the pane's
 * last file. Call *before* `tabsOnClose` — it needs the closing state. */
export function nextAfterClose(tabs: PaneTabs, path: string): string | null {
  const byMru = tabs.mru.find((p) => p !== path);
  if (byMru) return byMru;
  const i = tabs.order.indexOf(path);
  return tabs.order[i + 1] ?? tabs.order[i - 1] ?? null;
}

/** Ctrl+Tab: the next tab in recency order, wrapping. */
export function mruNext(tabs: PaneTabs, active: string | null): string | null {
  if (tabs.mru.length < 2 || active == null) return null;
  const i = tabs.mru.indexOf(active);
  return tabs.mru[(i + 1) % tabs.mru.length] ?? null;
}

/** ⌘⇧T target; `tabsOnOpen` removes it from the stack when it reopens. */
export function reopenTarget(tabs: PaneTabs): string | null {
  return tabs.closed[0] ?? null;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Tab captions: basename, with the parent dir appended when two tabs would
 * otherwise read identically (VS Code's disambiguation). */
export function tabLabels(paths: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const p of paths) {
    const name = base(p);
    if ((counts.get(name) ?? 0) < 2) {
      labels.set(p, name);
      continue;
    }
    const slash = p.lastIndexOf("/");
    const parent = slash > 0 ? p.slice(0, slash).split("/").pop() : null;
    labels.set(p, parent ? `${name} — ${parent}` : name);
  }
  return labels;
}
