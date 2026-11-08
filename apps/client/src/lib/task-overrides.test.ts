import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/lib/data";
import {
  NO_OVERRIDES,
  applyTaskOverrides,
  withClose,
  withDeleted,
  withEdit,
  withoutEdit,
  withoutClose,
  withoutDeleted,
  settleTaskOverrides,
} from "./task-overrides";

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 1,
  text: "old",
  status: "backlog",
  rank: 0,
  createdAt: 0,
  issues: [],
  prs: [],
  closed: false,
  hasWorktree: false,
  ...over,
});

describe("task overrides", () => {
  it("paints an edit until the snapshot carries a change to the field", () => {
    const t = task();
    const o = withEdit(NO_OVERRIDES, t, { text: "new" });
    expect(applyTaskOverrides([t], o)[0]!.text).toBe("new");
    // The snapshot catches up: it shows the edit, and the override retires.
    expect(applyTaskOverrides([task({ text: "new" })], o)[0]!.text).toBe("new");
    // A later rename from elsewhere is not shadowed by the stale override.
    expect(applyTaskOverrides([task({ text: "from cli" })], o)[0]!.text).toBe("from cli");
    // Once settled it is gone for good, even if the text returns to the base.
    const settled = settleTaskOverrides(o, [task({ text: "new" })]);
    expect(settled.edits).toEqual({});
    expect(applyTaskOverrides([task({ text: "old" })], settled)[0]!.text).toBe("old");
  });

  it("keeps overrides the snapshot has not caught up with, and drops a vanished task's", () => {
    const t = task();
    const o = withDeleted(withClose(withEdit(NO_OVERRIDES, t, { text: "new" }), t, "done"), 1);
    expect(settleTaskOverrides(o, [t])).toBe(o);
    const gone = settleTaskOverrides(o, []);
    expect(gone).toEqual(NO_OVERRIDES);
  });

  it("keeps chained edits pinned to the first base", () => {
    const t = task();
    let o = withEdit(NO_OVERRIDES, t, { text: "a" });
    o = withEdit(o, t, { notes: "n" });
    const [shown] = applyTaskOverrides([t], o);
    expect(shown).toMatchObject({ text: "a", notes: "n" });
  });

  it("paints a cleared note as unset", () => {
    const t = task({ notes: "keep" });
    const o = withEdit(NO_OVERRIDES, t, { notes: undefined });
    expect(applyTaskOverrides([t], o)[0]!.notes).toBeUndefined();
  });

  it("paints a close until the snapshot's outcome moves, so a reopen is not stale", () => {
    const t = task();
    const o = withClose(NO_OVERRIDES, t, "done");
    expect(applyTaskOverrides([t], o)[0]!.outcome).toBe("done");
    // The teardown shows up in an unrelated field first: still painted.
    expect(applyTaskOverrides([task({ rank: 5 })], o)[0]!.outcome).toBe("done");
    // Closed in the snapshot, then reopened (outcome cleared): not re-shadowed.
    expect(applyTaskOverrides([task({ outcome: "done" })], o)[0]!.outcome).toBe("done");
    const settled = settleTaskOverrides(o, [task({ outcome: "done" })]);
    expect(settled.closes).toEqual({});
    expect(applyTaskOverrides([task()], settled)[0]!.outcome).toBeUndefined();
  });

  it("hides a purged card and restores it when the write fails", () => {
    const t = task();
    const o = withDeleted(NO_OVERRIDES, 1);
    expect(applyTaskOverrides([t], o)).toEqual([]);
    expect(applyTaskOverrides([t], withoutDeleted(o, 1))).toEqual([t]);
  });

  it("drops a failed edit or close", () => {
    const t = task();
    const e = withEdit(NO_OVERRIDES, t, { text: "new" });
    expect(applyTaskOverrides([t], withoutEdit(e, 1))[0]!.text).toBe("old");
    const c = withClose(NO_OVERRIDES, t, "done");
    expect(applyTaskOverrides([t], withoutClose(c, 1))[0]!.outcome).toBeUndefined();
  });

  it("returns task identity when nothing is painted", () => {
    const t = task();
    expect(applyTaskOverrides([t], NO_OVERRIDES)[0]).toBe(t);
  });
});
