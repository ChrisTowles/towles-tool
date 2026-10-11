/**
 * Queue fixtures shared by the specs. Not a spec itself (no `.e2e.ts` suffix).
 * The queue holds only checkouts a board task owns, so a row is a throwaway
 * repo, tracked, plus a task bound to it — never this checkout, which a task's
 * removal could otherwise be pointed at.
 */

/// <reference types="@wdio/globals/types" />

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SeededRow = { dir: string; taskId: number };

export async function trackRepo(dir: string): Promise<void> {
  await browser.tauri.execute(({ core }, d) => core.invoke("ab_add_repo", { path: d }), dir);
}

export function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tt-e2e-queue-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git(
    "-c",
    "user.name=e2e",
    "-c",
    "user.email=e2e@local",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
}

/** A scratch checkout on the rail, owned by a fresh task — one queue row. */
export async function seedQueueRow(title: string): Promise<SeededRow> {
  const dir = makeScratchRepo();
  await trackRepo(dir);
  const taskId = await browser.tauri.execute(
    ({ core }, text) => core.invoke("store_add_task", { text }),
    title,
  );
  if (typeof taskId !== "number") throw new TypeError(`store_add_task answered ${taskId}`);
  await browser.tauri.execute(
    ({ core }, id, d) => core.invoke("store_task_set_worktree", { id, repoRoot: d, dir: d }),
    taskId,
    dir,
  );
  return { dir, taskId };
}

/** The checkout goes first, so closing the task finds nothing on disk to remove
 * and only unbinds it — the purge refuses a still-bound row. */
export async function dropQueueRow(row: SeededRow): Promise<void> {
  await browser.tauri.execute(({ core }, d) => core.invoke("ab_remove_repo", { dir: d }), row.dir);
  rmSync(row.dir, { recursive: true, force: true });
  for (const purge of [false, true]) {
    await browser.tauri.execute(
      ({ core }, id, p) => core.invoke("task_delete", { id, force: false, purge: p }),
      row.taskId,
      purge,
    );
  }
}
