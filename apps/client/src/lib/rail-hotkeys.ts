import { railNodes, type RailVisibility } from "@/lib/rail-nodes";

/** Digits 1–9; a tenth visible session simply wears no badge. */
export const RAIL_HOTKEY_MAX = 9;

export type RailHotkeyTarget = { sessionId: string; folderDir: string };

// A badge is a promise about a row you can see, so the numbering rides the
// rail's own walk — the session rows of `railNodes`, in the order they render.
export function railHotkeyTargets(v: RailVisibility): RailHotkeyTarget[] {
  const out: RailHotkeyTarget[] = [];
  for (const node of railNodes(v)) {
    if (node.kind !== "session" || node.sessionId === null || node.dir === null) continue;
    out.push({ sessionId: node.sessionId, folderDir: node.dir });
    if (out.length >= RAIL_HOTKEY_MAX) break;
  }
  return out;
}
