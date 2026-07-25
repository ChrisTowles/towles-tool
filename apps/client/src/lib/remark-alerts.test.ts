import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { ALERT_ATTRIBUTE, matchAlert, remarkAlerts } from "@/lib/remark-alerts";

describe("matchAlert", () => {
  it("matches every kind GitHub renders", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(matchAlert(`[!${kind}]\nbody`)).toEqual({ kind: kind.toLowerCase(), rest: "body" });
    }
  });

  it("is case-insensitive on the kind", () => {
    expect(matchAlert("[!Warning]\nbody")?.kind).toBe("warning");
  });

  it("allows trailing spaces on the marker line", () => {
    expect(matchAlert("[!NOTE]  \nbody")).toEqual({ kind: "note", rest: "body" });
  });

  it("matches a marker with nothing after it", () => {
    expect(matchAlert("[!NOTE]")).toEqual({ kind: "note", rest: "" });
  });

  // The marker has to own the first line — otherwise an ordinary quote that
  // happens to mention one becomes a callout.
  it("does not match a marker that isn't the whole first line", () => {
    expect(matchAlert("[!NOTE] inline text")).toBeNull();
    expect(matchAlert("see [!NOTE]\nbody")).toBeNull();
    expect(matchAlert("[!UNKNOWN]\nbody")).toBeNull();
    expect(matchAlert("[NOTE]\nbody")).toBeNull();
  });
});

/** A blockquote whose opening paragraph starts with `text`. */
function quote(text: string, trailing: string[] = []): Root {
  return {
    type: "root",
    children: [
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: text },
              ...trailing.map((value) => ({ type: "text" as const, value })),
            ],
          },
        ],
      },
    ],
  };
}

/** The blockquote node of a transformed tree. */
function blockquoteOf(tree: Root) {
  const node = tree.children[0];
  if (node.type !== "blockquote") throw new Error("expected a blockquote");
  return node;
}

describe("remarkAlerts", () => {
  it("marks the blockquote and strips the marker from the body", () => {
    const tree = quote("[!WARNING]\nThis is a personal playground.");
    remarkAlerts()(tree);
    const node = blockquoteOf(tree);
    expect(node.data?.hProperties).toEqual({ [ALERT_ATTRIBUTE]: "warning" });
    expect(node.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "This is a personal playground." }],
    });
  });

  // `> [!NOTE]` on its own line, body underneath — the ordinary shape. The
  // emptied text node has to go, or the callout opens with a blank line.
  it("drops the paragraph entirely when the marker was all it held", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "blockquote",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "[!NOTE]" }] },
            { type: "paragraph", children: [{ type: "text", value: "Body." }] },
          ],
        },
      ],
    };
    remarkAlerts()(tree);
    const node = blockquoteOf(tree);
    expect(node.children).toHaveLength(1);
    expect(node.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "Body." }],
    });
  });

  it("keeps the rest of a paragraph whose marker line was removed", () => {
    const tree = quote("[!TIP]", [" and emphasis follows"]);
    remarkAlerts()(tree);
    const node = blockquoteOf(tree);
    expect(node.data?.hProperties).toEqual({ [ALERT_ATTRIBUTE]: "tip" });
    expect(node.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: " and emphasis follows" }],
    });
  });

  it("leaves an ordinary blockquote untouched", () => {
    const tree = quote("Just a quotation.");
    remarkAlerts()(tree);
    const node = blockquoteOf(tree);
    expect(node.data).toBeUndefined();
    expect(node.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "Just a quotation." }],
    });
  });

  it("ignores a marker that isn't the blockquote's opening text", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "blockquote",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "Intro." }] },
            { type: "paragraph", children: [{ type: "text", value: "[!NOTE]\nlater" }] },
          ],
        },
      ],
    };
    remarkAlerts()(tree);
    expect(blockquoteOf(tree).data).toBeUndefined();
  });
});
