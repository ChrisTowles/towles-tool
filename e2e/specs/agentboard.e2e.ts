/**
 * Agent Board in the real WebKitGTK shell: the repo → checkout → session tree
 * as the rail, its own jump digits, and — the reason the two rails share one
 * screen — a terminal opened here is the very same pane on the queue. Seeds its
 * own session, since `TT_STATE_SCOPE` starts the rail empty.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { Key } from "webdriverio";
import { expectObject } from "../ipc.js";
import { bootReady, gotoRail, waitForAnyDisplayed } from "./nav.js";
import { trackRepo } from "./seed.js";

const BADGE = '[aria-label^="jump key"]';

// Raw W3C key codes: `Key.*` is a placeholder only `browser.keys()` resolves.
const CONTROL = "";
const SHIFT = "";

type AgentboardState = { repos: { folders: { sessions: { id: string }[] }[] }[] };

async function seedRailSession(): Promise<void> {
  const repoRoot = process.cwd();
  await trackRepo(repoRoot);
  await browser.tauri.execute(
    ({ core }, dir) => core.invoke("ab_ensure_session", { dir }),
    repoRoot,
  );
}

async function railSessionIds(): Promise<string[]> {
  const state = expectObject<AgentboardState>(
    await browser.tauri.execute(({ core }) => core.invoke("ab_get_state")),
    "ab_get_state",
  );
  return state.repos.flatMap((r) => r.folders).flatMap((f) => f.sessions.map((s) => s.id));
}

async function blurActive(): Promise<void> {
  await browser.execute(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/** A real held chord, not `browser.keys`, which releases before we can look. */
async function withModifiersHeld<T>(fn: () => Promise<T>): Promise<T> {
  await blurActive();
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

/** Ctrl+Shift+1: the first numbered session on the tree. */
async function pressJumpOne(): Promise<void> {
  await blurActive();
  await browser.performActions([
    {
      type: "key",
      id: "kb",
      actions: [
        { type: "keyDown", value: CONTROL },
        { type: "keyDown", value: SHIFT },
        { type: "keyDown", value: "1" },
        { type: "keyUp", value: "1" },
        { type: "keyUp", value: SHIFT },
        { type: "keyUp", value: CONTROL },
      ],
    },
  ]);
  await browser.releaseActions();
}

/** The visible terminal host, tagged so a remount would show up as a new node. */
async function tagVisibleTerminal(): Promise<boolean> {
  return browser.execute(() => {
    const host = [...document.querySelectorAll<HTMLElement>("[data-term-host]")].find(
      (el) => el.offsetParent !== null,
    );
    if (!host) return false;
    host.dataset.e2eTag = "agentboard";
    return true;
  });
}

describe("Agent Board", () => {
  // The queue rail's "New task in" chips are one per tracked repo, and a fresh
  // `TT_STATE_SCOPE` tracks none: without this the first run on a scope fails
  // here, and only passes later because a later test's seed persisted the repo.
  before(async () => {
    await bootReady();
    await trackRepo(process.cwd());
  });

  it("switches its rail between the checkout tree and the queue", async () => {
    await gotoRail("Tree");
    await waitForAnyDisplayed('[aria-label="Filter repos"]', "the tree's rail header");
    await gotoRail("Queue");
    await waitForAnyDisplayed('[aria-label^="New task in "]', "the queue rail");
  });

  it("flips the rail from the keyboard", async () => {
    await gotoRail("Queue");
    const selected = () =>
      browser.execute(
        () =>
          document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
      );
    // Retried: a chord lands nowhere when focus does (same flake as palette.e2e).
    await browser.waitUntil(
      async () => {
        if ((await selected()) === "Queue") await browser.keys([Key.Ctrl, Key.Shift, "t"]);
        return (await selected()) === "Tree";
      },
      { timeout: 20000, interval: 1000, timeoutMsg: "Ctrl+Shift+T never switched to the tree" },
    );
  });

  it("numbers sessions on a held chord, and a jump opens one the queue shares", async () => {
    await seedRailSession();
    await gotoRail("Tree");
    await browser.waitUntil(async () => (await railSessionIds()).length > 0, {
      timeout: 20000,
      interval: 1000,
      timeoutMsg: "the seeded session never reached the rail's state",
    });

    // Retried: a chord lands nowhere when focus does (same flake as palette.e2e).
    let digits: string[] = [];
    await browser.waitUntil(
      async () => {
        digits = await withModifiersHeld(async () => {
          const out: string[] = [];
          for (const badge of await browser.$$(BADGE)) {
            if (await badge.isDisplayed()) out.push((await badge.getText()).trim());
          }
          return out;
        });
        return digits.length > 0;
      },
      { timeout: 20000, timeoutMsg: "holding the chord painted no jump numbers on the tree" },
    );
    expect(digits).toEqual(digits.map((_, i) => String(i + 1)));

    await browser.waitUntil(
      async () => {
        await pressJumpOne();
        return tagVisibleTerminal();
      },
      { timeout: 20000, interval: 1000, timeoutMsg: "Ctrl+Shift+1 opened no terminal" },
    );

    await gotoRail("Queue");
    const same = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>('[data-e2e-tag="agentboard"]');
      return host !== null && host.isConnected && host.offsetParent !== null;
    });
    expect(same).toBe(true);
  });
});
