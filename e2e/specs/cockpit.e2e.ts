/**
 * Cockpit screen against the real Tauri shell. Read-only — asserts the panels
 * mount and the repo chips follow the snapshot, never which PRs are listed.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen, waitForAnyDisplayed } from "./nav.js";

// The fields Cockpit's repo list reads (apps/client/src/screens/cockpit.tsx).
type QueueItem = { repo: string; state?: string; dismissedTs: number; updatedTs: number };
type StoreSnapshot = { prs: QueueItem[]; issues: QueueItem[] };

/** Same exclusions as the screen: open, undismissed PRs; undismissed issues. */
function cockpitRepoCount(snapshot: StoreSnapshot): number {
  const live = (item: QueueItem) => item.dismissedTs < item.updatedTs;
  const repos = new Set<string>();
  for (const pr of snapshot.prs) if (pr.state === "open" && live(pr)) repos.add(pr.repo);
  for (const issue of snapshot.issues) if (live(issue)) repos.add(issue.repo);
  return repos.size;
}

describe("Cockpit screen", () => {
  before(bootReady);

  it("navigates to Cockpit and renders both queue panels", async () => {
    await gotoScreen("Cockpit");
    // Panel (components/store-bits.tsx) titles its header with a div, not a heading.
    await waitForAnyDisplayed("div=Pull requests", "PR panel");
    await waitForAnyDisplayed("div=Issue queue", "issue panel");
  });

  it("answers the queues over store_snapshot IPC", async () => {
    const snapshot = expectObject<StoreSnapshot>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    expect(Array.isArray(snapshot.prs)).toBe(true);
    expect(Array.isArray(snapshot.issues)).toBe(true);
  });

  it("shows the repo filter chips only when the snapshot spans more than one repo", async () => {
    const snapshot = expectObject<StoreSnapshot>(
      await browser.tauri.execute(({ core }) => core.invoke("store_snapshot")),
      "store_snapshot",
    );
    const allRepos = await browser.$("button=All repos");
    if (cockpitRepoCount(snapshot) > 1) {
      await allRepos.waitForDisplayed({ timeout: 10000 });
    } else {
      expect(await allRepos.isExisting()).toBe(false);
    }
  });
});
