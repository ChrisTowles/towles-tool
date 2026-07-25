/**
 * GitHub alerts (`> [!WARNING]`) as a remark plugin.
 *
 * `remark-gfm` does not cover these — they are a GitHub rendering convention
 * layered on plain blockquote syntax, not part of GFM — so without this the
 * marker renders as literal `[!WARNING]` text above the body, which is exactly
 * how this repo's own README looked in the preview.
 *
 * Hand-rolled rather than `remark-github-blockquote-alert` for two reasons:
 * the matching rule is one regex and belongs somewhere it can be unit-tested,
 * and the markup should be ours (a bordered callout in the app's palette)
 * rather than a copy of GitHub's colors dropped into a Tailwind app.
 *
 * The transform is deliberately conservative: it marks the blockquote with a
 * `data-alert` attribute and strips the marker line, leaving the node a
 * blockquote. Everything downstream — `prose` styling, the preview's own
 * `blockquote` component — keeps working on alerts and non-alerts alike, and a
 * blockquote that merely *starts* with something bracket-shaped is left
 * completely alone.
 */

import { visit } from "unist-util-visit";
import type { Blockquote, Root, Text } from "mdast";

/** The five kinds GitHub renders, lowercased. */
export const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * The marker must be the whole first line: `[!NOTE]` followed by the end of
 * the text or a newline. GitHub also accepts trailing spaces, and is
 * case-insensitive on the kind but not on the `!`.
 */
const MARKER = new RegExp(`^\\[!(${ALERT_KINDS.join("|")})\\][ \\t]*(?:\\n|$)`, "i");

/**
 * Split a leading alert marker off a blockquote's opening text, or null when
 * there isn't one.
 *
 * `rest` is what should remain in that text node — empty when the marker was
 * the entire first paragraph, which is the ordinary case (`> [!NOTE]` on its
 * own line, body underneath).
 */
export function matchAlert(text: string): { kind: AlertKind; rest: string } | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as AlertKind,
    rest: text.slice(match[0].length),
  };
}

/** The `data-alert` value a blockquote carries once marked, read back by the
 * preview's `blockquote` component. Exported so the two sides can't drift. */
export const ALERT_ATTRIBUTE = "data-alert";

/**
 * Mark alert blockquotes and strip their marker line.
 *
 * A blockquote qualifies only if its first child is a paragraph whose first
 * child is a text node starting with the marker — a marker buried mid-quote,
 * or one that came from an inline code span, is not an alert.
 */
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
      // A marker on its own line leaves an empty text node; drop it, and drop
      // the paragraph too if that was all it held — otherwise the callout
      // opens with a blank line where the marker used to be.
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
