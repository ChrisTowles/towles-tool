// Optimistic edits painted over the store snapshot's tasks. Contract:
// docs/CLIENT-STATE.md.
import * as Atom from "effect/reactivity/Atom";
import { write } from "@/lib/atoms/registry";
import type { TaskItem, TaskOutcome } from "@/lib/data";

/** The fields a rename or notes edit paints; `notes: undefined` is a clear. */
export type TaskEdit = { text?: string; notes?: string | undefined };

/** What the snapshot said when an override was painted. The override lives
 * only while the snapshot still says this, so the first snapshot that carries
 * a change to the field (ours, or a CLI's) retires it. */
type EditOverride = { base: { text: string; notes: string | undefined }; set: TaskEdit };
type CloseOverride = { base: TaskOutcome | undefined; outcome: TaskOutcome };

export type TaskOverrides = Readonly<{
  edits: Readonly<Record<number, EditOverride>>;
  closes: Readonly<Record<number, CloseOverride>>;
  /** Purged cards, hidden until the snapshot drops them. */
  deleted: ReadonlySet<number>;
}>;

export const NO_OVERRIDES: TaskOverrides = { edits: {}, closes: {}, deleted: new Set() };

/** `task` with its live overrides painted; `task` itself when none is. */
function paint(task: TaskItem, o: TaskOverrides): TaskItem {
  const edit = o.edits[task.id];
  const close = o.closes[task.id];
  const editIsLive = edit !== undefined && editLive(edit, task);
  const closeLive = close !== undefined && close.base === task.outcome;
  if (!editIsLive && !closeLive) return task;
  return {
    ...task,
    ...(editIsLive ? edit.set : null),
    ...(closeLive ? { outcome: close.outcome } : null),
  };
}

/** The tasks as the user should see them: overrides still agreeing with the
 * snapshot painted over it, purged cards removed. */
export function applyTaskOverrides(tasks: readonly TaskItem[], o: TaskOverrides): TaskItem[] {
  return tasks.filter((t) => !o.deleted.has(t.id)).map((t) => paint(t, o));
}

/** Paint `set` over task `id`, keeping the first base so chained edits stay
 * pinned to what the snapshot said before any of them. */
export function withEdit(
  o: TaskOverrides,
  task: Pick<TaskItem, "id" | "text" | "notes">,
  set: TaskEdit,
): TaskOverrides {
  const prev = o.edits[task.id];
  const live = prev && editLive(prev, task);
  const base = live ? prev.base : { text: task.text, notes: task.notes };
  const merged = live ? { ...prev.set, ...set } : set;
  return { ...o, edits: { ...o.edits, [task.id]: { base, set: merged } } };
}

export function withClose(
  o: TaskOverrides,
  task: Pick<TaskItem, "id" | "outcome">,
  outcome: TaskOutcome,
): TaskOverrides {
  return { ...o, closes: { ...o.closes, [task.id]: { base: task.outcome, outcome } } };
}

export function withDeleted(o: TaskOverrides, id: number): TaskOverrides {
  return { ...o, deleted: new Set(o.deleted).add(id) };
}

/** Drop only the failed edit, leaving a close in flight on the same card. */
export function withoutEdit(o: TaskOverrides, id: number): TaskOverrides {
  const { [id]: _edit, ...edits } = o.edits;
  return { ...o, edits };
}

/** Drop only the failed close. */
export function withoutClose(o: TaskOverrides, id: number): TaskOverrides {
  const { [id]: _close, ...closes } = o.closes;
  return { ...o, closes };
}

/** Drop only a failed purge. */
export function withoutDeleted(o: TaskOverrides, id: number): TaskOverrides {
  const deleted = new Set(o.deleted);
  deleted.delete(id);
  return { ...o, deleted };
}

function editLive(e: EditOverride, t: Pick<TaskItem, "text" | "notes">): boolean {
  return e.base.text === t.text && e.base.notes === t.notes;
}

/** `o` without what `tasks` (a snapshot just accepted) has retired: an edit or
 * close whose field moved, and anything for a task the snapshot no longer has.
 * Dropped for good, so a later change back to the old value is not shadowed.
 * `o` itself when nothing goes. */
export function settleTaskOverrides(o: TaskOverrides, tasks: readonly TaskItem[]): TaskOverrides {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edits = Object.fromEntries(
    Object.entries(o.edits).filter(([id, e]) => {
      const t = byId.get(Number(id));
      return t !== undefined && editLive(e, t);
    }),
  );
  const closes = Object.fromEntries(
    Object.entries(o.closes).filter(([id, c]) => {
      const t = byId.get(Number(id));
      return t !== undefined && t.outcome === c.base;
    }),
  );
  const deleted = new Set([...o.deleted].filter((id) => byId.has(id)));
  const same =
    Object.keys(edits).length === Object.keys(o.edits).length &&
    Object.keys(closes).length === Object.keys(o.closes).length &&
    deleted.size === o.deleted.size;
  return same ? o : { edits, closes, deleted };
}

const state = Atom.make<TaskOverrides>(NO_OVERRIDES).pipe(Atom.keepAlive);

export const taskOverridesAtom: Atom.Atom<TaskOverrides> = state;

const writer = Atom.writable(
  (get) => get(state),
  (ctx, t: (o: TaskOverrides) => TaskOverrides) => ctx.set(state, t(ctx.get(state))),
);

/** The one writer: apply a pure transition to the overrides now. */
export const updateTaskOverrides = (t: (o: TaskOverrides) => TaskOverrides): void =>
  write(writer, t);
