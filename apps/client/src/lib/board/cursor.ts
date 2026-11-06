// Where a cursor stands when its row goes away (decision: the row that took its
// place — same position, else the first row). Pure, so the derived atoms in
// derive.ts can carry the previous slot and never need a repairing write.
import type { QueueItem } from "@/lib/schemas/queue";
import { resolveCursor, type RailNode } from "@/lib/rail-nodes";

export type TreeSlot = { node: RailNode; index: number };

/** The stored cursor on today's rows: its own row, else what stands for it
 * (`resolveCursor`), else whatever row now holds its old position. */
export function treeSlot(
  nodes: readonly RailNode[],
  stored: RailNode | null,
  prev: TreeSlot | null,
): TreeSlot | null {
  if (!stored || nodes.length === 0) return null;
  const node =
    resolveCursor(nodes as RailNode[], stored) ??
    nodes[Math.min(prev?.index ?? 0, nodes.length - 1)]!;
  return { node, index: nodes.indexOf(node) };
}

/** `forDir` is the checkout on screen the ring was answering for: a fallback
 * holds only while that checkout is the one whose row went. */
export type RingSlot = { item: QueueItem; forDir: string; laneIndex: number };

export function ringSlot(
  rows: readonly QueueItem[],
  activeDir: string | null,
  prev: RingSlot | null,
): RingSlot | null {
  if (activeDir === null) return null;
  const laneIndex = (item: QueueItem) => rows.filter((r) => r.lane === item.lane).indexOf(item);
  const own = rows.find((r) => r.folderDir === activeDir);
  if (own) return { item: own, forDir: activeDir, laneIndex: laneIndex(own) };
  // The checkout on screen never had a row (a quiet one, picked on the tree):
  // nothing took its place, so no ring.
  if (prev?.forDir !== activeDir || rows.length === 0) return null;
  const lane = rows.filter((r) => r.lane === prev.item.lane);
  const item = lane[Math.min(prev.laneIndex, lane.length - 1)] ?? rows[0]!;
  return { item, forDir: activeDir, laneIndex: laneIndex(item) };
}
