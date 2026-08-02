/**
 * Board screen against the real Tauri shell. Read-only — asserts structure,
 * never machine-specific contents, and never writes state.
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
    const filter = await browser.$('[aria-label="Filter tasks"]');
    await filter.waitForDisplayed({ timeout: 10000 });
  });

  it("renders the group-into-swimlanes toggle", async () => {
    const swimlanes = await browser.$('[aria-label="Group tasks into repo swimlanes"]');
    await swimlanes.waitForExist({ timeout: 10000 });
  });
});
