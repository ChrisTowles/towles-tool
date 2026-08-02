/**
 * Format commands this app can't honor. A later `registerCommand` of the same
 * id wins and every route dispatches by id, so one no-op shadows them all.
 */

export const PRUNED_COMMANDS: readonly string[] = [
  // Bound to Shift+Alt+F and, on Linux, Ctrl+Shift+I — the devtools chord, so
  // it gets hit by accident. Prompts "install a formatter?" via window.confirm.
  "editor.action.formatDocument.none",
  // No formatter is registered for any language, so these reach the same
  // prompt.
  "editor.action.formatDocument",
  "editor.action.formatSelection",
  "editor.action.formatDocument.multiple",
  "editor.action.formatSelection.multiple",
  "editor.action.formatChanges",
];

/**
 * Ids no longer registered upstream. A shadow over a renamed command is a
 * silent no-op, so the caller reports these loudly.
 */
export function staleCommands(known: Iterable<string>): string[] {
  const live = new Set(known);
  return PRUNED_COMMANDS.filter((id) => !live.has(id));
}
