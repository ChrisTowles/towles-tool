/**
 * The queue rail's hold-to-reveal jump numbers in the real WebKitGTK shell, where
 * the modifier mask arrives one event stale — a naive `e.ctrlKey` read never sees
 * a held chord. Seeds its own row, since `TT_STATE_SCOPE` starts the queue empty.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen } from "./nav.js";

const BADGE = '[aria-label^="jump key"]';

// Raw W3C key codes: `Key.*` is a placeholder only `browser.keys()` resolves,
// and `performActions` delivers `Key.Ctrl` as a key named "WDIO_CONTROL".
const CONTROL = "\uE009";
const SHIFT = "\uE008";

type TaskQueue = { items: { key: { kind: string; id?: number } }[] };

/** A board task is a queue row; the queue only grows it on the next rebuild. */
async function seedQueueTask(): Promise<number> {
  const id = await browser.tauri.execute(
    ({ core }, t) => core.invoke("store_add_task", { text: t }),
    "e2e jump-key row",
  );
  if (typeof id !== "number") throw new TypeError(`store_add_task answered ${id}`);
  return id;
}

async function queueHas(id: number): Promise<boolean> {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items.some((i) => i.key.kind === "task" && i.key.id === id);
}

/** A real held chord, not `browser.keys`, which releases before we can look. */
async function withModifiersHeld<T>(fn: () => Promise<T>): Promise<T> {
  await browser.execute(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await browser.performActions([
    {
      type: "key",
      id: "kb",
      actions: [
        { type: "keyDown", value: CONTROL },
        { type: "keyDown", value: SHIFT },
      ],
    },
  ]);
  try {
    return await fn();
  } finally {
    await browser.releaseActions();
  }
}

describe("Cockpit queue rail jump keys", () => {
  before(bootReady);

  let seeded: number | undefined;
  after(async () => {
    if (seeded === undefined) return;
    await browser.tauri.execute(
      ({ core }, taskId) => core.invoke("task_delete", { id: taskId, force: false, purge: true }),
      seeded,
    );
  });

  it("numbers the visible rows while the chord is held, and unnumbers on release", async () => {
    const id = await seedQueueTask();
    seeded = id;
    await gotoScreen("Cockpit");

    await browser.waitUntil(async () => queueHas(id), {
      timeout: 20000,
      interval: 1000,
      timeoutMsg: "the seeded task never reached the queue",
    });

    // Retried: a chord lands nowhere when focus does (same flake as palette.e2e).
    let digits: string[] = [];
    await browser.waitUntil(
      async () => {
        digits = await withModifiersHeld(async () => {
          const out: string[] = [];
          for (const badge of await browser.$$(BADGE)) out.push((await badge.getText()).trim());
          return out;
        });
        return digits.length > 0;
      },
      { timeout: 20000, timeoutMsg: "holding the chord painted no jump numbers on the rail" },
    );

    // How many rows the rail holds is machine-specific; 1..N in order is not.
    expect(digits.length).toBeLessThanOrEqual(9);
    expect(digits).toEqual(digits.map((_, i) => String(i + 1)));

    await browser.waitUntil(async () => (await browser.$$(BADGE).length) === 0, {
      timeout: 10000,
      timeoutMsg: "jump numbers outlived the chord",
    });
  });
});
