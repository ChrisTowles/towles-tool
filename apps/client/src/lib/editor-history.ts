export type FileHistory = {
  readonly stack: readonly string[];
  readonly index: number;
};

export const NO_HISTORY: FileHistory = { stack: [], index: -1 };

const LIMIT = 50;

export function currentPath(history: FileHistory): string | null {
  return history.index >= 0 ? (history.stack[history.index] ?? null) : null;
}

export function openPath(history: FileHistory, path: string): FileHistory {
  if (currentPath(history) === path) return history;
  const kept = history.stack.slice(0, history.index + 1);
  kept.push(path);
  const overflow = Math.max(0, kept.length - LIMIT);
  return { stack: kept.slice(overflow), index: kept.length - overflow - 1 };
}

export function canGoBack(history: FileHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: FileHistory): boolean {
  return history.index >= 0 && history.index < history.stack.length - 1;
}

export function back(history: FileHistory): FileHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function forward(history: FileHistory): FileHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}
