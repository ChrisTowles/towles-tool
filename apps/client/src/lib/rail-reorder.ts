import { Effect, Result } from "effect";
import { isHomeRepo } from "@/lib/agentboard/folder";
import type { FolderData, RepoData } from "@/lib/agentboard/types";
import { errorMessage, NotInTauri, type IpcError } from "@/lib/errors";
import { reorderDirs } from "@/lib/repo-manager";
import { invoke, runIpc } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

/** A task's place in the tree is its queue rank (`tasks.rank`), so a move here
 * is a move there too. The root checkout and `~` own no task and never move. */
export type TaskRankMove = { before: number } | { after: number };

function taskId(f: FolderData): number | null {
  return f.record.origin === "task" || f.record.origin === "detected" ? f.record.task.id : null;
}

/** One step up or down among the repo's task rows as rendered, or null at an
 * end or on a row no task owns. */
export function taskStepMove(
  folders: readonly FolderData[],
  dir: string,
  direction: "up" | "down",
): { id: number; to: TaskRankMove } | null {
  const tasks = folders.filter((f) => taskId(f) !== null);
  const at = tasks.findIndex((f) => f.dir === dir);
  if (at < 0) return null;
  const id = taskId(tasks[at]) as number;
  const neighbour = tasks[direction === "up" ? at - 1 : at + 1];
  if (!neighbour) return null;
  const other = taskId(neighbour) as number;
  return { id, to: direction === "up" ? { before: other } : { after: other } };
}

/** A drop of `dragged` on `target`: it lands before the target when moving up,
 * after it when moving down, so the dragged row takes the target's place. */
export function taskDropMove(
  folders: readonly FolderData[],
  dragged: string,
  target: string,
): { id: number; to: TaskRankMove } | null {
  if (dragged === target) return null;
  const tasks = folders.filter((f) => taskId(f) !== null);
  const from = tasks.findIndex((f) => f.dir === dragged);
  const to = tasks.findIndex((f) => f.dir === target);
  if (from < 0 || to < 0) return null;
  const id = taskId(tasks[from]) as number;
  const other = taskId(tasks[to]) as number;
  return { id, to: from > to ? { before: other } : { after: other } };
}

/** Every tracked repo in payload order, archived ones too, so a move keeps
 * the place of repos off screen. `~` is not in `repos.json`. */
export function railRepoDirs(repos: readonly RepoData[]): string[] {
  return repos.filter((r) => !isHomeRepo(r)).map((r) => r.dir);
}

/** The repo order after one step of `dir`, or null at an end. `dirs` is every
 * tracked repo in rail order, so repos off screen keep their place. */
export function repoStepOrder(
  dirs: readonly string[],
  dir: string,
  direction: "up" | "down",
): string[] | null {
  const at = dirs.indexOf(dir);
  if (at < 0) return null;
  if (direction === "up") return at === 0 ? null : reorderDirs(dirs, dir, dirs[at - 1]);
  if (at === dirs.length - 1) return null;
  return reorderDirs(dirs, dir, dirs[at + 2] ?? "end");
}

/** The repo order after `dragged` drops on `target`: it takes the target's place. */
export function repoDropOrder(
  dirs: readonly string[],
  dragged: string,
  target: string,
): string[] | null {
  const from = dirs.indexOf(dragged);
  const to = dirs.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  return reorderDirs(dirs, dragged, from > to ? target : (dirs[to + 1] ?? "end"));
}

async function report(effect: Effect.Effect<unknown, IpcError>, what: string): Promise<void> {
  const r = await runIpc(effect);
  if (Result.isFailure(r) && !NotInTauri.is(r.failure)) {
    toast.error(`Couldn't save the ${what} — ${errorMessage(r.failure)}`);
  }
}

/** Writes the task's shared rank; the snapshot that follows redraws both rails. */
export function saveTaskMove(
  move: { id: number; to: TaskRankMove },
  how: "drag" | "keys",
): Promise<void> {
  uiAction("rail.task_reorder", "agentboard", how);
  return report(invoke<void>("queue_move", { id: move.id, to: move.to }), "task order");
}

export function saveRepoOrder(dirs: string[], how: "drag" | "keys"): Promise<void> {
  uiAction("repo.reordered", "agentboard", `tree.${how}`);
  return report(invoke<void>("ab_set_repo_order", { dirs }), "repo order");
}
