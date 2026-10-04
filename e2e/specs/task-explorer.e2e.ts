/**
 * Task Explorer screen against the real Tauri shell. Read-only — asserts the
 * screen mounts and the process snapshot answers, never which processes exist.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectArray } from "../ipc.js";
import { bootReady, gotoScreen, waitForAnyDisplayed } from "./nav.js";

describe("Task Explorer screen", () => {
  before(bootReady);

  it("navigates to Task Explorer and renders its heading", async () => {
    await gotoScreen("Task Explorer");
    await browser.$("h2=Task Explorer").waitForDisplayed({ timeout: 10000 });
  });

  it("renders the Refresh control", async () => {
    await waitForAnyDisplayed("button=Refresh", "Task Explorer refresh");
  });

  it("answers the process tree over task_explorer_snapshot IPC", async () => {
    const groups = expectArray(
      await browser.tauri.execute(({ core }) => core.invoke("task_explorer_snapshot")),
      "task_explorer_snapshot",
    );
    expect(Array.isArray(groups)).toBe(true);
  });
});
