/**
 * Parking a task against the real Tauri shell: `task_park` sets it aside
 * without closing it, the queue reports the park as held, the tree folds it
 * into its repo's "N parked" row, and `task_unpark` puts it back. Seeds one
 * task-owned throwaway repo, since `TT_STATE_SCOPE` starts the rail empty.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoRail } from "./nav.js";
import { dropQueueRow, seedQueueRow, type SeededRow } from "./seed.js";

// Mirrors TaskQueue in apps/client/src/lib/schemas/queue.ts, narrowed to what's read.
type TaskQueue = {
  items: { folderDir: string; lane: string; park: { kind: string; held: boolean } | null }[];
};

async function itemFor(dir: string) {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items.find((i) => i.folderDir === dir);
}

/** The parked counts the tree shows: a fold row, or the stub of a repo it emptied. */
async function foldRowTexts(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll("button")]
      .map((b) => (b instanceof HTMLElement ? b.innerText.trim() : ""))
      .flatMap((t) => t.match(/(?:hide )?\d+ parked$/) ?? []),
  );
}

describe("Parking a task", () => {
  let row: SeededRow;
  before(async () => {
    await bootReady();
    row = await seedQueueRow("e2e park one");
  });
  after(async () => {
    await dropQueueRow(row);
  });

  it("holds a parked task in the queue's Parked lane and keeps it open", async () => {
    await browser.tauri.execute(
      ({ core }, id) => core.invoke("task_park", { id, kind: "later", note: null, untilMs: null }),
      row.taskId,
    );
    await browser.waitUntil(async () => (await itemFor(row.dir))?.park?.held === true, {
      timeout: 15000,
      interval: 500,
      timeoutMsg: "the queue never reported the park as held",
    });
    const item = await itemFor(row.dir);
    expect(item?.lane).toBe("parked");
    expect(item?.park?.kind).toBe("later");
  });

  it("folds it into its repo's parked row on the tree", async () => {
    await gotoRail("Tree");
    await browser.waitUntil(async () => (await foldRowTexts()).includes("1 parked"), {
      timeout: 15000,
      interval: 500,
      timeoutMsg: "the tree never showed a '1 parked' row",
    });
  });

  it("puts it back on unpark", async () => {
    await browser.tauri.execute(({ core }, id) => core.invoke("task_unpark", { id }), row.taskId);
    await browser.waitUntil(async () => (await itemFor(row.dir))?.park === null, {
      timeout: 15000,
      interval: 500,
      timeoutMsg: "the queue still reported a park after unpark",
    });
    await browser.waitUntil(async () => (await foldRowTexts()).length === 0, {
      timeout: 15000,
      interval: 500,
      timeoutMsg: "the parked row outlived the unpark",
    });
  });
});
