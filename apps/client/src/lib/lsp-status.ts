/** What the LSP bridge (`lib/lsp.ts`) is doing, as a store any component can
 * read. Split out because `lsp.ts` statically imports `@/lib/monaco`, so any
 * static importer of it drags the whole (otherwise lazy) monaco graph into the
 * entry chunk — and the Files pane only wants a badge. */

import { useSyncExternalStore } from "react";

/** `off` is also "not under Tauri"; `failed` is usually no rust-analyzer on PATH. */
type LspState = "off" | "starting" | "ready" | "failed";
export type LspStatus = { state: LspState; dir: string | null; detail?: string };

/** One shared object for every folder the server isn't following, so the hook
 * returns a stable reference without a per-dir cache to grow unbounded. */
const OFF: LspStatus = { state: "off", dir: null };

let status: LspStatus = OFF;
const listeners = new Set<() => void>();

export function setLspStatus(next: LspStatus): void {
  status = next;
  for (const fn of [...listeners]) fn();
}

/** Snapshot for `useSyncExternalStore` — stable reference until it changes. */
const lspStatus = (): LspStatus => status;

const subscribeLspStatus = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Bridge status for one folder — `off` unless this folder is the one the
 * single shared server currently follows. */
export function useLspStatus(dir: string | undefined): LspStatus {
  const s = useSyncExternalStore(subscribeLspStatus, lspStatus);
  return dir != null && s.dir === dir ? s : OFF;
}
