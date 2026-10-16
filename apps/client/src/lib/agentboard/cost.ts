import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/tauri";

/** Estimated Claude spend per checkout (`claude_cost_by_dir`), for the rail. Every
 * mounted chip registers its dir, and one batched call answers them all: the Rust
 * side charges a session to the *deepest* dir its cwd is in, so a root checkout
 * must be asked alongside its nested task worktrees, never alone. */

export type DirCost = { dir: string; costUsd: number; sessions: number; userTurns: number };

/** The backend rescans transcripts at most every ten minutes; asking more often
 * only re-reads its cache. */
const REFRESH_MS = 10 * 60_000;

const dirs = new Map<string, number>();
let costs = new Map<string, DirCost>();
const listeners = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function fetchAll() {
  pending = null;
  const asked = [...dirs.keys()];
  if (asked.length === 0) return;
  const r = await invoke<DirCost[]>("claude_cost_by_dir", { dirs: asked });
  if (r.isErr()) return;
  costs = new Map(r.value.map((c) => [c.dir, c]));
  for (const listener of listeners) listener();
}

function schedule() {
  if (pending === null) pending = setTimeout(() => void fetchAll(), 50);
  timer ??= setInterval(() => void fetchAll(), REFRESH_MS);
}

function register(dir: string): () => void {
  const isNew = !dirs.has(dir);
  dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  if (isNew) schedule();
  return () => {
    const n = (dirs.get(dir) ?? 1) - 1;
    if (n > 0) dirs.set(dir, n);
    else dirs.delete(dir);
    if (dirs.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDirCost(dir: string): DirCost | undefined {
  useEffect(() => register(dir), [dir]);
  return useSyncExternalStore(subscribe, () => costs.get(dir));
}
