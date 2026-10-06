/**
 * MCP server screen against the real Tauri shell. Read-only — asserts the
 * screen mounts and the status IPC agrees with the header, never which clients
 * or calls it lists.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen } from "./nav.js";

// Mirrors McpStatusSchema in apps/client/src/lib/schemas/mcp.ts.
type McpStatus = { serving: boolean; port: number; protocolVersion: string; version: string };

describe("MCP server screen", () => {
  before(bootReady);

  it("navigates to MCP server and renders its heading and tab list", async () => {
    await gotoScreen("MCP server");
    await browser.$("h2=MCP server").waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(
      async () => (await browser.$$('[data-slot="tabs-trigger"]').length) >= 3,
      { timeout: 10000, timeoutMsg: "mcp tab list never rendered" },
    );
  });

  it("answers mcp_status over IPC and shows that port in the header", async () => {
    const status = expectObject<McpStatus>(
      await browser.tauri.execute(({ core }) => core.invoke("mcp_status", {})),
      "mcp_status",
    );
    expect(typeof status.serving).toBe("boolean");
    expect(status.port).toBeGreaterThan(0);
    expect(typeof status.protocolVersion).toBe("string");
    await browser.$(`span*=:${status.port}/mcp`).waitForDisplayed({ timeout: 10000 });
  });
});
