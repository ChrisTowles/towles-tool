/**
 * Cockpit — the agent board driven by the queue — against the real Tauri shell.
 * Asserts the rail is the queue, that picking a row opens it in place, and that
 * the keyboard walks it; never which PRs or checkouts a machine happens to have.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen, waitForAnyDisplayed } from "./nav.js";

// Mirrors TaskQueue in apps/client/src/lib/schemas/queue.ts, narrowed to what's read.
type TaskQueue = { items: { key: { kind: string; id?: number }; title: string }[] };

async function addTask(text: string): Promise<number> {
  const id = await browser.tauri.execute(
    ({ core }, t) => core.invoke("store_add_task", { text: t }),
    text,
  );
  if (typeof id !== "number") throw new TypeError(`store_add_task answered ${id}`);
  return id;
}

async function deleteTasks(ids: number[]): Promise<void> {
  for (const id of ids) {
    await browser.tauri.execute(
      ({ core }, taskId) => core.invoke("task_delete", { id: taskId, force: false, purge: true }),
      id,
    );
  }
}

async function queueOrder(ids: number[]): Promise<(number | undefined)[]> {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items
    .filter((i) => i.key.kind === "task" && ids.includes(i.key.id ?? -1))
    .map((i) => i.key.id);
}

/** The rail row picked right now — the sidebar's own `aria-current` excluded. */
async function selectedRowText(): Promise<string> {
  return browser.execute(() => {
    const rows = [...document.querySelectorAll("button[aria-current='true']")];
    const row = rows.find((r) => !r.hasAttribute("aria-label"));
    return row instanceof HTMLElement ? row.innerText : "";
  });
}

describe("Cockpit screen", () => {
  before(bootReady);

  it("navigates to Cockpit and renders the queue rail with its drawers", async () => {
    await gotoScreen("Cockpit");
    // RailDrawer titles are uppercase via CSS; WebDriver reads the rendered text.
    await waitForAnyDisplayed("button*=Checkouts", "checkouts drawer");
    await waitForAnyDisplayed("button*=Issues", "issues drawer");
    await waitForAnyDisplayed("button*=Refresh", "header refresh");
  });

  it("answers the queue and snapshot over IPC", async () => {
    const queue = expectObject<TaskQueue>(
      await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
      "queue_get",
    );
    expect(Array.isArray(queue.items)).toBe(true);
    const snapshot = expectObject<{ ciRuns: unknown[] }>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    expect(Array.isArray(snapshot.ciRuns)).toBe(true);
  });

  it("opens a picked row in place, and j/k walk the rail", async () => {
    const a = await addTask("e2e cockpit first");
    const b = await addTask("e2e cockpit second");
    try {
      await browser.waitUntil(async () => (await queueOrder([a, b])).length === 2, {
        timeout: 10000,
      });
      // The top backlog task is promoted to Next up's `start`, in On you.
      const row = await browser.$("button*=e2e cockpit first");
      await row.waitForDisplayed({ timeout: 10000 });
      await row.click();
      await waitForAnyDisplayed("button*=Start agent", "a checkout-less row's detail");
      expect(await selectedRowText()).toContain("e2e cockpit first");

      // The second task sits in the folded Backlog lane; unfold it to walk onto it.
      const backlog = await browser.$("button*=Backlog");
      await backlog.click();
      await (await browser.$("button*=e2e cockpit second")).waitForDisplayed({ timeout: 10000 });
      await browser.execute(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await browser.keys("j");
      await browser.waitUntil(
        async () => (await selectedRowText()).includes("e2e cockpit second"),
        { timeout: 10000, timeoutMsg: "j never moved the rail cursor down" },
      );
      await browser.keys("k");
      await browser.waitUntil(
        async () => (await selectedRowText()).includes("e2e cockpit first"),
        { timeout: 10000, timeoutMsg: "k never moved the rail cursor back up" },
      );
    } finally {
      await deleteTasks([a, b]);
    }
  });

  it("reorders the task queue by rank and keeps it", async () => {
    const a = await addTask("e2e queue first");
    const b = await addTask("e2e queue second");
    try {
      await browser.waitUntil(async () => (await queueOrder([a, b])).length === 2, {
        timeout: 10000,
      });
      const before = await queueOrder([a, b]);
      expect(before.indexOf(a)).toBeLessThan(before.indexOf(b));
      await browser.tauri.execute(
        ({ core }, id) => core.invoke("queue_move", { id, to: "top" }),
        b,
      );
      await browser.waitUntil(async () => (await queueOrder([a, b]))[0] === b, {
        timeout: 10000,
      });
    } finally {
      await deleteTasks([a, b]);
    }
  });
});
