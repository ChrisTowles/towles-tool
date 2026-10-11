/**
 * The queue rail's hold-to-reveal jump numbers in the real WebKitGTK shell, where
 * the modifier mask arrives one event stale — a naive `e.ctrlKey` read never sees
 * a held chord. Seeds its own checkout, since `TT_STATE_SCOPE` starts the queue empty.
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

type TaskQueue = { items: { folderDir: string }[] };

/** A queue row is a checkout; adding this repo puts this checkout on the board. */
async function seedQueueRow(): Promise<string> {
  const dir = process.cwd();
  await browser.tauri.execute(({ core }, d) => core.invoke("ab_add_repo", { path: d }), dir);
  return dir;
}

async function queueHas(dir: string): Promise<boolean> {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items.some((i) => i.folderDir === dir);
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

  it("numbers the visible rows while the chord is held, and unnumbers on release", async () => {
    const dir = await seedQueueRow();
    await gotoScreen("Cockpit");

    await browser.waitUntil(async () => queueHas(dir), {
      timeout: 20000,
      interval: 1000,
      timeoutMsg: "the seeded checkout never reached the queue",
    });
    // Idle checkouts fold by default, and a folded lane's rows take no digits.
    for (const lane of await browser.$$("[data-testid='queue-lane'][aria-expanded='false']")) {
      await lane.click();
    }

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
