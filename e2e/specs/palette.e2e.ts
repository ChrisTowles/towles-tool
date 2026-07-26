/**
 * End-to-end smoke test driving the real Tauri shell via @wdio/tauri-service.
 * Exercises the command palette the way a user does — open with Ctrl/Cmd+K,
 * type, Enter — and proves navigation lands on the target screen. Also checks
 * the task badge, whose value comes from the real `app_task` Rust command.
 * Read-only — never writes settings or other state.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { Key } from "webdriverio";
import { expectString } from "../ipc.js";

// The app binds the palette to ⌘K on macOS, Ctrl+K everywhere else (mirrors the
// frontend's IS_MAC). The suite runs on Linux/WebKitGTK, but keep it portable.
const MOD = process.platform === "darwin" ? Key.Command : Key.Ctrl;

/**
 * Open the palette via the real keyboard shortcut and wait for its input.
 *
 * The synthetic chord silently no-ops when focus sits somewhere the global
 * keydown listener can't see it (e.g. an input on whichever screen the session
 * restored), so normalize focus by blurring the active element and retry the
 * chord until the palette actually opens rather than firing it once and hoping.
 */
async function openPalette(): Promise<void> {
  await browser.waitUntil(
    async () => {
      await browser.execute(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await browser.keys([MOD, "k"]);
      const input = await browser.$('[data-slot="command-input"]');
      try {
        await input.waitForDisplayed({ timeout: 2000 });
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 20000, timeoutMsg: "palette never opened via the keyboard chord" },
  );
}

/**
 * Type a query, press Enter on whatever the palette selected, and wait for the
 * palette to close.
 *
 * Deliberately Enter-on-selected rather than clicking the exact-labelled row:
 * typing a screen's full title and hitting Enter is the palette's whole point,
 * and it is the assertion that catches a selection regression. It used to be
 * unsafe — a persisted "Recent" entry (Agentboard, whose title contains
 * "board") sat above the exact `Go to > Board` match, so what Enter committed
 * depended on prior-session state (#480). Recent is now suppressed while a
 * query is typed and an exact title match scores 1, so the top hit is the
 * exact match regardless of history; the assertion below is what keeps that
 * true.
 */
async function navigateTo(query: string, title: string = query): Promise<void> {
  const input = await browser.$('[data-slot="command-input"]');
  await input.setValue(query);
  // Wait for the filtered list to settle on the exact match being selected,
  // then commit it with the keyboard.
  await browser.waitUntil(
    async () => {
      const selected = await browser.$$('[data-slot="command-item"][data-selected="true"]');
      const labels: string[] = [];
      for (const item of selected) labels.push((await item.getText()).trim());
      return labels.length === 1 && labels[0] === title;
    },
    {
      timeout: 10000,
      timeoutMsg: `palette never auto-selected the item titled "${title}"`,
    },
  );
  await browser.keys([Key.Enter]);
  await browser
    .$('[data-slot="command-input"]')
    .waitForExist({ reverse: true, timeout: 10000 });
}

/**
 * Wait until an active (aria-current) sidebar control is labelled `title`.
 * Expanded, it's a visible-text button (`AppSidebar`); icon-collapsed (the
 * e2e default), it's icon-only with the title as `aria-label`
 * (`AppSidebarIcons`) — check both so the assertion holds regardless of
 * collapse state.
 */
async function expectActiveTab(title: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const tabs = await browser.$$('button[aria-current="true"]');
      for (const tab of tabs) {
        const text = (await tab.getText()).trim();
        const label = await tab.getAttribute("aria-label");
        if (text === title || label === title) return true;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `no active tab titled "${title}"` },
  );
}

describe("Command palette navigation", () => {
  before(async () => {
    const root = await browser.$("#root");
    await root.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await root.$$("*").length) > 0, {
      timeout: 15000,
      timeoutMsg: "#root never got children",
    });
  });

  it("shows the task badge from the real app_task command", async () => {
    const task = expectString(
      await browser.tauri.execute(({ core }) => core.invoke("app_task")),
      "app_task",
    );
    expect(task.length).toBeGreaterThan(0);
    // The header badge carries the full task as its title attribute.
    const badge = await browser.$(`[title="${task}"]`);
    await badge.waitForDisplayed({ timeout: 10000 });
    expect((await badge.getText()).length).toBeGreaterThan(0);
  });

  it("navigates to Board via the palette", async () => {
    await openPalette();
    await navigateTo("Board");
    await expectActiveTab("Board");
  });

  it("navigates to Agentboard via the palette", async () => {
    await openPalette();
    await navigateTo("Agentboard");
    await expectActiveTab("Agentboard");
  });
});
