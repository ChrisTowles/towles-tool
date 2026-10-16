import { useSyncExternalStore } from "react";

/** A checkout's branch diff, opened read-only beside whatever is on screen. */
export type DiffViewTarget = { dir: string; label: string; baseBranch: string | null };

export type FilePatch = {
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  binary: boolean;
  truncated: boolean;
};

class DiffViewStore {
  private target: DiffViewTarget | null = null;
  private listeners = new Set<() => void>();
  get = (): DiffViewTarget | null => this.target;
  set(target: DiffViewTarget | null): void {
    this.target = target;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

const store = new DiffViewStore();

export const openDiffView = (target: DiffViewTarget) => store.set(target);
export const closeDiffView = () => store.set(null);
export function useDiffView(): DiffViewTarget | null {
  return useSyncExternalStore(store.subscribe, store.get);
}

type PatchLineKind = "add" | "del" | "ctx";

/** One rendered row: git's sigil decides the tone, the counters the gutter. */
export type PatchRow = {
  kind: PatchLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export function patchRows(hunk: FilePatch["hunks"][number]): PatchRow[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    const text = line.slice(1);
    if (line.startsWith("+")) return { kind: "add", text, oldNo: null, newNo: newNo++ };
    if (line.startsWith("-")) return { kind: "del", text, oldNo: oldNo++, newNo: null };
    return { kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ };
  });
}
