/**
 * Board screen against the real Tauri shell. Asserts structure, never
 * machine-specific contents. The filter test seeds two tasks over real store
 * IPC and purges them in `after`, leaving the forced-scope tt.db as found.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen } from "./nav.js";

// Mirrors StoreSnapshot in apps/client/src/lib/data.ts, narrowed to what Board reads.
type StoreSnapshot = {
  tasks: unknown[];
  events: unknown[];
  issues: unknown[];
  prs: unknown[];
};

const CARD = '[data-focus-kind="todo"]';
const FILTER = '[aria-label="Filter tasks"]';

async function addTask(title: string): Promise<number> {
  const id = await browser.tauri.execute(
    ({ core }, text) => core.invoke("store_add_task", { text }),
    title,
  );
  if (typeof id !== "number") throw new TypeError(`store_add_task should answer an id, got ${id}`);
  return id;
}

/** `purge` is the one permanent row delete; `force` stays off so a bound
 * worktree (never the case for these cards) would refuse rather than tear down. */
async function purgeTask(id: number): Promise<void> {
  const outcome = expectObject<{ status: string }>(
    await browser.tauri.execute(
      ({ core }, taskId) => core.invoke("task_delete", { id: taskId, force: false, purge: true }),
      id,
    ),
    "task_delete",
  );
  expect(outcome.status).toBe("deleted");
}

async function cardTitles(): Promise<string[]> {
  const out: string[] = [];
  for (const card of await browser.$$(CARD)) out.push((await card.getText()).trim());
  return out;
}

async function waitForCardCount(count: number, why: string): Promise<void> {
  await browser.waitUntil(async () => (await browser.$$(CARD).length) === count, {
    timeout: 15000,
    timeoutMsg: `${why}: the board never showed ${count} card(s)`,
  });
}

describe("Board screen", () => {
  before(bootReady);

  it("answers the store snapshot over store_snapshot IPC", async () => {
    const snapshot = expectObject<StoreSnapshot>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    expect(Array.isArray(snapshot.tasks)).toBe(true);
    expect(Array.isArray(snapshot.events)).toBe(true);
    expect(Array.isArray(snapshot.issues)).toBe(true);
    expect(Array.isArray(snapshot.prs)).toBe(true);
  });

  it("navigates to Board and renders the filter control", async () => {
    await gotoScreen("Board");
    // The toolbar renders above the empty-state branch, so this holds at zero tasks.
    const filter = await browser.$(FILTER);
    await filter.waitForDisplayed({ timeout: 10000 });
  });

  it("renders the group-into-swimlanes toggle", async () => {
    const swimlanes = await browser.$('[aria-label="Group tasks into repo swimlanes"]');
    await swimlanes.waitForExist({ timeout: 10000 });
  });

  describe("filtering", () => {
    const stamp = Date.now().toString(36);
    const needle = `e2e-needle-${stamp}`;
    const decoy = `e2e-decoy-${stamp}`;
    const seeded: number[] = [];

    // A run aborted before `after` leaves its cards behind; purge them first.
    before(async () => {
      const snapshot = expectObject<{ tasks: { id: number; text: string }[] }>(
        await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
        "store_snapshot",
      );
      for (const t of snapshot.tasks) {
        if (/^e2e-(needle|decoy)-/.test(t.text)) await purgeTask(t.id);
      }
    });

    after(async () => {
      const failures: string[] = [];
      try {
        for (const id of [...seeded]) {
          try {
            await purgeTask(id);
          } catch (e) {
            failures.push(`${id}: ${String(e)}`);
          }
        }
        seeded.splice(0);
      } finally {
        const filter = await browser.$(FILTER);
        if (await filter.isExisting()) await filter.setValue("");
      }
      if (failures.length > 0) throw new Error(`purge failed for ${failures.join("; ")}`);
    });

    it("shows only the matching card and counts the rest as hidden", async () => {
      const baseline = await browser.$$(CARD).length;
      seeded.push(await addTask(needle));
      seeded.push(await addTask(decoy));
      await waitForCardCount(baseline + 2, "after seeding two tasks");

      const filter = await browser.$(FILTER);
      await filter.setValue(needle);
      await waitForCardCount(1, "with the needle typed");
      expect(await cardTitles()).toEqual([needle]);

      const hidden = await browser.$(`span=${baseline + 1} hidden`);
      await hidden.waitForDisplayed({ timeout: 10000 });

      await filter.setValue("");
      await waitForCardCount(baseline + 2, "after clearing the filter");
    });
  });
});
