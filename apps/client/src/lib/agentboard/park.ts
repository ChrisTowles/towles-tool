import { Effect, Result } from "effect";
import { errorMessage, NotInTauri, type IpcError } from "@/lib/errors";
import { tomorrowMorning } from "@/lib/queue";
import type { ParkKind, QueuePark, TaskQueue } from "@/lib/schemas/queue";
import { invoke, runIpc } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import type { RepoData } from "./types";

/** Parking sets a task aside without closing it: `tt_store::ParkKind`. The
 * board status, `work_state` and the agent's status never read it. */
export const PARK_KINDS: readonly ParkKind[] = ["later", "blocked", "parked"];

export const PARK_LABEL: Record<ParkKind, { verb: string; hint: string }> = {
  later: { verb: "Park for later", hint: "Come back to it, usually on a date" },
  blocked: {
    verb: "Park as blocked",
    hint: "Waiting on something outside — comes back when its PR or CI changes",
  },
  parked: { verb: "Park", hint: "Set aside with no plan to come back soon" },
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type RevisitPreset = "none" | "tomorrow" | "week" | "date";

/** When a revisit preset brings the task back: 09:00 local, like a snooze. */
export function revisitAt(preset: RevisitPreset, now: number, date?: string): number | null {
  switch (preset) {
    case "none":
      return null;
    case "tomorrow":
      return tomorrowMorning(now);
    case "week":
      return tomorrowMorning(now + 6 * DAY_MS);
    case "date": {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const [y, m, d] = date.split("-").map(Number);
      const at = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
      return Number.isNaN(at) ? null : at;
    }
  }
}

function parkTask(
  taskId: number,
  kind: ParkKind,
  opts: { note?: string; untilMs?: number | null } = {},
): Effect.Effect<void, IpcError> {
  return invoke<void>("task_park", {
    id: taskId,
    kind,
    note: opts.note?.trim() || null,
    untilMs: opts.untilMs ?? null,
  });
}

function unparkTask(taskId: number): Effect.Effect<void, IpcError> {
  return invoke<void>("task_unpark", { id: taskId });
}

async function ran(effect: Effect.Effect<void, IpcError>, failed: string): Promise<boolean> {
  const r = await runIpc(effect);
  if (Result.isFailure(r)) {
    if (!NotInTauri.is(r.failure)) toast.error(`${failed} — ${errorMessage(r.failure)}`);
    return false;
  }
  return true;
}

/** Park and say where it went: the row folds into its repo's "N parked" row. */
export async function savePark(
  taskId: number,
  kind: ParkKind,
  opts: { note?: string; untilMs?: number | null } = {},
): Promise<boolean> {
  const ok = await ran(parkTask(taskId, kind, opts), "Couldn't park the task");
  if (ok)
    toast.success(
      kind === "blocked" ? "Parked as blocked" : `Parked${kind === "later" ? " for later" : ""}`,
    );
  return ok;
}

export async function saveUnpark(taskId: number): Promise<boolean> {
  const ok = await ran(unparkTask(taskId), "Couldn't unpark the task");
  if (ok) toast.success("Back in the list");
  return ok;
}

/** The queue's view of each parked checkout, by `folderDir`. */
export function parksByDir(queue: TaskQueue): Map<string, QueuePark> {
  const m = new Map<string, QueuePark>();
  for (const i of queue.items) if (i.park) m.set(i.folderDir, i.park);
  return m;
}

/** Repo key → the checkout dirs folded into its "N parked" row: held parks
 * only, so a due park or an agent asking stays a row of its own. The checkout
 * on screen is never folded away. */
export function parkedDirs(
  repos: readonly RepoData[],
  parks: ReadonlyMap<string, QueuePark>,
  activeFolderDir: string | null,
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of repos) {
    const dirs = new Set(
      r.folders
        .filter((f) => f.dir !== activeFolderDir && parks.get(f.dir)?.held === true)
        .map((f) => f.dir),
    );
    if (dirs.size > 0) m.set(r.key, dirs);
  }
  return m;
}

function days(ms: number): string {
  const d = Math.max(0, Math.floor(ms / DAY_MS));
  return d === 0 ? "today" : `${d}d`;
}

/** The bare fact a parked row wears: "later · 3d", "blocked · until Fri",
 * "revisit · parked 6d". A due park says why it is back. */
export function parkFact(park: QueuePark, now: number): string {
  const age = days(now - park.atMs);
  if (park.due === "date") return `revisit · parked ${age}`;
  if (park.due === "changed") return `unblocked? · parked ${age}`;
  if (park.due === "landed") return `landed · parked ${age}`;
  if (park.untilMs != null && park.untilMs > now) {
    const until = new Date(park.untilMs).toLocaleDateString(undefined, {
      weekday: "short",
      month: park.untilMs - now > 6 * DAY_MS ? "short" : undefined,
      day: park.untilMs - now > 6 * DAY_MS ? "numeric" : undefined,
    });
    return `${park.kind} · until ${until}`;
  }
  return `${park.kind} · ${age}`;
}
