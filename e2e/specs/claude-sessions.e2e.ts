/**
 * Claude Sessions screen against the real Tauri shell. Read-only — asserts the
 * screen mounts and the ledger IPC answers, never what the ledger contains.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, clickTab, gotoScreen, waitForAnyDisplayed } from "./nav.js";

// Mirrors ClaudeSessionsSummary in apps/client/src/lib/claude-sessions.ts.
type ClaudeSessionsSummary = {
  totals: object;
  days: unknown[];
  byProject: unknown[];
  byModel: unknown[];
  topSessions: unknown[];
};

describe("Claude Sessions screen", () => {
  before(bootReady);

  it("navigates to Claude Sessions and renders its heading", async () => {
    await gotoScreen("Claude Sessions");
    const heading = await browser.$("h2=Claude Sessions");
    await heading.waitForDisplayed({ timeout: 10000 });
  });

  it("renders the day-range picker", async () => {
    await waitForAnyDisplayed('[data-slot="select-trigger"]', "day-range picker");
  });

  it("switches to the Sessions tab and shows the search box", async () => {
    await clickTab("Sessions");
    const search = await browser.$('input[placeholder="Search titles & prompts…"]');
    await search.waitForDisplayed({ timeout: 10000 });
  });

  it("answers the 7-day ledger over IPC, or settles on its empty state without one", async () => {
    type Outcome = { ok: true; summary: unknown } | { ok: false; error: string };
    const outcome = expectObject<Outcome>(
      await browser.tauri.execute(({ core }) =>
        core.invoke("claude_sessions_summary", { days: 7 }).then(
          (summary) => ({ ok: true, summary }),
          (error: unknown) => ({ ok: false, error: String(error) }),
        ),
      ),
      "claude_sessions_summary",
    );
    if (outcome.ok) {
      const summary = expectObject<ClaudeSessionsSummary>(outcome.summary, "claude_sessions_summary");
      expect(summary.totals).toBeDefined();
      expect(Array.isArray(summary.days)).toBe(true);
      expect(Array.isArray(summary.byProject)).toBe(true);
      expect(Array.isArray(summary.topSessions)).toBe(true);
      return;
    }
    // No ~/.claude/projects on this machine (the nightly runner): the screen stays
    // mounted, is done scanning, and shows no stat tiles.
    expect(outcome.error).toContain("Claude projects");
    await browser.$("h2=Claude Sessions").waitForDisplayed({ timeout: 10000 });
    expect(await browser.$$("p=Scanning sessions…").length).toBe(0);
    expect(await browser.$$('[data-testid="claude-sessions-totals"]').length).toBe(0);
  });
});
