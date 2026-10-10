import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CalendarDotsIcon,
  EyeSlashIcon,
  VideoCameraIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { dataRefreshedAt } from "@/lib/collector-health";
import {
  COUNTDOWN_SECONDS_THRESHOLD,
  currentOrNextEvent,
  eventIsLive,
  fmtAge,
  fmtClock,
  fmtCountdown,
  isItemDismissed,
  storeCollectNow,
  storeDismissalsClear,
  type StoreSnapshot,
} from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { useNowInterval } from "@/lib/now";
import { openExternalUrl } from "@/lib/open-url";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

const LATER_INLINE = 3;

/** The Cockpit's slim top strip: time until the next meeting, then a refresh of
 * the PR/issue/CI collectors that feed the queue. */
export function CockpitHeader({
  snapshot,
  live,
  now,
}: {
  snapshot: StoreSnapshot;
  live: boolean;
  now: number;
}) {
  const nextEvent = currentOrNextEvent(snapshot.events, now);
  const meetingLive = nextEvent ? eventIsLive(nextEvent, now) : false;
  const msUntilStart = nextEvent && !meetingLive ? nextEvent.startTs - now : Infinity;
  const soon = nextEvent ? !meetingLive && nextEvent.startTs - now < 15 * 60_000 : false;
  // In the final approach the countdown shows m:ss, so the shared clock has to
  // tick at 1s to match; back off once we pass it.
  useNowInterval(msUntilStart > 0 && msUntilStart < COUNTDOWN_SECONDS_THRESHOLD ? 1000 : undefined);
  const highlight = meetingLive || soon;
  const later = snapshot.events
    .filter((e) => e.startTs > now && e.id !== nextEvent?.id)
    .toSorted((a, b) => a.startTs - b.startTs);
  const hiddenLater = later.length - LATER_INLINE;

  // Re-enables on a newer collector run or a safety timeout, so it never sticks.
  const refreshedAt = dataRefreshedAt(snapshot.runs, now);
  const [refreshing, setRefreshing] = useState(false);
  const refreshBaseline = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!refreshing) return;
    const landed =
      refreshedAt !== undefined &&
      (refreshBaseline.current === undefined || refreshedAt > refreshBaseline.current);
    if (landed) {
      setRefreshing(false);
      return;
    }
    const t = setTimeout(() => setRefreshing(false), 30_000);
    return () => clearTimeout(t);
  }, [refreshing, refreshedAt]);

  async function refresh() {
    uiAction("cockpit.refresh", "cockpit");
    refreshBaseline.current = refreshedAt;
    setRefreshing(true);
    const started = await storeCollectNow();
    if (started.isErr() && !NotInTauri.is(started.error)) toast.error(started.error.message);
    // `false` = overlap, failure, or browser dev — nothing new to wait on.
    if (!started.unwrapOr(false)) setRefreshing(false);
  }

  const dismissedCount =
    snapshot.prs.filter(isItemDismissed).length + snapshot.issues.filter(isItemDismissed).length;
  const [clearing, setClearing] = useState(false);
  async function clearDismissals() {
    uiAction("cockpit.dismissals_clear", "cockpit");
    setClearing(true);
    const cleared = await storeDismissalsClear();
    if (cleared.isOk()) {
      const n = cleared.value;
      toast.success(n === 1 ? "1 item restored" : `${n} items restored`);
    } else if (!NotInTauri.is(cleared.error)) {
      toast.error(cleared.error.message);
    }
    setClearing(false);
  }

  return (
    <div className="flex shrink-0 items-center gap-x-5 border-b px-4 py-1.5 text-sm">
      <CalendarDotsIcon
        size={16}
        className={cn("shrink-0", highlight ? "text-amber-500" : "text-kumo-subtle")}
      />
      {nextEvent ? (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "font-mono font-semibold tabular-nums",
              highlight ? "text-amber-500" : "text-kumo-default",
            )}
          >
            {meetingLive ? "Now" : fmtCountdown(nextEvent.startTs - now)}
          </span>
          <span className="truncate font-medium">{nextEvent.title}</span>
          <span className="shrink-0 text-xs text-kumo-subtle">
            {meetingLive && nextEvent.endTs !== undefined
              ? `until ${fmtClock(nextEvent.endTs)}`
              : fmtClock(nextEvent.startTs)}
          </span>
          {nextEvent.joinUrl ? (
            <Button
              size="xs"
              variant={meetingLive ? "primary" : "secondary"}
              icon={<VideoCameraIcon />}
              onClick={() => {
                uiAction("cockpit.meeting_join", "cockpit");
                if (nextEvent.joinUrl) void openExternalUrl(nextEvent.joinUrl);
              }}
            >
              Join
            </Button>
          ) : null}
        </div>
      ) : (
        <span className="text-kumo-subtle">No more meetings today.</span>
      )}
      {later.length > 0 && (
        <div className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-kumo-subtle xl:flex">
          <span className="tracking-wide uppercase">Then</span>
          {later.slice(0, LATER_INLINE).map((e) => (
            <span key={e.id} className="rounded-md bg-kumo-recessed px-1.5 py-0.5">
              {e.title} · {fmtClock(e.startTs)}
            </span>
          ))}
          {hiddenLater > 0 && <span>+{hiddenLater}</span>}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1 text-xs text-kumo-subtle">
        {!live && (
          <span className="flex items-center gap-1 text-kumo-warning">
            <WarningCircleIcon size={14} /> Not connected to the store
          </span>
        )}
        {dismissedCount > 0 && (
          <Tooltip
            content="Bring back every dismissed PR and issue"
            render={
              <Button
                size="xs"
                variant="ghost"
                loading={clearing}
                icon={<EyeSlashIcon />}
                onClick={() => void clearDismissals()}
                aria-label="Clear all dismissals"
              >
                <span className="tabular-nums">{dismissedCount} dismissed</span>
              </Button>
            }
          />
        )}
        <Tooltip
          content="Refresh pull requests, CI and issues now"
          render={
            <Button
              size="xs"
              variant="ghost"
              loading={refreshing}
              icon={<ArrowClockwiseIcon />}
              onClick={() => void refresh()}
              aria-label="Refresh PRs, CI and issues"
            >
              <span className="tabular-nums">
                {refreshing
                  ? "Refreshing…"
                  : refreshedAt !== undefined
                    ? `Refreshed ${fmtAge(refreshedAt, now)}`
                    : "Refresh"}
              </span>
            </Button>
          }
        />
      </div>
    </div>
  );
}
