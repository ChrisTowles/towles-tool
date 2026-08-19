/**
 * The rail's hold-to-reveal jump numbers in the real WebKitGTK shell, where the
 * modifier mask arrives one event stale — a naive `e.ctrlKey` read never sees a
 * held chord. Seeds its own row, since `TT_STATE_SCOPE` starts the board empty.
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

async function seedRailSession(): Promise<void> {
  const repoRoot = process.cwd();
  await browser.tauri.execute(({ core }, dir) => core.invoke("ab_add_repo", { path: dir }), repoRoot);
  await browser.tauri.execute(({ core }, dir) => core.invoke("ab_ensure_session", { dir }), repoRoot);
}

type AgentboardState = { repos: { folders: { sessions: unknown[] }[] }[] };

/** Seeding is two IPC writes; the rail only grows the row on the watcher's next scan. */
async function railSessionCount(): Promise<number> {
  const state = expectObject<AgentboardState>(
    await browser.tauri.execute(({ core }) => core.invoke("ab_get_state")),
    "ab_get_state",
  );
  return state.repos.flatMap((r) => r.folders).reduce((n, f) => n + f.sessions.length, 0);
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

describe("Agentboard rail jump keys", () => {
  before(bootReady);

  it("numbers the visible sessions while the chord is held, and unnumbers on release", async () => {
    await seedRailSession();
    await gotoScreen("Agentboard");

    await browser.waitUntil(async () => (await railSessionCount()) > 0, {
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
