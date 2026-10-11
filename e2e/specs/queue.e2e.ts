/**
 * Agent Board's Queue rail — its checkouts' tasks as a queue — against the real Tauri shell.
 * Asserts the queue holds the checkouts a task owns and none it doesn't, that
 * picking a row opens it in place, and that the keyboard walks it; never which
 * checkouts a machine happens to have. Seeds two task-owned throwaway repos and
 * tracks this checkout with no task, since `TT_STATE_SCOPE` starts the rail empty.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoRail, waitForAnyDisplayed } from "./nav.js";
import { dropQueueRow, seedQueueRow, trackRepo, type SeededRow } from "./seed.js";

// Mirrors TaskQueue in apps/client/src/lib/schemas/queue.ts, narrowed to what's read.
type TaskQueue = { items: { folderDir: string; lane: string }[] };
type AgentboardState = { repos: { folders: { dir: string }[] }[] };

async function queueDirs(): Promise<string[]> {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items.map((i) => i.folderDir).toSorted();
}

async function boardDirs(): Promise<string[]> {
  const state = expectObject<AgentboardState>(
    await browser.tauri.execute(({ core }) => core.invoke("ab_get_state")),
    "ab_get_state",
  );
  return state.repos.flatMap((r) => r.folders.map((f) => f.dir)).toSorted();
}

/** The queue row picked right now. */
async function selectedRowText(): Promise<string> {
  return browser.execute(() => {
    const row = document.querySelector("[data-testid='queue-row'][aria-current='true']");
    return row instanceof HTMLElement ? row.innerText : "";
  });
}

/** Unfolds every folded lane, so every row is on screen and on the cursor's walk. */
async function unfoldLanes(): Promise<void> {
  for (const header of await browser.$$("[data-testid='queue-lane'][aria-expanded='false']")) {
    await header.click();
  }
}

describe("Agent Board queue rail", () => {
  const rows: SeededRow[] = [];
  before(async () => {
    await bootReady();
    await trackRepo(process.cwd());
    rows.push(await seedQueueRow("e2e queue one"), await seedQueueRow("e2e queue two"));
  });
  after(async () => {
    for (const row of rows) await dropQueueRow(row);
  });

  it("renders the queue rail and none of the tree", async () => {
    await gotoRail("Queue");
    await waitForAnyDisplayed('[aria-label="New task"]', "the queue's new-task +");
    expect(await (await browser.$('[aria-label="Filter repos"]')).isDisplayed()).toBe(false);
  });

  it("holds the checkouts a task owns, and none it doesn't", async () => {
    await browser.waitUntil(
      async () => {
        const [board, queue] = [await boardDirs(), await queueDirs()];
        return (
          rows.every((r) => queue.includes(r.dir)) &&
          !queue.includes(process.cwd()) &&
          queue.every((d) => board.includes(d))
        );
      },
      {
        timeout: 20000,
        interval: 1000,
        timeoutMsg: "the queue never held just the tasked checkouts",
      },
    );
  });

  it("opens a picked row in place, and j/k walk the rail", async () => {
    await gotoRail("Queue");
    await unfoldLanes();
    const first = await browser.$("[data-testid='queue-row']");
    await first.waitForDisplayed({ timeout: 10000 });
    await first.click();
    await browser.waitUntil(async () => (await selectedRowText()) !== "", {
      timeout: 10000,
      timeoutMsg: "clicking a row never selected it",
    });
    const picked = await selectedRowText();

    await browser.execute(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await browser.keys("j");
    await browser.waitUntil(async () => (await selectedRowText()) !== picked, {
      timeout: 10000,
      timeoutMsg: "j never moved the rail cursor down",
    });
    await browser.keys("k");
    await browser.waitUntil(async () => (await selectedRowText()) === picked, {
      timeout: 10000,
      timeoutMsg: "k never moved the rail cursor back up",
    });
  });

  it("opens and closes the new-task form from the rail's +", async () => {
    await gotoRail("Queue");
    const plus = await browser.$("button[aria-label='New task']");
    await plus.waitForDisplayed({ timeout: 10000 });
    await plus.click();
    const form = await browser.$("[data-testid='rail-new-task']");
    await form.waitForDisplayed({ timeout: 10000 });
    await (await browser.$("[aria-label='Repo for the new task']")).waitForDisplayed();
    await plus.click();
    await form.waitForDisplayed({ reverse: true, timeout: 10000 });
  });
});
