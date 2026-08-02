/** One-shot deep-link primitive for the Settings screen: land on Settings and
 * jump to `tab`, optionally pre-filled with `filter`. A DOM-free singleton like
 * {@link "./focus-target".FocusTargetStore}, so it's testable and dodges the
 * `workspace.tsx` ↔ Settings screen import cycle. */

export type SettingsTarget = { tab: string; filter?: string };

class SettingsTargetStore {
  private target: SettingsTarget | null = null;
  private listeners = new Set<() => void>();

  /** Snapshot for `useSyncExternalStore` — stable reference until it changes. */
  get = (): SettingsTarget | null => this.target;

  set(target: SettingsTarget): void {
    this.target = target;
    this.emit();
  }

  /** One-shot read: returns (and clears) the pending target, if any. */
  consume(): SettingsTarget | null {
    if (this.target === null) return null;
    const consumed = this.target;
    this.target = null;
    return consumed;
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

/** App-wide singleton: at most one pending settings deep link at a time. */
export const settingsTargetStore = new SettingsTargetStore();
