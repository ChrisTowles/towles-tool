import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ScreenId } from "./screens";

/** Deep-link focus: `openTab(screen)` lands on a screen but never on a row, so a
 * {@link FocusTarget} carries "reveal *this* row once you're there" — a one-shot,
 * not a persistent selection. A DOM-free singleton to dodge an import cycle
 * between `workspace.tsx` and the destination screens. */

export type FocusKind = "pr" | "todo" | "repo" | "issue";

export type FocusTarget = { screen: ScreenId; kind: FocusKind; id: string };

export class FocusTargetStore {
  private target: FocusTarget | null = null;
  private listeners = new Set<() => void>();

  get = (): FocusTarget | null => this.target;

  set(target: FocusTarget): void {
    this.target = target;
    this.emit();
  }

  /** A request for another screen is left in place for its real destination. */
  consume(screen: ScreenId): FocusTarget | null {
    if (this.target === null || this.target.screen !== screen) return null;
    const consumed = this.target;
    this.target = null;
    this.emit();
    return consumed;
  }

  clear(): void {
    if (this.target === null) return;
    this.target = null;
    this.emit();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

export const focusTargetStore = new FocusTargetStore();

/** Literals, so Tailwind's scanner keeps them in the build. */
const FLASH_CLASSES = ["ring-2", "ring-inset", "ring-amber-400", "dark:ring-amber-500"];
const FLASH_MS = 1600;
/** The row may not be painted yet (snapshot still loading) — retry a few frames. */
const MAX_ATTEMPTS = 12;
const RETRY_MS = 150;

/** Matched on the dataset: ids hold `/` and `#`, so a selector would be fragile. */
export function findFocusRow(
  container: HTMLElement,
  kind: FocusKind,
  id: string,
): HTMLElement | null {
  const rows = container.querySelectorAll<HTMLElement>(`[data-focus-kind="${kind}"]`);
  for (const row of rows) {
    if (row.dataset.focusId === id) return row;
  }
  return null;
}

function flashRow(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(...FLASH_CLASSES);
  window.setTimeout(() => el.classList.remove(...FLASH_CLASSES), FLASH_MS);
}

/** Attach the returned ref to the scroll container holding the
 * `data-focus-kind`/`data-focus-id` rows. Scoping the lookup to it keeps a
 * still-mounted background screen's identical row from matching. */
export function useFocusTarget<T extends HTMLElement>(screen: ScreenId) {
  const containerRef = useRef<T>(null);
  const focusTarget = useSyncExternalStore(
    focusTargetStore.subscribe,
    focusTargetStore.get,
    focusTargetStore.get,
  );

  useEffect(() => {
    if (!focusTarget || focusTarget.screen !== screen) return;
    const target = focusTargetStore.consume(screen);
    if (!target) return;

    let attempts = 0;
    let timer = 0;
    const attempt = () => {
      const container = containerRef.current;
      const el = container ? findFocusRow(container, target.kind, target.id) : null;
      if (el) {
        flashRow(el);
        return;
      }
      if (++attempts < MAX_ATTEMPTS) timer = window.setTimeout(attempt, RETRY_MS);
    };
    attempt();

    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [focusTarget, screen]);

  return containerRef;
}
