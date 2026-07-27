import { useMemo, useState } from "react";
import { toast } from "sonner";
import { NotInTauri } from "@/lib/errors";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prChecksFailing, prNeedsYou } from "@/lib/pr-tone";
import { uiAction } from "@/lib/ui-action";
import {
  fmtCountdown,
  isItemDismissed,
  storeDismissalsClear,
  type StoreSnapshot,
} from "@/lib/data";
import { dismissAttentionPr } from "./helpers";

export type AttentionItem = {
  key: string;
  kind: "pr" | "event";
  title: string;
  sub: string;
  border: string;
  onClick: () => void;
  onDismiss?: () => void;
};

export type Attention = {
  items: AttentionItem[];
  dismissedPrCount: number;
  clearingDismissals: boolean;
  clearDismissals: () => Promise<void>;
};

/**
 * The rail's compact attention strip: failing/review PRs + the next imminent
 * meeting. A dismissed PR stays hidden until it changes again (see
 * `isItemDismissed`), and "clear dismissals" brings the whole set back.
 */
export function useAttention(args: {
  snapshot: StoreSnapshot;
  now: number;
  /** Opens a screen — the meeting row jumps to the Cockpit. */
  openTab: (id: "cockpit") => void;
}): Attention {
  const { snapshot, now, openTab } = args;
  const [clearingDismissals, setClearingDismissals] = useState(false);

  const items = useMemo(() => {
    const out: AttentionItem[] = [];
    for (const p of snapshot.prs) {
      if (isItemDismissed(p)) continue;
      const checksFailing = prChecksFailing(p);
      if (prNeedsYou(p)) {
        out.push({
          key: `pr:${p.repo}#${p.number}`,
          kind: "pr",
          title: `${p.repo.split("/").pop()} #${p.number}`,
          sub: checksFailing ? "Checks failing" : "Review requested",
          border: checksFailing ? PR_TONE.failed.border : PR_TONE.review.border,
          onClick: () => {
            uiAction("agentboard.attention_open", "agentboard", "pr");
            void openExternalUrl(p.url);
          },
          onDismiss: () => void dismissAttentionPr(p.repo, p.number, p.updatedTs),
        });
      }
    }
    const soon = snapshot.events
      .filter((e) => e.startTs > now && e.startTs - now <= 30 * 60_000)
      .toSorted((a, b) => a.startTs - b.startTs)[0];
    if (soon) {
      out.push({
        key: `event:${soon.id}`,
        kind: "event",
        title: soon.title,
        sub: `Starts in ${fmtCountdown(soon.startTs - now)}`,
        border: "border-l-blue-500",
        onClick: () => {
          uiAction("agentboard.attention_open", "agentboard", "event");
          openTab("cockpit");
        },
      });
    }
    return out;
  }, [snapshot.prs, snapshot.events, now, openTab]);

  async function clearDismissals() {
    uiAction("agentboard.dismissals_clear", "agentboard");
    setClearingDismissals(true);
    const cleared = await storeDismissalsClear();
    if (cleared.isOk()) {
      const n = cleared.value;
      toast.success(n === 1 ? "1 item restored" : `${n} items restored`);
    } else if (!NotInTauri.is(cleared.error)) {
      toast.error(cleared.error.message);
    }
    setClearingDismissals(false);
  }

  return {
    items,
    dismissedPrCount: snapshot.prs.filter(isItemDismissed).length,
    clearingDismissals,
    clearDismissals,
  };
}
