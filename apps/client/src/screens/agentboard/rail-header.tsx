import {
  Box,
  CalendarClock,
  CircleSlash,
  Eye,
  EyeOff,
  FolderGit2,
  FolderPlus,
  FolderX,
  GitPullRequest,
  History,
  PanelLeftClose,
} from "lucide-react";
import { DismissButton } from "@/components/store-bits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { RAIL_RECENT_HOUR_CHOICES } from "@/lib/rail-prefs";
import type { RailFilter } from "@/lib/settings";
import { mouseAction } from "@/lib/shortcut-coach";
import { uiAction } from "@/lib/ui-action";
import type { AttentionItem } from "./use-attention";

/** Icon + resting tooltip per rail filter. The icon *is* the readout — an
 * always-open menu would cost a rail row, so the trigger has to say which mode
 * is on without being opened. */
const FILTER_META: Record<RailFilter, { icon: typeof Eye; title: string }> = {
  all: { icon: Eye, title: "Showing every checkout" },
  active: {
    icon: EyeOff,
    title:
      "Showing only checkouts with something going on (a live session, a dirty tree, unpushed commits, an agent waiting)",
  },
  recent: { icon: History, title: "Showing only checkouts you worked in recently" },
};

/** The rail's filter. The middle two answers aren't degrees of one thing:
 * "going on" is about *now* (running, dirty, unpushed, waiting on you), while
 * "worked recently" is the last N hours — a checkout committed to an hour ago
 * is hidden by the first, kept by the second. A menu, not a cycling icon, so
 * the hour span sits with the mode it measures. */
function RailFilterMenu(props: {
  filter: RailFilter;
  recentHours: number;
  onSetFilter: (next: RailFilter) => void;
  onSetRecentHours: (next: number) => void;
}) {
  const { filter, recentHours, onSetFilter, onSetRecentHours } = props;
  const { icon: Icon, title } = FILTER_META[filter];
  return (
    <DropdownMenu>
      <Hint label={title}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Which checkouts to show"
            className={cn(
              "flex items-center gap-0.5 rounded-md p-1 hover:bg-accent/50",
              filter === "all"
                ? "text-muted-foreground hover:text-foreground"
                : "text-violet-500 hover:text-violet-400",
            )}
          >
            <Icon className="size-3.5" />
            {filter === "recent" && (
              <span className="font-mono text-[10px] leading-none">{recentHours}h</span>
            )}
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(next) => {
            uiAction("agentboard.rail_filter", "agentboard", next);
            onSetFilter(next as RailFilter);
          }}
        >
          <DropdownMenuRadioItem value="all">Everything</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="active">Only what&apos;s going on</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="recent">Worked recently</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {filter === "recent" && (
          // Deliberately not menu items: picking a span is a refinement of the
          // mode above it, so the menu stays open while you compare 4h to 8h.
          <div className="flex items-center gap-1 px-2 pb-1.5 pt-1">
            {RAIL_RECENT_HOUR_CHOICES.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={hours === recentHours}
                onClick={() => {
                  uiAction("agentboard.rail_recent_hours", "agentboard", String(hours));
                  onSetRecentHours(hours);
                }}
                className={cn(
                  "flex-1 rounded-md border py-0.5 font-mono text-[11px] hover:bg-accent/50",
                  hours === recentHours
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-500"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {hours}h
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The rail's fixed top: the "Repos" title row with its filter/cleanup
 * affordances, and the attention strip beneath it (failing/review PRs + the
 * next imminent meeting). Everything below this scrolls.
 */
export function RailHeader(props: {
  attention: AttentionItem[];
  missingRepoCount: number;
  dismissedPrCount: number;
  clearingDismissals: boolean;
  filter: RailFilter;
  recentHours: number;
  onSetFilter: (next: RailFilter) => void;
  onSetRecentHours: (next: number) => void;
  showUnmanagedWorktrees: boolean;
  onSetShowUnmanagedWorktrees: (next: boolean) => void;
  jarvisPane: boolean;
  onSetJarvisPane: (next: boolean) => void;
  onOpenRepoManager: () => void;
  onCleanupMissing: () => void;
  onClearDismissals: () => void;
  onCollapseRail: () => void;
}) {
  const {
    attention,
    missingRepoCount,
    dismissedPrCount,
    clearingDismissals,
    filter,
    recentHours,
    onSetFilter,
    onSetRecentHours,
    showUnmanagedWorktrees,
    onSetShowUnmanagedWorktrees,
    jarvisPane,
    onSetJarvisPane,
    onOpenRepoManager,
    onCleanupMissing,
    onClearDismissals,
    onCollapseRail,
  } = props;
  return (
    <>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Repos
        </span>
        <span className="flex items-center gap-0.5">
          <Hint label="Manage tracked repos in Settings — track, reorder, icon and color">
            <button
              type="button"
              onClick={onOpenRepoManager}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-violet-500 hover:bg-accent/50"
            >
              <FolderPlus className="size-3.5" /> Manage repos
            </button>
          </Hint>
          {missingRepoCount > 0 && (
            <Hint
              label={`Untrack ${missingRepoCount} repo${missingRepoCount === 1 ? "" : "s"} whose director${missingRepoCount === 1 ? "y is" : "ies are"} gone from disk`}
            >
              <button
                type="button"
                onClick={onCleanupMissing}
                aria-label={`Untrack ${missingRepoCount} missing repos`}
                className="rounded-md p-1 text-amber-500 hover:bg-accent/50 hover:text-amber-400"
              >
                <FolderX className="size-3.5" />
              </button>
            </Hint>
          )}
          <RailFilterMenu
            filter={filter}
            recentHours={recentHours}
            onSetFilter={onSetFilter}
            onSetRecentHours={onSetRecentHours}
          />
          <Hint
            label={
              showUnmanagedWorktrees
                ? "Showing every git worktree, including ones Claude Code made for its own agents — click to show only the tasks you asked for"
                : "Showing only the tasks you asked for — click to also show worktrees Claude Code made for its own agents, or ones added by hand"
            }
          >
            <button
              type="button"
              onClick={() => {
                uiAction(
                  "agentboard.show_unmanaged_worktrees",
                  "agentboard",
                  showUnmanagedWorktrees ? "off" : "on",
                );
                onSetShowUnmanagedWorktrees(!showUnmanagedWorktrees);
              }}
              aria-label={
                showUnmanagedWorktrees
                  ? "Show only worktrees you asked for"
                  : "Show every git worktree, including ones you didn't ask for"
              }
              aria-pressed={showUnmanagedWorktrees}
              className={cn(
                "rounded-md p-1 hover:bg-accent/50",
                showUnmanagedWorktrees
                  ? "text-violet-500 hover:text-violet-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderGit2 className="size-3.5" />
            </button>
          </Hint>
          {/* Jarvis, the native Bevy surface: this toggles both the strip at
              the bottom of the rail and whether a checkout can tile one as a
              *pane* (`components/jarvis-pane.tsx`) — one switch for the whole
              proof-of-concept. Left off, no surface is ever created and no
              renderer runs; turned off after the fact, the surfaces are parked
              rather than freed, because a Bevy app can't be dropped in-process
              (`crates-tauri/tt-pane`). */}
          <Hint
            label={
              jarvisPane
                ? "Jarvis (native Bevy surface) is on — rail strip plus a “jarvis” button on each checkout that tiles one as a pane. Click to turn it off"
                : "Turn on Jarvis, the native Bevy surface: a rail strip, and a “jarvis” pane you can tile beside a checkout's terminals (proof-of-concept; Linux/Wayland only)"
            }
          >
            <button
              type="button"
              onClick={() => {
                uiAction("agentboard.jarvis_pane", "agentboard", jarvisPane ? "off" : "on");
                onSetJarvisPane(!jarvisPane);
              }}
              aria-label={jarvisPane ? "Hide the Jarvis pane" : "Show the Jarvis pane"}
              aria-pressed={jarvisPane}
              className={cn(
                "rounded-md p-1 hover:bg-accent/50",
                jarvisPane
                  ? "text-violet-500 hover:text-violet-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Box className="size-3.5" />
            </button>
          </Hint>
          {dismissedPrCount > 0 && (
            <Hint
              label={`Bring back ${dismissedPrCount} dismissed PR${dismissedPrCount === 1 ? "" : "s"}`}
            >
              <button
                type="button"
                onClick={onClearDismissals}
                disabled={clearingDismissals}
                aria-label="Clear all dismissed PRs"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              >
                <CircleSlash className="size-3.5" />
              </button>
            </Hint>
          )}
          <Hint label="Collapse the rail to icons" shortcut="ab-toggle-rail">
            <button
              type="button"
              onClick={() => {
                mouseAction("ab-toggle-rail", "agentboard");
                onCollapseRail();
              }}
              aria-label="Collapse the rail to icons"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <PanelLeftClose className="size-3.5" />
            </button>
          </Hint>
        </span>
      </div>

      {attention.length > 0 && (
        <div className="flex flex-col gap-1 border-b p-2">
          {attention.map((a) => (
            <div
              key={a.key}
              className={cn(
                "group flex items-center gap-1 rounded-md border border-l-2 pr-1 hover:bg-accent/50",
                a.border,
              )}
            >
              <button
                type="button"
                onClick={a.onClick}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                {a.kind === "pr" ? (
                  <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{a.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{a.sub}</span>
                </span>
              </button>
              {a.onDismiss && <DismissButton label="Dismiss" onDismiss={a.onDismiss} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
