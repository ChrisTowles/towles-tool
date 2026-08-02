/**
 * Settings screen UI against the real Tauri shell; settings.e2e.ts is the
 * IPC-level counterpart. Must stay read-only — no input, no Save — because the
 * real settings file is shared with the TypeScript CLI.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { bootReady, clickTab, expectTabPanelShown, gotoScreen } from "./nav.js";

describe("Settings screen UI", () => {
  before(bootReady);

  it("navigates to Settings and renders its tab list", async () => {
    await gotoScreen("Settings");
    await browser.waitUntil(
      async () => (await browser.$$('[data-slot="tabs-trigger"]').length) > 0,
      { timeout: 10000, timeoutMsg: "settings tab list never rendered" },
    );
  });

  it("switches to the Appearance tab and shows its pane", async () => {
    await clickTab("Appearance");
    await expectTabPanelShown("Appearance");
  });

  it("switches to the About tab and shows its pane", async () => {
    await clickTab("About");
    await expectTabPanelShown("About");
  });
});
