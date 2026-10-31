/** Track/untrack as one seam. The Settings pane and the rail's kebab both
 * untrack, and when each owned a copy they drifted — one checked the `Result`,
 * one emitted its `ui.action` event, one suppressed `NotInTauri`. */
import { toast } from "@/lib/toast";
import { NotInTauri } from "@/lib/errors";
import type { ScreenId } from "@/lib/screens";
import { Result } from "effect";
import { invoke, runIpc } from "@/lib/tauri";
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
  const added = await runIpc(invoke("ab_add_repo", { path }));
  if (Result.isFailure(added)) {
    if (!NotInTauri.is(added.failure)) {
      toast.error(`Couldn't track ${path} — ${added.failure.message}`);
    }
    return false;
  }
  uiAction("repo.tracked", screen);
  return true;
}

/** Archive hides a repo; restore brings it back. Nothing is closed or removed
 * either way, so neither needs a confirm — the toast carries the undo. */
export async function setRepoArchived(
  dir: string,
  name: string,
  archived: boolean,
  screen: ScreenId,
): Promise<boolean> {
  const result = await runIpc(invoke("ab_set_repo_archived", { dir, archived }));
  if (Result.isFailure(result)) {
    if (!NotInTauri.is(result.failure)) {
      toast.error(
        `Couldn't ${archived ? "archive" : "restore"} ${name} — ${result.failure.message}`,
      );
    }
    return false;
  }
  uiAction(archived ? "repo.archived" : "repo.restored", screen);
  if (archived) {
    toast.success(`Archived ${name}`, {
      description: "Restore it from Archived at the bottom of the rail.",
      actions: [{ label: "Undo", onClick: () => void setRepoArchived(dir, name, false, screen) }],
    });
  }
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
    await runIpc(invoke("ab_close_session", { id }));
  }
  const removed = await runIpc(invoke("ab_remove_repo", { dir }));
  if (Result.isFailure(removed)) {
    if (!NotInTauri.is(removed.failure)) {
      toast.error(`Couldn't untrack ${name} — ${removed.failure.message}`);
    }
    return false;
  }
  uiAction("repo.untracked", screen);
  return true;
}
