/**
 * The three status readouts that live in the app header's title bar: the top
 * task on the left, and what needs you plus collector freshness on the right.
 *
 * They had a strip of their own under the header until they moved up here —
 * three short readouts do not earn a row of screen height, and the header's
 * left and right edges were already the quiet space for exactly this. Reported,
 * never actionable: a row navigates, nothing here approves or replies.
 */
import { useState } from "react";
import {
  CircleAlert,
  CircleX,
  GitPullRequest,
  ListTodo,
  MessageCircleHeart,
  type LucideIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAgentboardState } from "@/lib/agentboard";
import { buildAttentionFeed, type AttentionItem, type AttentionKind } from "@/lib/attention-feed";
import {
  alwaysOnHealth,
  COLLECTOR_STATE_DOT,
  COLLECTOR_STATE_LABEL,
  worstCollectorState,
} from "@/lib/collector-health";
import { fmtAge, useStoreSnapshot } from "@/lib/data";
import { pickTopTask } from "@/lib/day-top-task";
import { useNow } from "@/lib/now";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE } from "@/lib/pr-tone";
import { useWorkspace } from "@/lib/workspace";

/** The one task the day is about, or nothing when the board has no candidate. */
export function TopTaskChip() {
  const { openTab } = useWorkspace();
  const { snapshot } = useStoreSnapshot();
  const topTask = pickTopTask(snapshot.tasks);
  if (!topTask) return null;
  return (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
      onClick={() => openTab("cockpit")}
      title={topTask.text}
    >
      <ListTodo className="size-3.5 shrink-0" />
      <span className="max-w-44 truncate">{topTask.text}</span>
    </button>
  );
}

/**
 * "all clear", or the count of things waiting on you with the feed behind it.
 * The feed is the single source for both the number and the rows, so the badge
 * can never disagree with the list it opens.
 */
export function NeedsYouChip() {
  const { openTabWithFocus } = useWorkspace();
  const { snapshot } = useStoreSnapshot();
  const agentState = useAgentboardState();
  const now = useNow();
  const [feedOpen, setFeedOpen] = useState(false);

  const feed = buildAttentionFeed(snapshot, agentState);

  function navigate(item: AttentionItem) {
    setFeedOpen(false);
    if (item.url) {
      void openExternalUrl(item.url);
    } else if (item.target) {
      openTabWithFocus(item.target);
    }
  }

  if (feed.length === 0) {
    return <span className="px-1.5 py-0.5 text-xs text-muted-foreground/50">all clear</span>;
  }

  return (
    <Popover open={feedOpen} onOpenChange={setFeedOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent/50 data-[state=open]:bg-accent/50">
          <CircleAlert className="size-3.5 text-amber-500" />
          {feed.length} need you
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-1.5">
        <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Needs you
        </div>
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {feed.map((item) => (
            <AttentionRow key={item.id} item={item} now={now} onNavigate={() => navigate(item)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Collector freshness in one dot. Coloured from the worst *always-on* collector
 * (prs/issues) — calendar is off by default and would otherwise pin it amber
 * on every install that never turned it on.
 */
export function CollectorDot() {
  const { snapshot } = useStoreSnapshot();
  const now = useNow();
  const health = alwaysOnHealth(snapshot.runs, now);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            COLLECTOR_STATE_DOT[worstCollectorState(health)],
          )}
        />
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {health.map((h) => (
            <span key={h.key}>
              {h.label} · {COLLECTOR_STATE_LABEL[h.state]}
              {h.run ? ` (${fmtAge(h.run.ranAt, now)})` : ""}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Icon + accent (paired dark variant) per attention kind. */
const KIND_META: Record<AttentionKind, { icon: LucideIcon; tone: string }> = {
  dm: { icon: MessageCircleHeart, tone: "text-rose-500 dark:text-rose-400" },
  "pr-ci": { icon: CircleX, tone: PR_TONE.failed.text },
  "pr-review": { icon: GitPullRequest, tone: PR_TONE.review.text },
  agent: { icon: CircleAlert, tone: "text-amber-500 dark:text-amber-400" },
};

/** One feed row: navigates on click (external Slack link, or an in-app deep
 * link that scrolls+flashes the row on its screen). */
function AttentionRow({
  item,
  now,
  onNavigate,
}: {
  item: AttentionItem;
  now: number;
  onNavigate: () => void;
}) {
  const { icon: Icon, tone } = KIND_META[item.kind];
  return (
    <button
      onClick={onNavigate}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{item.subtitle}</span>
      </span>
      {item.kind === "dm" && (
        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/60">
          {fmtAge(item.sortTs, now)}
        </span>
      )}
    </button>
  );
}
