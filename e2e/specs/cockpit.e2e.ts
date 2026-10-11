/**
 * Cockpit — Agent Board's checkouts as a queue — against the real Tauri shell.
 * Asserts the queue holds exactly the board's checkouts, that picking a row
 * opens it in place, and that the keyboard walks it; never which checkouts a
 * machine happens to have. Seeds its own two checkouts — this one and a
 * throwaway repo — since `TT_STATE_SCOPE` starts the rail empty.
 */

/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectObject } from "../ipc.js";
import { bootReady, gotoScreen, waitForAnyDisplayed } from "./nav.js";

// Mirrors TaskQueue in apps/client/src/lib/schemas/queue.ts, narrowed to what's read.
type TaskQueue = { items: { folderDir: string; lane: string }[] };
type AgentboardState = { repos: { folders: { dir: string }[] }[] };

async function trackRepo(dir: string): Promise<void> {
  await browser.tauri.execute(({ core }, d) => core.invoke("ab_add_repo", { path: d }), dir);
}

/** A second checkout, so the cursor always has somewhere to go. */
function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tt-e2e-queue-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@local", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

async function queueDirs(): Promise<string[]> {
  const queue = expectObject<TaskQueue>(
    await browser.tauri.execute(({ core }) => core.invoke("queue_get")),
    "queue_get",
  );
  return queue.items.map((i) => i.folderDir).toSorted();
}

async function boardDirs(): Promise<string[]> {
  const state = expectObject<AgentboardState>(
    await browser.tauri.execute(({ core }) => core.invoke("ab_get_state")),
    "ab_get_state",
  );
  return state.repos.flatMap((r) => r.folders.map((f) => f.dir)).toSorted();
}

/** The queue row picked right now. */
async function selectedRowText(): Promise<string> {
  return browser.execute(() => {
    const row = document.querySelector("[data-testid='queue-row'][aria-current='true']");
    return row instanceof HTMLElement ? row.innerText : "";
  });
}

/** Unfolds every folded lane, so every row is on screen and on the cursor's walk. */
async function unfoldLanes(): Promise<void> {
  for (const header of await browser.$$("[data-testid='queue-lane'][aria-expanded='false']")) {
    await header.click();
  }
}

describe("Cockpit screen", () => {
  let scratch: string | undefined;
  before(async () => {
    await bootReady();
    scratch = makeScratchRepo();
    await trackRepo(process.cwd());
    await trackRepo(scratch);
  });
  after(async () => {
    if (!scratch) return;
    await browser.tauri.execute(({ core }, d) => core.invoke("ab_remove_repo", { dir: d }), scratch);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("renders the queue rail and none of Agent Board's tree", async () => {
    await gotoScreen("Cockpit");
    await waitForAnyDisplayed('[aria-label="New task"]', "the queue's new-task +");
    expect(await (await browser.$('[aria-label="Filter repos"]')).isDisplayed()).toBe(false);
  });

  it("holds exactly the board's checkouts", async () => {
    await browser.waitUntil(
      async () => {
        const board = await boardDirs();
        return board.length > 1 && JSON.stringify(board) === JSON.stringify(await queueDirs());
      },
      { timeout: 20000, interval: 1000, timeoutMsg: "the queue never matched the board" },
    );
  });

  it("opens a picked row in place, and j/k walk the rail", async () => {
    await gotoScreen("Cockpit");
    await unfoldLanes();
    const first = await browser.$("[data-testid='queue-row']");
    await first.waitForDisplayed({ timeout: 10000 });
    await first.click();
    await browser.waitUntil(async () => (await selectedRowText()) !== "", {
      timeout: 10000,
      timeoutMsg: "clicking a row never selected it",
    });
    const picked = await selectedRowText();

    await browser.execute(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await browser.keys("j");
    await browser.waitUntil(async () => (await selectedRowText()) !== picked, {
      timeout: 10000,
      timeoutMsg: "j never moved the rail cursor down",
    });
    await browser.keys("k");
    await browser.waitUntil(async () => (await selectedRowText()) === picked, {
      timeout: 10000,
      timeoutMsg: "k never moved the rail cursor back up",
    });
  });

  it("opens and closes the new-task form from the rail's +", async () => {
    await gotoScreen("Cockpit");
    const plus = await browser.$("button[aria-label='New task']");
    await plus.waitForDisplayed({ timeout: 10000 });
    await plus.click();
    const form = await browser.$("[data-testid='rail-new-task']");
    await form.waitForDisplayed({ timeout: 10000 });
    await (await browser.$("[aria-label='Repo for the new task']")).waitForDisplayed();
    await plus.click();
    await form.waitForDisplayed({ reverse: true, timeout: 10000 });
  });
});
