import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface PersistedSessionOrder {
  order?: unknown;
}

/**
 * Maintains custom session ordering for reorder-session commands.
 * Stores an ordered list of session names. The `apply` method takes
 * the natural session list and returns it sorted by the custom order.
 *
 * When a `persistPath` is provided, the order is loaded from disk on
 * construction and saved after every `reorder()` call.
 */
export class SessionOrder {
  private order: string[] = [];
  private readonly persistPath: string | null;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;
    if (this.persistPath) {
      try {
        if (existsSync(this.persistPath)) {
          const raw = readFileSync(this.persistPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.order = parsed.filter((n): n is string => typeof n === "string");
          } else if (parsed && typeof parsed === "object") {
            const persisted = parsed as PersistedSessionOrder;
            if (Array.isArray(persisted.order)) {
              this.order = persisted.order.filter((n): n is string => typeof n === "string");
            }
          }
        }
      } catch {
        // Ignore corrupt file — start fresh
      }
    }
  }

  /** Sync with current session names — adds new ones alphabetically, removes stale ones. */
  sync(names: string[]): void {
    const nameSet = new Set(names);
    // Remove sessions that no longer exist
    this.order = this.order.filter((n) => nameSet.has(n));
    // Add new sessions in sorted position
    const newNames = names
      .filter((n) => !this.order.includes(n))
      .sort((a, b) => a.localeCompare(b));
    for (const n of newNames) {
      // Insert alphabetically among existing entries
      const idx = this.order.findIndex((existing) => existing.localeCompare(n) > 0);
      if (idx === -1) {
        this.order.push(n);
      } else {
        this.order.splice(idx, 0, n);
      }
    }
  }

  /** Move a session: delta -1 = up, 1 = down, "top" / "bottom" = jump to end. */
  reorder(name: string, delta: -1 | 1 | "top" | "bottom"): void {
    const idx = this.order.indexOf(name);
    if (idx === -1) return;
    if (delta === "top") {
      this.order = [name, ...this.order.filter((n) => n !== name)];
    } else if (delta === "bottom") {
      this.order = [...this.order.filter((n) => n !== name), name];
    } else {
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= this.order.length) return;
      [this.order[idx], this.order[newIdx]] = [this.order[newIdx]!, this.order[idx]!];
    }
    this.save();
  }

  /** Apply the custom order to a list of session names. Returns sorted names. */
  apply(names: string[]): string[] {
    const posMap = new Map(this.order.map((n, i) => [n, i]));
    return [...names].sort((a, b) => {
      const pa = posMap.get(a) ?? Infinity;
      const pb = posMap.get(b) ?? Infinity;
      return pa - pb;
    });
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.order) + "\n");
    } catch {
      // Best-effort — don't crash if write fails
    }
  }
}
