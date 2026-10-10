/**
 * Cockpit screen against the real Tauri shell. Read-only — asserts the panels
 * mount and the repo chips follow the snapshot, never which PRs are listed.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen, waitForAnyDisplayed } from "./nav.js";

// The fields Cockpit's repo list reads (apps/client/src/screens/cockpit.tsx).
type QueueItem = { repo: string; state?: string; dismissedTs: number; updatedTs: number };
type StoreSnapshot = { prs: QueueItem[]; issues: QueueItem[]; ciRuns: { repo: string }[] };
// Mirrors TaskQueue in apps/client/src/lib/schemas/queue.ts, narrowed to the keys.
type TaskQueue = { items: { key: { kind: string; id?: number } }[] };

// Mirrors isItemDismissed (apps/client/src/lib/data.ts) exactly; importing it would drag
// the client's Tauri/React module graph into the wdio worker.
const isItemDismissed = (item: QueueItem) =>
  item.dismissedTs > 0 && item.dismissedTs >= item.updatedTs;

/** Same as the screen: open, undismissed PRs; undismissed issues; every CI run. */
function cockpitRepoCount(snapshot: StoreSnapshot): number {
  const rows = [...snapshot.prs.filter((pr) => pr.state === "open"), ...snapshot.issues];
  const live = rows.filter((row) => !isItemDismissed(row)).map((row) => row.repo);
  return new Set([...live, ...snapshot.ciRuns.map((run) => run.repo)]).size;
}

describe("Cockpit screen", () => {
  before(bootReady);

  it("navigates to Cockpit and renders the task queue and both GitHub panels", async () => {
    await gotoScreen("Cockpit");
    await waitForAnyDisplayed("div=Queue", "task queue panel");
    // Panel (components/store-bits.tsx) titles its header with a div, not a heading.
    await waitForAnyDisplayed("div=Pull requests", "PR panel");
    await waitForAnyDisplayed("div=Issue queue", "issue panel");
  });

  it("answers the queues over store_snapshot IPC", async () => {
    const snapshot = expectObject<StoreSnapshot>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    expect(Array.isArray(snapshot.prs)).toBe(true);
    expect(Array.isArray(snapshot.issues)).toBe(true);
  });

  it("shows the repo filter chips only when the snapshot spans more than one repo", async () => {
    const snapshot = expectObject<StoreSnapshot>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    const allRepos = await browser.$("button=All repos");
    if (cockpitRepoCount(snapshot) > 1) {
      await allRepos.waitForDisplayed({ timeout: 10000 });
    } else {
      expect(await allRepos.isExisting()).toBe(false);
    }
  });

  it("reorders the task queue by rank and keeps it", async () => {
    const add = async (text: string) => {
      const id = await browser.tauri.execute(
        ({ core }, t) => core.invoke("store_add_task", { text: t }),
        text,
      );
      if (typeof id !== "number") throw new TypeError(`store_add_task answered ${id}`);
      return id;
    };
    const order = async (ids: number[]) => {
      const queue = expectObject<TaskQueue>(
        await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
        "queue_get",
      );
      return queue.items
        .filter((i) => i.key.kind === "task" && ids.includes(i.key.id ?? -1))
        .map((i) => i.key.id);
    };
    const a = await add("e2e queue first");
    const b = await add("e2e queue second");
    try {
      await browser.waitUntil(async () => (await order([a, b])).length === 2, { timeout: 10000 });
      const before = await order([a, b]);
      expect(before.indexOf(a)).toBeLessThan(before.indexOf(b));
      await browser.tauri.execute(
        ({ core }, id) => core.invoke("queue_move", { id, to: "top" }),
        b,
      );
      await browser.waitUntil(async () => (await order([a, b]))[0] === b, { timeout: 10000 });
    } finally {
      for (const id of [a, b]) {
        await browser.tauri.execute(
          ({ core }, taskId) =>
            core.invoke("task_delete", { id: taskId, force: false, purge: true }),
          id,
        );
      }
    }
  });
});
