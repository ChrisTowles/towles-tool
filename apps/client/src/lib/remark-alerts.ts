/** GitHub alerts (`> [!WARNING]`) as a remark plugin — a GitHub convention, not
 * part of GFM, so `remark-gfm` leaves the marker as literal text. The node stays
 * a blockquote so everything downstream keeps working unchanged. */

import { visit } from "unist-util-visit";
import type { Blockquote, Root, Text } from "mdast";

export const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** The marker must be the whole first line; case-insensitive except the `!`. */
const MARKER = new RegExp(`^\\[!(${ALERT_KINDS.join("|")})\\][ \\t]*(?:\\n|$)`, "i");

export function matchAlert(text: string): { kind: AlertKind; rest: string } | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as AlertKind,
    rest: text.slice(match[0].length),
  };
}

/** Exported so the preview's `blockquote` component can't drift from it. */
export const ALERT_ATTRIBUTE = "data-alert";

export function remarkAlerts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const paragraph = node.children[0];
      if (paragraph?.type !== "paragraph") return;
      const first = paragraph.children[0];
      if (first?.type !== "text") return;
      const alert = matchAlert(first.value);
      if (!alert) return;

      (first as Text).value = alert.rest;
      // Otherwise the callout opens with a blank line where the marker was.
      if (alert.rest === "") {
        paragraph.children.shift();
        if (paragraph.children.length === 0) node.children.shift();
      }

      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          [ALERT_ATTRIBUTE]: alert.kind,
        },
      };
    });
  };
}
