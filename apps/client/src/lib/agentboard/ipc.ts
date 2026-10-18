/** Client-side view of the agentboard bridge (`crates-tauri/tt-app/src/agentboard.rs`). */

import { invoke, runIpc } from "@/lib/tauri";

/** `started` is `false` only for a deduped no-op: a sync was already in flight. */
export type RepoSyncResult = {
  started: boolean;
  ok: boolean;
  count: number;
  message?: string | null;
};

/** Sync issues + PRs from GitHub now, bypassing the collector's poll cadence. */
export const abSyncRepo = (dir: string) =>
  runIpc(invoke<RepoSyncResult>("store_sync_repo", { dir }));

export const abSetSessionPurpose = (id: string, text: string | null) =>
  runIpc(invoke("ab_set_session_purpose", { id, text }));
