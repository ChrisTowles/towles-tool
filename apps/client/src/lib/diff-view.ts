import * as Atom from "effect/reactivity/Atom";
import { write } from "@/lib/atoms/registry";

/** A checkout's branch diff, opened read-only beside whatever is on screen. */
export type DiffViewTarget = { dir: string; label: string; baseBranch: string | null };

export type FilePatch = {
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  binary: boolean;
  truncated: boolean;
};

export const diffViewAtom = Atom.make<DiffViewTarget | null>(null).pipe(Atom.keepAlive);

export const openDiffView = (target: DiffViewTarget) => write(diffViewAtom, target);
export const closeDiffView = () => write(diffViewAtom, null);

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
