import { describe, expect, it } from "vitest";
import type { RailNode } from "@/lib/rail-nodes";
import type { QueueItem } from "@/lib/schemas/queue";
import { ringSlot, treeSlot } from "./cursor";

const node = (key: string, over: Partial<RailNode> = {}): RailNode => ({
  key,
  kind: "folder",
  repoKey: "r",
  dir: `/${key}`,
  sessionId: null,
  collapseKey: null,
  depth: 1,
  ...over,
});

const row = (folderDir: string, lane: QueueItem["lane"]) => ({ folderDir, lane }) as QueueItem;

describe("treeSlot", () => {
  it("keeps the cursor on its own row", () => {
    const rows = [node("a"), node("b")];
    expect(treeSlot(rows, node("b"), null)).toEqual({ node: rows[1], index: 1 });
  });

  it("hands a vanished row's cursor to the row now in its place", () => {
    const before = treeSlot([node("a"), node("b"), node("c")], node("b"), null);
    const after = [node("a"), node("c")];
    expect(treeSlot(after, node("b"), before)?.node.key).toBe("c");
  });

  it("falls to the last row when its place is past the end, and to none with no rows", () => {
    const before = treeSlot([node("a"), node("b")], node("b"), null);
    expect(treeSlot([node("a")], node("b"), before)?.node.key).toBe("a");
    expect(treeSlot([], node("b"), before)).toBeNull();
  });
});

describe("ringSlot", () => {
  it("follows the checkout on screen", () => {
    const rows = [row("/a", "on_you"), row("/b", "on_you")];
    expect(ringSlot(rows, "/b", null)?.item).toBe(rows[1]);
  });

  it("takes the row at the same lane index when its own row goes", () => {
    const rows = [row("/a", "on_you"), row("/b", "on_you"), row("/c", "on_you")];
    const prev = ringSlot(rows, "/b", null);
    const after = [rows[0]!, rows[2]!];
    expect(ringSlot(after, "/b", prev)?.item.folderDir).toBe("/c");
  });

  it("takes the first row when its lane emptied", () => {
    const rows = [row("/a", "idle"), row("/b", "on_you")];
    const prev = ringSlot(rows, "/b", null);
    expect(ringSlot([rows[0]!], "/b", prev)?.item.folderDir).toBe("/a");
  });

  it("rings nothing for a checkout that never had a row", () => {
    const rows = [row("/a", "on_you")];
    const prev = ringSlot(rows, "/a", null);
    expect(ringSlot(rows, "/quiet", prev)).toBeNull();
  });
});
