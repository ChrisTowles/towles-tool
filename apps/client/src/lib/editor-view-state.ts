const LIMIT = 100;

const states = new Map<string, unknown>();

export function viewStateKey(dir: string, path: string): string {
  return `${dir} ${path}`;
}

export function rememberViewState(key: string, state: unknown): void {
  states.delete(key);
  states.set(key, state);
  if (states.size > LIMIT) {
    const oldest = states.keys().next();
    if (!oldest.done) states.delete(oldest.value);
  }
}

export function recallViewState(key: string): unknown | null {
  if (!states.has(key)) return null;
  const state = states.get(key);
  states.delete(key);
  states.set(key, state);
  return state ?? null;
}

export function clearViewStates(): void {
  states.clear();
}

export function viewStateCount(): number {
  return states.size;
}
