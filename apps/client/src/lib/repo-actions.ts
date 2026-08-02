/** Track/untrack as one seam. The Settings pane and the rail's kebab both
 * untrack, and when each owned a copy they drifted — one checked the `Result`,
 * one emitted its `ui.action` event, one suppressed `NotInTauri`. */
import { toast } from "sonner";
import { NotInTauri } from "@/lib/errors";
import type { ScreenId } from "@/lib/screens";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

/** What {@link untrackRepo} must close, and what a caller counts when
 * confirming. */
export function liveSessionIds(repo: {
  folders: { sessions: { id: string; live: boolean }[] }[];
}): string[] {
  return repo.folders.flatMap((f) => f.sessions.filter((s) => s.live).map((s) => s.id));
}

/** Returns whether it is tracked now, so a caller can avoid announcing an add
 * that didn't happen. `NotInTauri` is swallowed: browser dev has no host. */
export async function trackRepo(rawPath: string, screen: ScreenId): Promise<boolean> {
  const path = rawPath.trim();
  if (!path) return false;
  const added = await invoke("ab_add_repo", { path });
  if (added.isErr()) {
    if (!NotInTauri.is(added.error)) toast.error(`Couldn't track ${path} — ${added.error.message}`);
    return false;
  }
  uiAction("repo.tracked", screen);
  return true;
}

/** Closes the live PTYs **first**: untrack first and the sessions are orphaned
 * — the repo leaves the rail and no UI can reach them again. Callers confirm
 * beforehand whenever `sessionIds` is non-empty; there is no undo. */
export async function untrackRepo(
  dir: string,
  name: string,
  sessionIds: readonly string[],
  screen: ScreenId,
): Promise<boolean> {
  for (const id of sessionIds) {
    await invoke("ab_close_session", { id });
  }
  const removed = await invoke("ab_remove_repo", { dir });
  if (removed.isErr()) {
    if (!NotInTauri.is(removed.error)) {
      toast.error(`Couldn't untrack ${name} — ${removed.error.message}`);
    }
    return false;
  }
  uiAction("repo.untracked", screen);
  return true;
}
